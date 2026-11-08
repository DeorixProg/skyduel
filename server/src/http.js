import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { listReplays, replayPath } from "./log/replay.js";

const MIME = {
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

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

/** Read a small request body with a hard cap; rejects instead of buffering 1 GB. */
async function readBody(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new RangeError(`body larger than ${limit} bytes`);
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24) || "room";

export function createHttpHandler({ config, rooms, logger, stats }) {
  const staticRoot = path.resolve(config.staticDir);

  async function serveStatic(req, res, rawPath) {
    // 1) refuse traversal before ANY path joining: "..", encoded or not, and NUL bytes
    let decoded;
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
    if (req.method === "HEAD") return res.end();
    await pipeline(createReadStream(file), res);
  }

  return async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const rawPath = req.url.split("?")[0];
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
        const elu = performance.eventLoopUtilization();
        return sendJson(res, 200, {
          ...stats,
          memory: process.memoryUsage(),
          elu: elu.utilization,
        });
      }
      if (url.pathname === "/api/rooms" && req.method === "GET") {
        return sendJson(res, 200, { rooms: rooms.list() });
      }
      if (url.pathname === "/api/rooms" && req.method === "POST") {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err) {
          return sendJson(res, err.status ?? 400, {
            error: err.status ? err.message : "invalid JSON",
          });
        }
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        const maxPlayers = body?.maxPlayers ?? config.maxPlayersPerRoom;
        if (name.length < 1 || name.length > 32)
          return sendJson(res, 400, { error: "name: 1..32 chars" });
        if (
          !Number.isInteger(maxPlayers) ||
          maxPlayers < 2 ||
          maxPlayers > config.maxPlayersPerRoom
        ) {
          return sendJson(res, 400, { error: `maxPlayers: 2..${config.maxPlayersPerRoom}` });
        }
        const arena = [
          "/assets/arenas/somme.json",
          "/assets/arenas/verdun.json",
          "/assets/arenas/night.json",
        ].includes(body.arena)
          ? body.arena
          : "/assets/arenas/somme.json";
        let id = slug(name);
        for (let i = 2; rooms.get(id); i++) id = `${slug(name)}-${i}`;
        try {
          const room = rooms.create({ id, name, maxPlayers, arena });
          return sendJson(res, 201, room.toJSON());
        } catch (err) {
          return sendJson(res, 409, { error: err.message });
        }
      }
      if (url.pathname === "/api/replays") {
        return sendJson(res, 200, { replays: await listReplays(config.logDir) });
      }
      const m = url.pathname.match(/^\/api\/replays\/([^/]+)$/);
      if (m) {
        const file = replayPath(config.logDir, m[1]);
        const info = file && (await stat(file).catch(() => null));
        if (!info) return sendJson(res, 404, { error: "no such replay" });
        res.writeHead(200, { "content-type": MIME[".ndjson"], "content-length": info.size });
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
    } catch (err) {
      if (err.code === "ERR_STREAM_PREMATURE_CLOSE") return; // client went away mid-download
      logger.error(
        { err: { message: err.message, stack: err.stack }, url: req.url },
        "request failed",
      );
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    }
  };
}
