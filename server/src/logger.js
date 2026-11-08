/**
 * Minimal structured logger: one JSON object per line on stdout/stderr.
 * (Lab 8 swaps it for pino with the same call shape: log.info(fields, msg).)
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger({ level = process.env.LOG_LEVEL ?? "info", base = {} } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, fields, msg) => {
    if (LEVELS[lvl] < min) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: lvl,
      ...base,
      ...fields,
      msg,
    });
    (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (f, m) => write("debug", f, m),
    info: (f, m) => write("info", f, m),
    warn: (f, m) => write("warn", f, m),
    error: (f, m) => write("error", f, m),
    child: (fields) => createLogger({ level, base: { ...base, ...fields } }),
  };
}

/** Serialise an unknown thrown value for a log line. */
export function errFields(err) {
  if (err instanceof Error)
    return { err: { name: err.name, message: err.message, stack: err.stack } };
  return { err: String(err) };
}
