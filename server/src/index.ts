import { SIM_FLAGS } from "@skyduel/shared/sim/ship.ts";
import { createApp } from "./app.ts";
import { loadConfig, type ServerConfig } from "./config.ts";
import { createLogger, errFields } from "./logger.ts";

const logger = createLogger({ base: { svc: "skyduel" } });

function configOrExit(): ServerConfig {
  try {
    return loadConfig();
  } catch (err: unknown) {
    logger.error(errFields(err), "refusing to start");
    process.exit(1);
  }
}
const config = configOrExit();

// Lab 5 experiment only: Math.random() inside integrate on the server side too
if (config.simChaos) SIM_FLAGS.chaos = true;

const app = createApp({ config, logger });
const addr = await app.listen();
logger.info({ port: addr.port, staticDir: config.staticDir, logDir: config.logDir }, "listening");

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  const started = performance.now();
  logger.info({ signal }, "shutting down");
  const force = setTimeout(() => {
    logger.error({}, "shutdown took longer than 10 s, forcing exit");
    process.exit(1);
  }, 10_000);
  force.unref();
  await app.close();
  logger.info({ ms: Math.round(performance.now() - started) }, "bye");
  logger.flush?.();
  process.exit(0);
}
process.once("SIGINT", (s) => void shutdown(s));
process.once("SIGTERM", (s) => void shutdown(s));

// Unknown failures: log with stack and exit. Swallowing them would leave a
// process in an undefined state; the supervisor (Docker, systemd) restarts it.
process.on("uncaughtException", (err) => {
  logger.error(errFields(err), "uncaught exception");
  logger.flush?.();
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  logger.error(errFields(err), "unhandled rejection");
  process.exit(1);
});
