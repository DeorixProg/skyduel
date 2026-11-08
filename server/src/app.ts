import { mkdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerConfig } from "./config.ts";
import { createHttpHandler } from "./http.ts";
import { startMatchLog } from "./log/matchlog.ts";
import { errFields, type Logger } from "./logger.ts";
import { createMetrics } from "./metrics.ts";
import { RoomManager } from "./rooms.ts";
import { createStats, type Stats } from "./stats.ts";
import { attachWebSocket } from "./ws.ts";

export const DEFAULT_ROOMS = [
  { id: "somme", name: "Над Соммою", arena: "/assets/arenas/somme.json", maxPlayers: 4 },
  { id: "verdun", name: "Захід над Верденом", arena: "/assets/arenas/verdun.json", maxPlayers: 4 },
  { id: "night", name: "Нічний патруль", arena: "/assets/arenas/night.json", maxPlayers: 6 },
] as const;

export interface App {
  readonly httpServer: http.Server;
  readonly rooms: RoomManager;
  readonly stats: Stats;
  listen(port?: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

/** Build the whole server without starting it (tests start it on port 0). */
export function createApp({ config, logger }: { config: ServerConfig; logger: Logger }): App {
  const stats = createStats();
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
  });
  const logs = new Set<Promise<void>>();

  mkdirSync(config.logDir, { recursive: true });
  rooms.on("created", (room) => {
    try {
      const log = startMatchLog(room, config.logDir);
      logs.add(log.done);
      log.done
        .catch((err: unknown) =>
          logger.error({ room: room.id, ...errFields(err) }, "match log failed"),
        )
        .finally(() => logs.delete(log.done));
    } catch (err: unknown) {
      logger.error({ room: room.id, ...errFields(err) }, "cannot open match log");
    }
  });
  rooms.on("room-error", (room, err) =>
    logger.error({ room: room.id, ...errFields(err) }, "room error"),
  );
  rooms.on("deleted", (room) => logger.info({ room: room.id }, "room deleted"));

  const metrics = createMetrics({ rooms, stats });
  let accepting = true;
  const isReady = () =>
    accepting && stats.connections - stats.disconnections < config.maxConnections;
  const httpServer = http.createServer(
    createHttpHandler({ config, rooms, logger, stats, metrics, isReady }),
  );
  const ws = attachWebSocket({ httpServer, config, rooms, logger, stats, metrics });
  for (const r of DEFAULT_ROOMS) rooms.create({ ...r, persistent: true });

  let closing: Promise<void> | null = null;
  return {
    httpServer,
    rooms,
    stats,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          const addr = httpServer.address();
          if (addr && typeof addr === "object") resolve(addr);
          else reject(new Error("server is not listening on a TCP port"));
        });
      });
    },
    /** Graceful: stop accepting → shutdown msg + 1001 → close rooms → flush logs. */
    close() {
      closing ??= (async () => {
        accepting = false; // /ready → 503 at once, so a proxy stops sending new players
        httpServer.close();
        await ws.close();
        rooms.closeAll();
        await Promise.allSettled([...logs]);
        httpServer.closeAllConnections();
      })();
      return closing;
    },
  };
}
