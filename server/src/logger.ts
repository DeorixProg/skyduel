import pino from "pino";

/**
 * Structured logging with pino: one JSON object per line on stdout, with
 * `roomId` / `playerId` fields wherever they are known. Secrets never reach
 * the log: known sensitive keys are redacted by path.
 * The call shape stays `log.info(fields, msg)` (Labs 4–7 used a hand-written logger).
 */
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(fields: Fields, msg: string): void;
  info(fields: Fields, msg: string): void;
  warn(fields: Fields, msg: string): void;
  error(fields: Fields, msg: string): void;
  child(fields: Fields): Logger;
  /** Write out anything still buffered (called right before exit). */
  flush?(): void;
}

const LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

export function createLogger({
  level = process.env.LOG_LEVEL,
  base = {},
}: {
  level?: string | undefined;
  base?: Fields;
} = {}): Logger {
  return pino({
    level: level !== undefined && LEVELS.has(level) ? level : "info",
    base: { svc: "skyduel", ...base },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: [
        "password",
        "token",
        "secret",
        "*.password",
        "*.token",
        "*.secret",
        "headers.authorization",
        "headers.cookie",
      ],
      censor: "[redacted]",
    },
  });
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
