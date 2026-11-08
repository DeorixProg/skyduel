import { on } from "node:events";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MatchEvent, Room } from "../rooms.ts";

/** Object-mode Transform: one event object in → one NDJSON line out. */
export function toNdjson(): Transform {
  return new Transform({
    writableObjectMode: true,
    transform(event: unknown, _enc, done) {
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
 */
export function startMatchLog(room: Room, logDir: string): { file: string; done: Promise<void> } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(logDir, `${room.id}-${stamp}.ndjson`);
  const events = on(room, "event", { close: ["close"] });
  async function* source(): AsyncGenerator<MatchEvent> {
    for await (const args of events) {
      const [event]: MatchEvent[] = args; // events.on yields the listener's argument list
      if (event) yield event;
    }
  }
  const done = pipeline(
    Readable.from(source()),
    toNdjson(),
    createWriteStream(file, { flags: "a" }),
  );
  return { file, done };
}
