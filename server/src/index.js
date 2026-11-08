import { SIM_FLAGS } from "@skyduel/shared/sim/ship.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger, errFields } from "./logger.js";

const logger = createLogger({ base: { svc: "skyduel" } });

let config;
try {
  config = loadConfig();
} catch (err) {
  logger.error(errFields(err), "refusing to start");
  process.exit(1);
}

// Lab 5 experiment only: Math.random() inside integrate on the server side too
if (process.env.SIM_CHAOS === "1") SIM_FLAGS.chaos = true;

const app = createApp({ config, logger });
const addr = await app.listen();
logger.info({ port: addr.port, staticDir: config.staticDir, logDir: config.logDir }, "listening");

async function shutdown(signal) {
  logger.info({ signal }, "shutting down");
  const force = setTimeout(() => {
    logger.error({}, "shutdown took longer than 10 s, forcing exit");
    process.exit(1);
  }, 10_000);
  force.unref();
  await app.close();
  logger.info({}, "bye");
  process.exit(0);
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// Unknown failures: log with stack and exit. Swallowing them would leave a
// process in an undefined state; the supervisor (Docker, systemd) restarts it.
process.on("uncaughtException", (err) => {
  logger.error(errFields(err), "uncaught exception");
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  logger.error(errFields(err), "unhandled rejection");
  process.exit(1);
});
