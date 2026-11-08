/**
 * Minimal structured logger: one JSON object per line on stdout/stderr.
 * (Lab 8 swaps it for pino with the same call shape: log.info(fields, msg).)
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type Level = keyof typeof LEVELS;
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(fields: Fields, msg: string): void;
  info(fields: Fields, msg: string): void;
  warn(fields: Fields, msg: string): void;
  error(fields: Fields, msg: string): void;
  child(fields: Fields): Logger;
}

function isLevel(s: string | undefined): s is Level {
  return s !== undefined && Object.hasOwn(LEVELS, s);
}

export function createLogger({
  level = process.env.LOG_LEVEL,
  base = {},
}: {
  level?: string | undefined;
  base?: Fields;
} = {}): Logger {
  const lvl: Level = isLevel(level) ? level : "info";
  const min = LEVELS[lvl];
  const write = (l: Exclude<Level, "silent">, fields: Fields, msg: string) => {
    if (LEVELS[l] < min) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: l,
      ...base,
      ...fields,
      msg,
    });
    (LEVELS[l] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (f, m) => write("debug", f, m),
    info: (f, m) => write("info", f, m),
    warn: (f, m) => write("warn", f, m),
    error: (f, m) => write("error", f, m),
    child: (fields) => createLogger({ level: lvl, base: { ...base, ...fields } }),
  };
}

/** Serialise an unknown thrown value for a log line (catch clauses give `unknown`). */
export function errFields(err: unknown): Fields {
  if (err instanceof Error)
    return { err: { name: err.name, message: err.message, stack: err.stack } };
  return { err: String(err) };
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
