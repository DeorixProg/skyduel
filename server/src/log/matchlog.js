import { on } from "node:events";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Object-mode Transform: one event object in → one NDJSON line out. */
export function toNdjson() {
  return new Transform({
    writableObjectMode: true,
    transform(event, _enc, done) {
      done(null, `${JSON.stringify(event)}\n`);
    },
  });
}

/**
 * Every room event → NDJSON file, via pipeline():
 *   Readable.from(events.on(room, "event")) → toNdjson() → createWriteStream
 * `close: ["close"]` ends the async iterator when the room closes, which ends
 * the Readable, which flushes and closes the file. pipeline() propagates
 * errors from any stage and destroys the others, so no fd leaks.
 * Synchronous on purpose: the listener is attached before the caller returns,
 * so no early event is missed. `logDir` must exist.
 * Returns { file, done } — `done` resolves when the file is fully written.
 */
export function startMatchLog(room, logDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(logDir, `${room.id}-${stamp}.ndjson`);
  const events = on(room, "event", { close: ["close"] });
  const source = Readable.from(
    (async function* () {
      for await (const [event] of events) yield event;
    })(),
  );
  const done = pipeline(source, toNdjson(), createWriteStream(file, { flags: "a" }));
  return { file, done };
}
