// Lab 7 M3: 30-second session with 8 server bots and heavy shooting.
// Records frame times, performance.measure totals, GC events (trace), top allocators
// (sampling heap profiler) and a CPU profile (for top self-time + flame chart).
// Usage: server on :8080 with MAX_PLAYERS_PER_ROOM>=16, then
//   node tools/profile-lab7.mjs <label> [seconds=30] [cpuThrottle=1]
import fs from "node:fs";
import { chromium } from "playwright-core";

const label = process.argv[2] ?? "before";
const seconds = Number(process.argv[3] ?? 30);
const throttle = Number(process.argv[4] ?? 1);
const OUT = `docs/lab07/${label}`;
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE ?? "http://localhost:8080";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a fresh room with 8 bots
const room = await (
  await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    body: JSON.stringify({ name: `perf ${label} ${Date.now() % 10000}`, maxPlayers: 16 }),
  })
).json();
if (!room.id) throw new Error(`cannot create room: ${JSON.stringify(room)}`);
const bots = await (
  await fetch(`${BASE}/api/rooms/${room.id}/bots`, {
    method: "POST",
    body: JSON.stringify({ count: 8 }),
  })
).json();
console.log("room", room.id, "bots", bots.added?.length);

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--mute-audio"],
  headless: false,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${BASE}/${process.env.PERF === "0" ? "" : "?perf=1"}`);
await page.waitForSelector(`#lobby .room[data-id="${room.id}"]`);
await page.click(`#lobby .room[data-id="${room.id}"]`);
await page.click("#join");
await page.waitForFunction(() => window.__game?.latest);
const cdp = await page.context().newCDPSession(page);
if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
await sleep(2000); // warm-up: JIT, first GCs

await browser.startTracing(page, {
  categories: ["devtools.timeline", "v8", "disabled-by-default-v8.gc"],
});
// NOPROF=1: trace only (the CPU and heap samplers themselves allocate and trigger GCs)
const PROF = process.env.NOPROF !== "1";
if (PROF) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await cdp.send("HeapProfiler.enable");
  // include objects that already died: we want the GARBAGE producers, not only what is live
  await cdp.send("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
await page.evaluate(() => {
  window.__game.recorder.reset();
  performance.clearMeasures();
});

// heavy shooting: thrust + fire all the time, alternate turns
await page.keyboard.down("KeyW");
await page.keyboard.down("Space");
const t0 = Date.now();
let k = 0;
while (Date.now() - t0 < seconds * 1000) {
  const key = k++ % 2 ? "KeyA" : "KeyD";
  await page.keyboard.down(key);
  await sleep(600);
  await page.keyboard.up(key);
  await sleep(400);
}
await page.keyboard.up("Space");
await page.keyboard.up("KeyW");

const frames = await page.evaluate(() => window.__game.recorder.summary());
const measures = await page.evaluate(() => {
  const out = {};
  for (const m of performance.getEntriesByType("measure")) {
    out[m.name] ??= { n: 0, total: 0, max: 0 };
    const o = out[m.name];
    o.n++;
    o.total += m.duration;
    o.max = Math.max(o.max, m.duration);
  }
  return out;
});
const empty = {
  nodes: [{ id: 1, callFrame: { functionName: "(none)", url: "", lineNumber: 0 } }],
  samples: [],
  timeDeltas: [],
};
const { profile } = PROF ? await cdp.send("Profiler.stop") : { profile: empty };
const { profile: heap } = PROF
  ? await cdp.send("HeapProfiler.stopSampling")
  : {
      profile: {
        head: {
          callFrame: { functionName: "(none)", url: "", lineNumber: 0 },
          selfSize: 0,
          children: [],
        },
      },
    };
const trace = JSON.parse((await browser.stopTracing()).toString());
fs.writeFileSync(`${OUT}/cpu.cpuprofile`, JSON.stringify(profile));

// GC events from the trace
const gc = { minor: { n: 0, ms: 0, max: 0 }, major: { n: 0, ms: 0, max: 0 } };
for (const e of trace.traceEvents ?? []) {
  if (e.ph !== "X" || !e.dur) continue;
  // DevTools timeline events only: V8.GC_* describe the same pauses a second time
  const kind = e.name === "MinorGC" ? "minor" : e.name === "MajorGC" ? "major" : null;
  if (!kind) continue;
  gc[kind].n++;
  gc[kind].ms += e.dur / 1000;
  gc[kind].max = Math.max(gc[kind].max, e.dur / 1000);
}

// what kind of major GCs: args say why (incremental marking finalisation, memory reducer…)
const majorKinds = {};
for (const e of trace.traceEvents ?? []) {
  if (e.name !== "MajorGC" || e.ph !== "X") continue;
  const a = e.args?.data ?? e.args ?? {};
  const k = `${a.type ?? "?"} heap ${Math.round((a.usedHeapSizeBefore ?? 0) / 1048576)}→${Math.round((a.usedHeapSizeAfter ?? 0) / 1048576)} MB`;
  majorKinds[k] = (majorKinds[k] ?? 0) + 1;
}
gc.majorKinds = majorKinds;

// top allocators (self size) from the sampling heap profile
const alloc = new Map();
(function walk(node) {
  const f = node.callFrame;
  const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
  alloc.set(key, (alloc.get(key) ?? 0) + node.selfSize);
  for (const c of node.children ?? []) walk(c);
})(heap.head);
const totalAllocKb = Math.round([...alloc.values()].reduce((a, b) => a + b, 0) / 1024);
const topAlloc = [...alloc]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 6)
  .map(([f, b]) => ({ f, kb: Math.round(b / 1024) }));

// top self-time functions from the CPU profile
const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
profile.samples.forEach((id, i) => {
  const n = byId.get(id);
  const f = n.callFrame;
  const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
});
const topSelf = [...self]
  .filter(([f]) => !/^\((idle|program|garbage collector)\)/.test(f))
  .sort((a, b) => b[1] - a[1])
  .slice(0, 6)
  .map(([f, ms]) => ({ f, ms: Math.round(ms) }));
const gcSelf = Math.round(self.get("(garbage collector) :0") ?? 0);

const result = {
  totalAllocKb,
  label,
  seconds,
  throttle,
  frames,
  measures,
  gc,
  gcSelfMs: gcSelf,
  topAlloc,
  topSelf,
  errors,
};
fs.writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await page.screenshot({ path: `${OUT}/game.png` });
await browser.close();
