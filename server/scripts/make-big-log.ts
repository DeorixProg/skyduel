// Generates a synthetic match log of ~N MB for the backpressure experiment.
// Usage: node scripts/make-big-log.js [MB=200] [LOG_DIR=./logs]
import { once } from "node:events";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

const mb = Number(process.argv[2] ?? 200);
const dir = process.argv[3] ?? path.resolve("logs");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "big-synthetic.ndjson");
const out = createWriteStream(file);
let bytes = 0;
let t = Date.parse("2026-11-08T12:00:00Z");
let i = 0;
while (bytes < mb * 1024 * 1024) {
  const ev = {
    t: t++,
    room: "somme",
    type: "state",
    tick: i++,
    ships: [
      { id: 1, x: (i * 7) % 1600, y: (i * 3) % 900, a: (i % 628) / 100 },
      { id: 2, x: (i * 5) % 1600, y: (i * 11) % 900, a: (i % 314) / 100 },
    ],
  };
  const line = `${JSON.stringify(ev)}\n`;
  bytes += line.length;
  // respect backpressure on the WRITE side too, or this script itself balloons
  if (!out.write(line)) await once(out, "drain");
}
out.end();
await once(out, "finish");
console.log(`wrote ${(bytes / 1048576).toFixed(1)} MB, ${i} events → ${file}`);
