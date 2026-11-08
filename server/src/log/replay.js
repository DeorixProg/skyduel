import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const ID = /^[\w-]+$/;

/** Async generator: parsed events from an NDJSON file, one line at a time. */
export async function* readEvents(file) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // a torn last line (process killed mid-write) must not break the replay
    }
  }
}

export async function listReplays(logDir) {
  let names;
  try {
    names = await readdir(logDir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".ndjson"))) {
    const s = await stat(path.join(logDir, name));
    out.push({ id: name.slice(0, -".ndjson".length), bytes: s.size, modified: s.mtime });
  }
  return out.sort((a, b) => b.modified - a.modified);
}

/** Map a replay id to its file, refusing anything that is not a plain id. */
export function replayPath(logDir, id) {
  if (!ID.test(id)) return null;
  return path.join(logDir, `${id}.ndjson`);
}
