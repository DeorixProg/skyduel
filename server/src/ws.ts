import type { IncomingMessage, Server } from "node:http";
import { binaryCodec } from "@skyduel/shared/codec/binary.ts";
import type { Frame } from "@skyduel/shared/codec/codec.ts";
import { jsonCodec } from "@skyduel/shared/codec/json.ts";
import { TICK_RATE } from "@skyduel/shared/net/predict.ts";
import {
  CLOSE,
  type ClientMessage,
  type CloseCode,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
} from "@skyduel/shared/protocol.ts";
import { assertNever, type Input, type PlayerId, playerId } from "@skyduel/shared/types.ts";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { loadArena } from "./arenas.ts";
import type { ServerConfig } from "./config.ts";
import { errFields, errMessage, type Logger } from "./logger.ts";
import { Match } from "./match.ts";
import type { Metrics } from "./metrics.ts";
import { createLink, type Link, parseNetSim } from "./netsim.ts";
import { createTokenBucket, type TokenBucket } from "./ratelimit.ts";
import type { Room, RoomManager } from "./rooms.ts";
import type { Stats } from "./stats.ts";

/** Per-connection state. Kept in a Map keyed by socket instead of monkey-patching `ws.state`. */
interface Conn {
  readonly id: PlayerId;
  room: Room | null;
  codec: "binary" | "json";
  bytesOut: number;
  missedPongs: number;
  readonly bucket: TokenBucket;
  readonly link: Link;
}

type ControlMessage = Exclude<ClientMessage, { type: "input" }>;

/**
 * WebSocket lifecycle: handshake on /ws → must send "join" within
 * JOIN_TIMEOUT_MS → validated messages only → heartbeat ping every
 * HEARTBEAT_MS, two missed pongs = terminate → leave the room on close.
 */
export function attachWebSocket({
  httpServer,
  config,
  rooms,
  logger,
  stats,
  metrics,
}: {
  httpServer: Server;
  config: ServerConfig;
  rooms: RoomManager;
  logger: Logger;
  stats: Stats;
  metrics: Metrics;
}) {
  const reasonOf = new Map<number, string>(
    Object.entries(CLOSE).map(([name, code]) => [code, name.toLowerCase()]),
  );
  const reject = (code: number) => {
    stats.rejected[code] = (stats.rejected[code] ?? 0) + 1;
    metrics.reject(reasonOf.get(code) ?? `code_${code}`);
  };
  const perIp = new Map<string, number>();
  const refuse = (
    socket: { write(s: string): unknown; destroy(): unknown },
    status: string,
    reason: string,
  ) => {
    metrics.reject(reason);
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayload });
  const conns = new Map<WebSocket, Conn>();
  let nextPlayerId = 1;

  httpServer.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy()); // raw socket errors before the upgrade completes
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Origin check: a browser page on another site must not be able to open a socket in the
    // player's name (cross-site WebSocket hijacking). Non-browser clients send no Origin.
    const origin = req.headers.origin;
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
      logger.warn({ origin }, "websocket origin rejected");
      return refuse(socket, "403 Forbidden", "bad_origin");
    }
    const ip = req.socket.remoteAddress ?? "?";
    if ((perIp.get(ip) ?? 0) >= config.maxConnectionsPerIp)
      return refuse(socket, "429 Too Many Requests", "per_ip_cap");
    if (conns.size >= config.maxConnections)
      return refuse(socket, "503 Service Unavailable", "server_full");
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    socket.once("close", () => {
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    });
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  /** Send a JSON control message — typed: only valid ServerMessages compile. */
  function send(ws: WebSocket, msg: ServerMessage, opts: { critical?: boolean } = {}): void {
    sendFrame(ws, JSON.stringify(msg), opts);
  }

  /**
   * Send one frame (string → text, ArrayBuffer → binary) with the slow-client
   * policy. Critical messages are never dropped; droppable ones may be lost
   * by the latency injector.
   */
  function sendFrame(
    ws: WebSocket,
    data: Frame,
    { critical = false, droppable = false } = {},
  ): void {
    const conn = conns.get(ws);
    if (!conn || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > config.slowClientBytes) {
      if (ws.bufferedAmount > config.slowClientBytes * 4) {
        stats.closedSlow++;
        ws.close(CLOSE.SLOW_CLIENT, "client too slow");
        return;
      }
      if (!critical) {
        stats.droppedMessages++;
        return;
      }
    }
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    conn.link.deliver(
      () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        stats.bytesOut += size;
        stats.messagesOut++;
        conn.bytesOut += size;
        ws.send(data);
      },
      { droppable },
    );
  }

  /** Wire a room's events to its sockets and give it a Match (called once per room). */
  function wireRoom(room: Room): void {
    const arena = loadArena(room.arena, config.staticDir);
    const match = new Match({
      arena,
      collision: config.collision,
      seed: (Math.random() * 0x100000000) >>> 0, // the server picks the seed; the sim never calls Math.random
      onSnapshot(snap, players) {
        let jsonText: string | null = null;
        for (const [id, p] of players) {
          const ws = room.players.get(id)?.ws ?? undefined;
          const conn = ws && conns.get(ws);
          if (!ws || !conn) continue;
          let frame: Frame;
          if (conn.codec === "json") {
            // ack differs per client; the rest of the text is shared
            jsonText ??= String(jsonCodec.encodeSnapshot(snap, p.ack));
            frame = jsonText.replace(/"ack":\d+/, `"ack":${p.ack}`);
          } else {
            frame = binaryCodec.encodeSnapshot(snap, p.ack);
          }
          sendFrame(ws, frame, { droppable: true });
        }
      },
    });
    room.match = match;
    room.on("close", () => match.stop());
    const broadcast = (msg: ServerMessage, opts?: { critical?: boolean }) => {
      for (const p of room.players.values()) if (p.ws) send(p.ws, msg, opts);
    };
    room.on("join", () =>
      broadcast({ type: "roster", players: room.roster() }, { critical: true }),
    );
    room.on("leave", () =>
      broadcast({ type: "roster", players: room.roster() }, { critical: true }),
    );
    room.on("chat", (p, text) =>
      broadcast({ type: "chat", from: p.id, name: p.name, text, t: Date.now() }),
    );
  }
  rooms.on("created", wireRoom);

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    stats.connections++;
    const conn: Conn = {
      id: playerId(nextPlayerId++),
      room: null,
      codec: "binary",
      bytesOut: 0,
      missedPongs: 0,
      bucket: createTokenBucket({ rate: config.msgRate, burst: config.msgBurst }),
      link: createLink(parseNetSim(req.url ?? "/")),
    };
    conns.set(ws, conn);
    let log = logger.child({ playerId: conn.id, ip: req.socket.remoteAddress });
    log.info({}, "connected");

    const close = (code: CloseCode, reason: string) => {
      reject(code);
      log.warn({ code, reason }, "closing connection");
      ws.close(code, reason.slice(0, 120));
    };

    // An "error" on a socket with no listener would crash the process.
    ws.on("error", (err) => log.warn(errFields(err), "socket error"));

    const joinTimer = setTimeout(() => {
      if (!conn.room) close(CLOSE.JOIN_TIMEOUT, "join timeout");
    }, config.joinTimeoutMs);

    ws.on("pong", () => {
      conn.missedPongs = 0;
    });

    const applyInputs = (inputs: readonly Input[]) =>
      conn.link.deliver(() => conn.room?.match?.onInputs(conn.id, inputs), { droppable: true });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      stats.messagesIn++;
      const bytes = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data.byteLength;
      stats.bytesIn += bytes;
      if (!conn.bucket.take()) {
        close(CLOSE.RATE_LIMIT, "rate limit exceeded");
        return;
      }
      const frame = Array.isArray(data) ? Buffer.concat(data) : data;
      if (isBinary) {
        if (!conn.room) {
          close(CLOSE.BAD_SHAPE, "input before join");
          return;
        }
        try {
          applyInputs(binaryCodec.decodeInputs(frame));
        } catch (err: unknown) {
          close(CLOSE.BAD_SHAPE, `bad binary frame: ${errMessage(err)}`);
        }
        return;
      }
      const parsed = parseClientMessage(frame);
      if (!parsed.ok) {
        close(parsed.error.code, parsed.error.reason);
        return;
      }
      const msg = parsed.value;
      if (msg.type === "input") {
        if (!conn.room) {
          close(CLOSE.BAD_SHAPE, "input before join");
          return;
        }
        applyInputs(msg.inputs);
        return;
      }
      // control messages also pass through the injected latency, so RTT is honest
      conn.link.deliver(() => handleControl(msg));
    });

    function handleControl(msg: ControlMessage): void {
      if (ws.readyState !== WebSocket.OPEN) return;
      switch (msg.type) {
        case "join": {
          if (conn.room) {
            close(CLOSE.ALREADY_JOINED, "already in a room");
            return;
          }
          const room = rooms.get(msg.room);
          if (!room?.match) {
            close(CLOSE.NO_SUCH_ROOM, `no room ${msg.room}`);
            return;
          }
          if (room.full) {
            close(CLOSE.ROOM_FULL, "room is full");
            return;
          }
          clearTimeout(joinTimer);
          conn.room = room;
          log = log.child({ roomId: room.id }); // every later line of this player names the room
          conn.codec = msg.codec;
          const ship = room.match.addPlayer(conn.id, msg.name);
          send(
            ws,
            {
              type: "welcome",
              v: PROTOCOL_VERSION,
              playerId: conn.id,
              shipId: ship.id,
              seed: room.match.seed,
              tickRate: TICK_RATE,
              codec: conn.codec,
              netsim: conn.link.settings,
              room: room.toJSON(),
            },
            { critical: true },
          );
          room.join({ id: conn.id, name: msg.name, ws, shipId: ship.id, color: ship.color });
          stats.players++;
          log.info({ roomId: room.id, codec: conn.codec, ...conn.link.settings }, "joined");
          return;
        }
        case "chat":
          if (!conn.room) {
            close(CLOSE.BAD_SHAPE, "chat before join");
            return;
          }
          conn.room.chat(conn.id, msg.text);
          return;
        case "leave":
          ws.close(CLOSE.NORMAL, "bye");
          return;
        case "ping":
          send(ws, { type: "pong", t: msg.t }, { critical: true });
          return;
        default:
          // a new client message type without a branch here is a tsc error
          assertNever(msg, "client message");
      }
    }

    ws.on("close", (code: number) => {
      clearTimeout(joinTimer);
      stats.disconnections++;
      if (code === CLOSE.TOO_BIG) reject(code); // closed by ws itself (maxPayload)
      if (conn.room) {
        stats.players--;
        conn.room.match?.removePlayer(conn.id);
        conn.room.leave(conn.id, code === 1000 || code === 1001 ? "left" : `closed ${code}`);
        conn.room = null;
      }
      conns.delete(ws);
      log.info({ code }, "disconnected");
    });
  });

  // Heartbeat: ping everyone; two consecutive missed pongs → terminate (no close handshake).
  const heartbeat = setInterval(() => {
    for (const [ws, conn] of conns) {
      if (conn.missedPongs >= 2) {
        reject(CLOSE.HEARTBEAT);
        ws.terminate();
        continue;
      }
      conn.missedPongs++;
      ws.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  return {
    wss,
    connections: () => conns.size,
    /** Tell every client we are going away, then close with 1001. */
    close(): Promise<void> {
      clearInterval(heartbeat);
      for (const ws of conns.keys()) {
        send(ws, { type: "shutdown" }, { critical: true });
        ws.close(CLOSE.GOING_AWAY, "server shutting down");
      }
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
