import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));

const port = z.coerce.number().int().min(0).max(65535);
const int = (min: number, max: number, def: number) =>
  z.coerce.number().int().min(min).max(max).default(def);
const flag = z
  .enum(["0", "1"])
  .default("0")
  .transform((v) => v === "1");

/**
 * Configuration comes only from the environment (12-factor), through ONE zod
 * schema: parsing, defaults, ranges and the resulting TypeScript type
 * (`ServerConfig`) all come from the same place. Invalid config → a clear
 * error at startup, not a crash an hour later.
 */
export const ConfigSchema = z
  .object({
    PORT: port.default(8080),
    HOST: z.string().min(1).default("0.0.0.0"),
    LOG_DIR: z
      .string()
      .min(1)
      .default(path.join(here, "..", "logs")),
    STATIC_DIR: z
      .string()
      .min(1)
      .default(path.join(here, "..", "..", "client", "dist")),
    MAX_ROOMS: int(1, 10_000, 50),
    MAX_PLAYERS_PER_ROOM: int(1, 1024, 8),
    MAX_PAYLOAD: int(64, 1 << 20, 4096),
    MSG_RATE: int(1, 1000, 60), // tokens per second (30 inputs/s + control)
    MSG_BURST: int(1, 10_000, 120),
    JOIN_TIMEOUT_MS: int(100, 60_000, 5000),
    HEARTBEAT_MS: int(100, 300_000, 15_000),
    SLOW_CLIENT_BYTES: int(1024, 64 * 1024 * 1024, 256 * 1024),
    ENABLE_SLOW_ENDPOINT: flag, // Lab 4 demo only
    SIM_CHAOS: flag, // Lab 5 experiment only
    COLLISION: z.enum(["naive", "hash"]).default("hash"), // Lab 7: broad phase (see README)
  })
  .transform((e) => ({
    port: e.PORT,
    host: e.HOST,
    logDir: path.resolve(e.LOG_DIR),
    staticDir: path.resolve(e.STATIC_DIR),
    maxRooms: e.MAX_ROOMS,
    maxPlayersPerRoom: e.MAX_PLAYERS_PER_ROOM,
    maxPayload: e.MAX_PAYLOAD,
    msgRate: e.MSG_RATE,
    msgBurst: e.MSG_BURST,
    joinTimeoutMs: e.JOIN_TIMEOUT_MS,
    heartbeatMs: e.HEARTBEAT_MS,
    slowClientBytes: e.SLOW_CLIENT_BYTES,
    enableSlowEndpoint: e.ENABLE_SLOW_ENDPOINT,
    simChaos: e.SIM_CHAOS,
    collision: e.COLLISION,
  }));

export type ServerConfig = Readonly<z.output<typeof ConfigSchema>>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Empty strings count as "not set" (a common `.env` accident). */
export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = ConfigSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) =>
        `${i.path.join(".")}: ${i.message} (got ${JSON.stringify(cleaned[String(i.path[0])])})`,
    );
    throw new ConfigError(`Invalid configuration:\n  - ${lines.join("\n  - ")}`);
  }
  return Object.freeze(result.data);
}
