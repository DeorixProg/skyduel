// Lab 8 M2 chaos tests against a running server (start it with MAX_CONNECTIONS_PER_IP=64,
// because every test client here comes from 127.0.0.1).
//  1) a client vanishes mid-match → the others' roster updates;
//  2) a client floods ~1000 garbage frames per second → it is closed, logged, counted, and
//     the tick time of ANOTHER room does not grow (proved with /metrics + /api/stats).
// Usage: node scripts/chaos.ts [base=http://localhost:8080]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { binaryCodec } from "@skyduel/shared/codec/binary.ts";
import { type Input, seq } from "@skyduel/shared/types.ts";
import { WebSocket } from "ws";
import { z } from "zod";

const base = process.argv[2] ?? "http://localhost:8080";
const wsUrl = `${base.replace(/^http/, "ws")}/ws`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const Stats = z.object({
  matches: z.array(z.object({ room: z.string(), tickMsP50: z.number(), tickMsP99: z.number() })),
});

async function connect(
  room: string,
  name: string,
): Promise<{ ws: WebSocket; roster: () => number }> {
  const ws = new WebSocket(wsUrl);
  ws.on("error", () => {});
  let rosterSize = 0;
  ws.on("message", (d, isBinary) => {
    if (isBinary) return;
    const m: unknown = JSON.parse(String(d));
    if (
      m &&
      typeof m === "object" &&
      "type" in m &&
      m.type === "roster" &&
      "players" in m &&
      Array.isArray(m.players)
    )
      rosterSize = m.players.length;
  });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "join", room, name }));
  return { ws, roster: () => rosterSize };
}

const metric = async (name: string) => {
  const text = await (await fetch(`${base}/metrics`)).text();
  return text
    .split("\n")
    .filter((l) => l.startsWith(name))
    .join("; ");
};

// ── a victim room with 16 clients flying ─────────────────────────────────────
const room = z.object({ id: z.string() }).parse(
  await (
    await fetch(`${base}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({ name: `victim ${Date.now() % 1000}`, maxPlayers: 16 }),
    })
  ).json(),
).id;
const victims = await Promise.all(Array.from({ length: 16 }, (_, i) => connect(room, `v${i}`)));
let n = 0;
const flying = setInterval(() => {
  n++;
  for (const [i, v] of victims.entries()) {
    const inp: Input = {
      seq: seq(n),
      thrust: (n + i * 5) % 60 < 45,
      turn: (n + i) % 40 < 15 ? 0.7 : 0,
      fire: (n + i) % 8 === 0,
    };
    if (v.ws.readyState === WebSocket.OPEN) v.ws.send(binaryCodec.encodeInputs([inp]));
  }
}, 1000 / 30);
const tick = async () =>
  Stats.parse(await (await fetch(`${base}/api/stats`)).json()).matches.find((m) => m.room === room);

await sleep(11_000); // fill the 300-tick window
const baseline = await tick();

// ── 1) client vanishes mid-match ─────────────────────────────────────────────
const gone = victims.pop();
const t0 = performance.now();
gone?.ws.terminate(); // no close frame: like a crashed tab or a pulled cable
while ((victims[0]?.roster() ?? 0) !== 15 && performance.now() - t0 < 5000) await sleep(10);
const rosterUpdateMs = Math.round(performance.now() - t0);

// ── 2) garbage flood: ~1000 frames/s for 10 s, reconnecting whenever closed ──
const rejectedBefore = await metric("skyduel_rejections_total");
let sent = 0;
let opened = 0;
let closedCodes: Record<string, number> = {};
const flood = async (until: number) => {
  while (performance.now() < until) {
    const ws = new WebSocket(wsUrl);
    ws.on("error", () => {});
    const closed = new Promise<number>((r) => ws.once("close", (c) => r(c)));
    await new Promise((r) => {
      ws.once("open", r);
      ws.once("close", r);
    });
    if (ws.readyState !== WebSocket.OPEN) {
      await sleep(5);
      continue;
    }
    opened++;
    const burst = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(Buffer.from([0xde, 0xad, 0xbe, 0xef, sent & 0xff])); // binary garbage before join
      ws.send("{not json"); // and text garbage
      sent += 2;
    }, 2);
    const code = await closed;
    clearInterval(burst);
    closedCodes = { ...closedCodes, [code]: (closedCodes[code] ?? 0) + 1 };
  }
};
// 2b) a JOINED client sending ~1000 valid messages per second → token bucket (60/s, burst 120)
const spammer = await connect("night", "spammer");
const spamStart = performance.now();
let spamSent = 0;
const spamClosed = new Promise<number>((r) => spammer.ws.once("close", (c) => r(c)));
const spam = setInterval(() => {
  for (let i = 0; i < 15 && spammer.ws.readyState === WebSocket.OPEN; i++) {
    spammer.ws.send(JSON.stringify({ type: "ping", t: spamSent++ }));
  }
}, 2);
const spamCode = await spamClosed;
clearInterval(spam);
const rateLimit = {
  closedWith: spamCode,
  afterMs: Math.round(performance.now() - spamStart),
  messagesSent: spamSent,
};

const floodStart = performance.now();
await flood(floodStart + 10_000);
const during = await tick();
const rejectedAfter = await metric("skyduel_rejections_total");

clearInterval(flying);
for (const v of victims) v.ws.close();
const result = {
  rateLimit,
  victimRoom: room,
  clientVanished: { rosterUpdateMs },
  garbageFlood: {
    seconds: 10,
    framesSent: sent,
    connectionsOpened: opened,
    closedWith: closedCodes,
    rejectedBefore,
    rejectedAfter,
  },
  otherRoomTick: { before: baseline, during },
};
console.log(JSON.stringify(result, null, 2));
const out = path.resolve("..", "docs", "lab08");
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "chaos.json"), JSON.stringify(result, null, 2));
process.exit(0);
