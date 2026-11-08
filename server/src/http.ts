import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { Bot } from "@skyduel/shared/bot.ts";
import { playerId } from "@skyduel/shared/types.ts";
import { z } from "zod";
import type { ServerConfig } from "./config.ts";
import { listReplays, replayPath } from "./log/replay.ts";
import { errFields, type Logger } from "./logger.ts";
import type { RoomManager } from "./rooms.ts";
import type { Stats } from "./stats.ts";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".ndjson": "application/x-ndjson",
};

const MAX_BODY = 2048;
const ARENAS = [
  "/assets/arenas/somme.json",
  "/assets/arenas/verdun.json",
  "/assets/arenas/night.json",
] as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Read a small request body with a hard cap; rejects instead of buffering 1 GB. */
async function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) continue;
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `body larger than ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24) || "room";

export function createHttpHandler({
  config,
  rooms,
  logger,
  stats,
}: {
  config: ServerConfig;
  rooms: RoomManager;
  logger: Logger;
  stats: Stats;
}) {
  const staticRoot = path.resolve(config.staticDir);
  const CreateRoom = z.object({
    name: z.string().trim().min(1).max(32),
    maxPlayers: z
      .number()
      .int()
      .min(2)
      .max(config.maxPlayersPerRoom)
      .default(config.maxPlayersPerRoom),
    arena: z.enum(ARENAS).default("/assets/arenas/somme.json"),
  });

  // event-loop utilisation over the window since the previous /api/stats call
  let lastElu = performance.eventLoopUtilization();
  const AddBots = z.object({ count: z.number().int().min(1).max(64).default(1) });
  let nextBotId = 1_000_000; // bot player ids never collide with socket ids

  async function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    rawPath: string,
  ): Promise<void> {
    // 1) refuse traversal before ANY path joining: "..", encoded or not, and NUL bytes
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      return sendJson(res, 400, { error: "bad path encoding" });
    }
    if (decoded.includes("\0") || decoded.split(/[\\/]/).includes("..")) {
      stats.rejectedPaths++;
      logger.warn({ path: rawPath }, "path traversal attempt rejected");
      return sendJson(res, 400, { error: "invalid path" });
    }
    // 2) belt and braces: the resolved file must still be inside the root
    let file = path.resolve(staticRoot, `.${decoded}`);
    if (file !== staticRoot && !file.startsWith(staticRoot + path.sep)) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = path.join(file, "index.html");
      info = await stat(file).catch(() => null);
    }
    if (!info) {
      // SPA fallback for page routes; real 404 for missing assets
      if (path.extname(decoded)) return sendJson(res, 404, { error: "not found" });
      file = path.join(staticRoot, "index.html");
      info = await stat(file).catch(() => null);
      if (!info) return sendJson(res, 404, { error: "client not built: run npm run build" });
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control":
        decoded.startsWith("/assets/") && ext !== ".json" ? "public, max-age=3600" : "no-cache",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    await pipeline(createReadStream(file), res);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? "/";
    const url = new URL(rawUrl, "http://localhost");
    const rawPath = rawUrl.split("?")[0] ?? "/";
    stats.httpRequests++;
    try {
      if (url.pathname === "/health") {
        return sendJson(res, 200, {
          status: "ok",
          uptime: Math.round(process.uptime()),
          rooms: rooms.size,
          players: stats.players,
          rss: process.memoryUsage().rss,
        });
      }
      if (url.pathname === "/api/stats") {
        const now = performance.eventLoopUtilization();
        const elu = performance.eventLoopUtilization(now, lastElu);
        lastElu = now;
        const matches = [...rooms].flatMap((r) =>
          r.match?.players.size ? [{ room: r.id, ...r.match.stats() }] : [],
        );
        return sendJson(res, 200, {
          ...stats,
          matches,
          memory: process.memoryUsage(),
          elu: elu.utilization,
        });
      }
      if (url.pathname === "/api/rooms" && req.method === "GET") {
        return sendJson(res, 200, { rooms: rooms.list() });
      }
      if (url.pathname === "/api/rooms" && req.method === "POST") {
        let json: unknown;
        try {
          json = JSON.parse(await readBody(req));
        } catch (err: unknown) {
          if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
          return sendJson(res, 400, { error: "invalid JSON" });
        }
        const body = CreateRoom.safeParse(json);
        if (!body.success) {
          const issue = body.error.issues[0];
          return sendJson(res, 400, {
            error: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid body",
          });
        }
        const { name, maxPlayers, arena } = body.data;
        let id = slug(name);
        for (let i = 2; rooms.get(id); i++) id = `${slug(name)}-${i}`;
        try {
          return sendJson(res, 201, rooms.create({ id, name, maxPlayers, arena }).toJSON());
        } catch (err: unknown) {
          return sendJson(res, 409, {
            error: err instanceof Error ? err.message : "cannot create room",
          });
        }
      }
      if (url.pathname === "/api/replays") {
        return sendJson(res, 200, { replays: await listReplays(config.logDir) });
      }
      const m = url.pathname.match(/^\/api\/replays\/([^/]+)$/);
      if (m?.[1]) {
        const file = replayPath(config.logDir, m[1]);
        const info = file ? await stat(file).catch(() => null) : null;
        if (!file || !info) return sendJson(res, 404, { error: "no such replay" });
        res.writeHead(200, { "content-type": "application/x-ndjson", "content-length": info.size });
        if (url.searchParams.get("mode") === "buffer") {
          // ANTI-PATTERN kept only for the backpressure comparison in the README:
          // the whole file is loaded into memory before the first byte is sent.
          res.end(await readFile(file));
          return;
        }
        // streamed: pipeline respects backpressure — the file is read only as fast
        // as the client drains the socket, so memory stays flat.
        await pipeline(createReadStream(file), res);
        return;
      }
      const botsRoute = url.pathname.match(/^\/api\/rooms\/([\w-]+)\/bots$/);
      if (botsRoute?.[1] && req.method === "POST") {
        const room = rooms.get(botsRoute[1]);
        if (!room?.match) return sendJson(res, 404, { error: "no such room" });
        let json: unknown = {};
        try {
          const text = await readBody(req);
          if (text) json = JSON.parse(text);
        } catch {
          return sendJson(res, 400, { error: "invalid JSON" });
        }
        const body = AddBots.safeParse(json);
        if (!body.success) return sendJson(res, 400, { error: "count: 1..64" });
        const added: string[] = [];
        for (let i = 0; i < body.data.count && !room.full; i++) {
          const id = playerId(nextBotId++);
          const name = `Bot-${id % 1000}`;
          const ship = room.match.addPlayer(id, name, new Bot({ phase: id * 17 }));
          room.join({ id, name, ws: null, shipId: ship.id, color: ship.color });
          added.push(name);
        }
        return sendJson(res, 201, { added, players: room.players.size });
      }
      if (url.pathname === "/api/slow" && config.enableSlowEndpoint) {
        // Lab 4 demo: block the event loop for 300 ms. Nothing else runs meanwhile.
        const t = performance.now();
        while (performance.now() - t < 300) {
          // busy
        }
        return sendJson(res, 200, { blockedMs: 300 });
      }
      if (url.pathname.startsWith("/api/"))
        return sendJson(res, 404, { error: "no such endpoint" });
      if (req.method !== "GET" && req.method !== "HEAD")
        return sendJson(res, 405, { error: "method not allowed" });
      return await serveStatic(req, res, rawPath);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && err.code === "ERR_STREAM_PREMATURE_CLOSE")
        return; // client went away
      logger.error({ ...errFields(err), url: rawUrl }, "request failed");
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    }
  };
}
