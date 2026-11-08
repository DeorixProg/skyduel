import { WebSocketServer } from "ws";
import { errFields } from "./logger.js";
import { CLOSE, PROTOCOL_VERSION, parseMessage } from "./protocol.js";
import { createTokenBucket } from "./ratelimit.js";

/**
 * WebSocket lifecycle: handshake on /ws → must send "join" within
 * JOIN_TIMEOUT_MS → validated messages only → heartbeat ping every
 * HEARTBEAT_MS, two missed pongs = terminate → leave the room on close.
 */
export function attachWebSocket({ httpServer, config, rooms, logger, stats }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayload });
  let nextPlayerId = 1;

  httpServer.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy()); // raw socket errors before the upgrade completes
    if (new URL(req.url, "http://localhost").pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  /** Send with the slow-client policy. Critical messages are never dropped. */
  function send(ws, msg, { critical = false } = {}) {
    if (ws.readyState !== ws.OPEN) return;
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
    const text = JSON.stringify(msg);
    stats.bytesOut += text.length;
    stats.messagesOut++;
    ws.send(text);
  }

  /** Wire a room's events to its sockets (called once per room). */
  function wireRoom(room) {
    const broadcast = (msg, opts) => {
      for (const p of room.players.values()) send(p.ws, msg, opts);
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

  wss.on("connection", (ws, req) => {
    stats.connections++;
    const ip = req.socket.remoteAddress;
    const state = {
      id: nextPlayerId++,
      room: null,
      missedPongs: 0,
      bucket: createTokenBucket({ rate: config.msgRate, burst: config.msgBurst }),
    };
    ws.state = state;
    const log = logger.child({ conn: state.id, ip });
    log.info({}, "connected");

    const close = (code, reason) => {
      stats.rejected[code] = (stats.rejected[code] ?? 0) + 1;
      log.warn({ code, reason }, "closing connection");
      ws.close(code, reason.slice(0, 120));
    };

    // An "error" on a socket with no listener would crash the process.
    ws.on("error", (err) => log.warn(errFields(err), "socket error"));

    const joinTimer = setTimeout(() => {
      if (!state.room) close(CLOSE.JOIN_TIMEOUT, "join timeout");
    }, config.joinTimeoutMs);

    ws.on("pong", () => {
      state.missedPongs = 0;
    });

    ws.on("message", (data, isBinary) => {
      stats.messagesIn++;
      stats.bytesIn += data.length;
      if (!state.bucket.take()) return close(CLOSE.RATE_LIMIT, "rate limit exceeded");
      const parsed = parseMessage(data, isBinary);
      if (!parsed.ok) return close(parsed.code, parsed.reason);
      const msg = parsed.msg;
      switch (msg.type) {
        case "join": {
          if (state.room) return close(CLOSE.ALREADY_JOINED, "already in a room");
          const room = rooms.get(msg.room);
          if (!room) return close(CLOSE.NO_SUCH_ROOM, `no room ${msg.room}`);
          if (room.full) return close(CLOSE.ROOM_FULL, "room is full");
          clearTimeout(joinTimer);
          state.room = room;
          send(
            ws,
            { type: "welcome", v: PROTOCOL_VERSION, playerId: state.id, room: room.toJSON() },
            { critical: true },
          );
          room.join({ id: state.id, name: msg.name.trim(), ws });
          stats.players++;
          log.info({ room: room.id, player: state.id }, "joined");
          return;
        }
        case "chat":
          if (!state.room) return close(CLOSE.BAD_SHAPE, "chat before join");
          state.room.chat(state.id, msg.text.trim());
          return;
        case "leave":
          ws.close(1000, "bye");
          return;
        case "ping":
          send(ws, { type: "pong", t: msg.t }, { critical: true });
          return;
      }
    });

    ws.on("close", (code) => {
      clearTimeout(joinTimer);
      if (state.room) {
        stats.players--;
        state.room.leave(state.id, code === 1000 || code === 1001 ? "left" : `closed ${code}`);
        state.room = null;
      }
      log.info({ code }, "disconnected");
    });
  });

  // Heartbeat: ping everyone; two consecutive missed pongs → terminate (no close handshake).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.state.missedPongs >= 2) {
        stats.rejected[CLOSE.HEARTBEAT] = (stats.rejected[CLOSE.HEARTBEAT] ?? 0) + 1;
        ws.terminate();
        continue;
      }
      ws.state.missedPongs++;
      ws.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  return {
    wss,
    /** Tell every client we are going away, then close with 1001. */
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) {
        send(ws, { type: "shutdown" }, { critical: true });
        ws.close(CLOSE.GOING_AWAY, "server shutting down");
      }
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
