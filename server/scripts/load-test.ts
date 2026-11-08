// Lab 7 M4: N headless WebSocket clients (binary codec) flying scripted paths against a
// running server; records tick p99, event-loop utilisation, RSS and bytes/s.
// Usage: node scripts/load-test.ts [base=http://localhost:8080] [sizes=8,32,64,128]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { binaryCodec } from "@skyduel/shared/codec/binary.ts";
import { type Input, seq } from "@skyduel/shared/types.ts";
import { WebSocket } from "ws";
import { z } from "zod";

const base = process.argv[2] ?? "http://localhost:8080";
const sizes = (process.argv[3] ?? "8,32,64,128").split(",").map(Number);
const wsBase = base.replace(/^http/, "ws");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const Stats = z.object({
  bytesOut: z.number(),
  elu: z.number(),
  memory: z.object({ rss: z.number() }),
  matches: z.array(
    z.object({
      room: z.string(),
      tickMsP50: z.number(),
      tickMsP99: z.number(),
      players: z.number(),
      entities: z.number(),
    }),
  ),
});
const stats = async () => Stats.parse(await (await fetch(`${base}/api/stats`)).json());

interface Client {
  ws: WebSocket;
  seq: number;
  sent: Input[];
  phase: number;
}

async function run(n: number) {
  const room = `load-${n}-${Date.now() % 100000}`;
  const res = await fetch(`${base}/api/rooms`, {
    method: "POST",
    body: JSON.stringify({ name: room, maxPlayers: n }),
  });
  const id = z.object({ id: z.string() }).parse(await res.json()).id;
  const clients: Client[] = [];
  for (let i = 0; i < n; i++) {
    const ws = new WebSocket(`${wsBase}/ws`);
    ws.on("error", () => {});
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "join", room: id, name: `load${i}`, codec: "binary" }));
    clients.push({ ws, seq: 0, sent: [], phase: i * 7 });
  }
  // scripted flying, like a human: thrust, turns of varying length, bursts of fire
  const timer = setInterval(() => {
    for (const c of clients) {
      const p = (c.seq + c.phase) % 90;
      const inp: Input = {
        seq: seq(++c.seq),
        thrust: p < 70,
        turn: p < 30 ? 0.6 : p < 45 ? -0.8 : 0,
        fire: p % 9 === 0,
      };
      c.sent.push(inp);
      if (c.sent.length > 3) c.sent.shift();
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(binaryCodec.encodeInputs(c.sent));
    }
  }, 1000 / 30);
  await sleep(5000); // warm-up, fills the 300-tick window
  await stats(); // reset the ELU window
  const s0 = await stats();
  const t0 = performance.now();
  await sleep(12_000);
  const s1 = await stats();
  const secs = (performance.now() - t0) / 1000;
  const m = s1.matches.find((x) => x.room === id);
  clearInterval(timer);
  for (const c of clients) c.ws.close();
  await sleep(1500);
  return {
    clients: n,
    entities: m?.entities ?? 0,
    tickP50: Number((m?.tickMsP50 ?? 0).toFixed(2)),
    tickP99: Number((m?.tickMsP99 ?? 0).toFixed(2)),
    elu: Number(s1.elu.toFixed(3)),
    rssMB: Math.round(s1.memory.rss / 1048576),
    outMBps: Number(((s1.bytesOut - s0.bytesOut) / secs / 1048576).toFixed(2)),
  };
}

const results = [];
for (const n of sizes) {
  const r = await run(n);
  console.log(JSON.stringify(r));
  results.push(r);
}
const out = path.resolve("..", "docs", "lab07");
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "load.json"), JSON.stringify(results, null, 2));
process.exit(0);
