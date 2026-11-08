import * as binary from "@skyduel/shared/codec/binary.js";
import * as json from "@skyduel/shared/codec/json.js";
import { TICK_RATE } from "@skyduel/shared/net/predict.js";
import { CLOSE, PROTOCOL_VERSION, parseMessage } from "@skyduel/shared/protocol.js";
import { WebSocketServer } from "ws";
import { loadArena } from "./arenas.js";
import { errFields } from "./logger.js";
import { Match } from "./match.js";
import { createLink, parseNetSim } from "./netsim.js";
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

  /** Send a JSON control message (through the latency injector). */
  function send(ws, msg, opts = {}) {
    sendFrame(ws, JSON.stringify(msg), opts);
  }

  /**
   * Send one frame (string → text, ArrayBuffer → binary) with the slow-client
   * policy. Critical messages are never dropped; droppable ones may be lost
   * by the latency injector.
   */
  function sendFrame(ws, data, { critical = false, droppable = false } = {}) {
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
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    ws.state.link.deliver(
      () => {
        if (ws.readyState !== ws.OPEN) return;
        stats.bytesOut += size;
        stats.messagesOut++;
        ws.state.bytesOut += size;
        ws.send(data);
      },
      { droppable },
    );
  }

  /** Wire a room's events to its sockets and give it a Match (called once per room). */
  function wireRoom(room) {
    const arena = loadArena(room.arena, config.staticDir);
    room.match = new Match({
      arena,
      seed: (Math.random() * 0x100000000) >>> 0, // the server picks the seed; the sim never calls Math.random
      onSnapshot(snap, players) {
        let jsonText = null;
        for (const [playerId, p] of players) {
          const ws = room.players.get(playerId)?.ws;
          if (!ws) continue;
          let frame;
          if (ws.state.codec === "json") {
            // ack differs per client; the rest of the text is shared
            jsonText ??= json.encodeSnapshot(snap, 0);
            frame = jsonText.replace('"ack":0', `"ack":${p.ack}`);
          } else {
            frame = binary.encodeSnapshot(snap, p.ack);
          }
          sendFrame(ws, frame, { droppable: true });
        }
      },
    });
    room.on("close", () => room.match.stop());
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
      codec: "binary",
      bytesOut: 0,
      missedPongs: 0,
      bucket: createTokenBucket({ rate: config.msgRate, burst: config.msgBurst }),
      link: createLink(parseNetSim(req.url)),
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
      if (isBinary) {
        if (!state.room) return close(CLOSE.BAD_SHAPE, "input before join");
        let decoded;
        try {
          decoded = binary.decodeInputs(data);
        } catch (err) {
          return close(CLOSE.BAD_SHAPE, `bad binary frame: ${err.message}`);
        }
        state.link.deliver(() => state.room?.match.onInputs(state.id, decoded.inputs), {
          droppable: true,
        });
        return;
      }
      const parsed = parseMessage(data);
      if (!parsed.ok) return close(parsed.code, parsed.reason);
      const msg = parsed.msg;
      if (msg.type === "input") {
        if (!state.room) return close(CLOSE.BAD_SHAPE, "input before join");
        state.link.deliver(() => state.room?.match.onInputs(state.id, msg.inputs), {
          droppable: true,
        });
        return;
      }
      // control messages also pass through the injected latency, so RTT is honest
      state.link.deliver(() => handleControl(msg));
    });

    function handleControl(msg) {
      if (ws.readyState !== ws.OPEN) return;
      switch (msg.type) {
        case "join": {
          if (state.room) return close(CLOSE.ALREADY_JOINED, "already in a room");
          const room = rooms.get(msg.room);
          if (!room) return close(CLOSE.NO_SUCH_ROOM, `no room ${msg.room}`);
          if (room.full) return close(CLOSE.ROOM_FULL, "room is full");
          clearTimeout(joinTimer);
          state.room = room;
          state.codec = msg.codec ?? "binary";
          const name = msg.name.trim();
          const ship = room.match.addPlayer(state.id, name);
          send(
            ws,
            {
              type: "welcome",
              v: PROTOCOL_VERSION,
              playerId: state.id,
              shipId: ship.id,
              seed: room.match.seed,
              tickRate: TICK_RATE,
              codec: state.codec,
              netsim: state.link.settings,
              room: room.toJSON(),
            },
            { critical: true },
          );
          room.join({ id: state.id, name, ws, shipId: ship.id, color: ship.color });
          stats.players++;
          log.info(
            { room: room.id, player: state.id, codec: state.codec, ...state.link.settings },
            "joined",
          );
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
    }

    ws.on("close", (code) => {
      clearTimeout(joinTimer);
      if (state.room) {
        stats.players--;
        state.room.match.removePlayer(state.id);
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
