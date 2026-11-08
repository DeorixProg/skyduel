import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Configuration comes only from the environment (12-factor). Every value is
 * parsed and validated here, once; the rest of the server receives a frozen,
 * typed-by-convention object and never touches process.env.
 * Invalid config → a clear error at startup, not a crash an hour later.
 */
export function loadConfig(env = process.env) {
  const errors = [];

  const int = (name, def, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
      return def;
    }
    return n;
  };
  const str = (name, def) => (env[name] === undefined || env[name] === "" ? def : env[name]);

  const config = {
    port: int("PORT", 8080, 0, 65535),
    host: str("HOST", "0.0.0.0"),
    logDir: path.resolve(str("LOG_DIR", path.join(here, "..", "logs"))),
    staticDir: path.resolve(str("STATIC_DIR", path.join(here, "..", "..", "client", "dist"))),
    maxRooms: int("MAX_ROOMS", 50, 1, 10_000),
    maxPlayersPerRoom: int("MAX_PLAYERS_PER_ROOM", 8, 1, 64),
    maxPayload: int("MAX_PAYLOAD", 4096, 64, 1 << 20),
    msgRate: int("MSG_RATE", 30, 1, 1000), // tokens per second
    msgBurst: int("MSG_BURST", 60, 1, 10_000),
    joinTimeoutMs: int("JOIN_TIMEOUT_MS", 5000, 100, 60_000),
    heartbeatMs: int("HEARTBEAT_MS", 15_000, 100, 300_000),
    slowClientBytes: int("SLOW_CLIENT_BYTES", 256 * 1024, 1024, 64 * 1024 * 1024),
    enableSlowEndpoint: str("ENABLE_SLOW_ENDPOINT", "0") === "1", // lab 4 demo only
  };

  if (errors.length) {
    const err = new Error(`Invalid configuration:\n  - ${errors.join("\n  - ")}`);
    err.code = "ERR_CONFIG";
    throw err;
  }
  return Object.freeze(config);
}
