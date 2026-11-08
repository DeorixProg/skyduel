// Lab 7 M3 (server): CPU profile of a match with N bots, plus tick-time percentiles.
// Usage: node scripts/tick-profile.ts <label> [bots=64] [seconds=60] [collide=naive|hash]
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { naivePairs } from "@skyduel/shared/sim/collision.ts";
import { spatialHashPairs } from "@skyduel/shared/sim/spatial.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";

const label = process.argv[2] ?? "naive";
const bots = Number(process.argv[3] ?? 64);
const seconds = Number(process.argv[4] ?? 60);
const collide = process.argv[5] === "hash" ? spatialHashPairs : naivePairs;
const out = path.resolve("..", "docs", "lab07", "server");
mkdirSync(out, { recursive: true });

const config = loadConfig({
  LOG_DIR: mkdtempSync(path.join(os.tmpdir(), "skyduel-prof-")),
  MAX_PLAYERS_PER_ROOM: "256",
});
const app = createApp({ config, logger: createLogger({ level: "silent" }) });
const { port } = await app.listen(0, "127.0.0.1");
const base = `http://127.0.0.1:${port}`;
await fetch(`${base}/api/rooms`, {
  method: "POST",
  body: JSON.stringify({ name: "Load", maxPlayers: 256 }),
});
for (let left = bots; left > 0; left -= 64) {
  await fetch(`${base}/api/rooms/load/bots`, {
    method: "POST",
    body: JSON.stringify({ count: Math.min(64, left) }),
  });
}
const match = app.rooms.get("load")?.match;
if (!match) throw new Error("no match");
match.world.collide = collide;

const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.start");
const ticks: number[] = [];
const sampler = setInterval(() => ticks.push(...match.tickMs.splice(0)), 1000);
await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(sampler);
ticks.push(...match.tickMs.splice(0));
const { profile } = await session.post("Profiler.stop");
writeFileSync(path.join(out, `${label}.cpuprofile`), JSON.stringify(profile));

// top self-time functions
const self = new Map<string, number>();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
profile.samples?.forEach((id, i) => {
  const f = byId.get(id)?.callFrame;
  if (!f) return;
  const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}`;
  self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000);
});
const top = [...self]
  .filter(([k]) => !k.startsWith("(idle)"))
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)
  .map(([f, ms]) => ({ f, ms: Math.round(ms) }));
const s = ticks.sort((a, b) => a - b);
const pct = (q: number) =>
  Number((s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0).toFixed(2));
const result = {
  label,
  bots,
  seconds,
  entities: match.world.size,
  ticks: s.length,
  tickP50: pct(0.5),
  tickP95: pct(0.95),
  tickP99: pct(0.99),
  tickMax: pct(1),
  top,
};
writeFileSync(path.join(out, `${label}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await app.close();
process.exit(0);
