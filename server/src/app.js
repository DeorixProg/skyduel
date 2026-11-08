import { mkdirSync } from "node:fs";
import http from "node:http";
import { createHttpHandler } from "./http.js";
import { startMatchLog } from "./log/matchlog.js";
import { errFields } from "./logger.js";
import { RoomManager } from "./rooms.js";
import { attachWebSocket } from "./ws.js";

export const DEFAULT_ROOMS = [
  { id: "somme", name: "Над Соммою", arena: "/assets/arenas/somme.json", maxPlayers: 4 },
  { id: "verdun", name: "Захід над Верденом", arena: "/assets/arenas/verdun.json", maxPlayers: 4 },
  { id: "night", name: "Нічний патруль", arena: "/assets/arenas/night.json", maxPlayers: 6 },
];

/** Build the whole server without starting it (tests start it on port 0). */
export function createApp({ config, logger }) {
  const stats = {
    connections: 0,
    players: 0,
    httpRequests: 0,
    messagesIn: 0,
    messagesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    droppedMessages: 0,
    closedSlow: 0,
    rejectedPaths: 0,
    rejected: {},
  };
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
  });
  const logs = new Set();

  mkdirSync(config.logDir, { recursive: true });
  rooms.on("created", (room) => {
    try {
      const log = startMatchLog(room, config.logDir);
      logs.add(log.done);
      log.done
        .catch((err) => logger.error({ room: room.id, ...errFields(err) }, "match log failed"))
        .finally(() => logs.delete(log.done));
    } catch (err) {
      logger.error({ room: room.id, ...errFields(err) }, "cannot open match log");
    }
  });
  rooms.on("room-error", (room, err) =>
    logger.error({ room: room.id, ...errFields(err) }, "room error"),
  );
  rooms.on("deleted", (room) => logger.info({ room: room.id }, "room deleted"));

  const httpServer = http.createServer(createHttpHandler({ config, rooms, logger, stats }));
  const ws = attachWebSocket({ httpServer, config, rooms, logger, stats });
  for (const r of DEFAULT_ROOMS) rooms.create({ ...r, persistent: true });

  let closing = null;
  return {
    httpServer,
    rooms,
    stats,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve) =>
        httpServer.listen(port, host, () => resolve(httpServer.address())),
      );
    },
    /** Graceful: stop accepting → shutdown msg + 1001 → close rooms → flush logs. */
    close() {
      closing ??= (async () => {
        httpServer.close();
        await ws.close();
        rooms.closeAll();
        await Promise.allSettled([...logs]);
        httpServer.closeAllConnections?.();
      })();
      return closing;
    },
  };
}
