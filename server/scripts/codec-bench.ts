// Lab 5 table: JSON vs binary with 4 players at 30 Hz against the running server (:8080),
// plus an encode+decode micro-benchmark on a realistic snapshot.
// Usage: node scripts/codec-bench.ts
import { binaryCodec as binary } from "@skyduel/shared/codec/binary.ts";
import { jsonCodec as json } from "@skyduel/shared/codec/json.ts";
import { DT } from "@skyduel/shared/net/predict.ts";
import { Ship } from "@skyduel/shared/sim/entities.ts";
import { Vector2 } from "@skyduel/shared/sim/vector.ts";
import { World } from "@skyduel/shared/sim/world.ts";
import { takeSnapshot } from "@skyduel/shared/snapshot.ts";
import { type Input, seq, tick } from "@skyduel/shared/types.ts";
import { WebSocket } from "ws";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BenchClient {
  ws: WebSocket;
  down: number;
  up: number;
  snaps: number;
  seq: number;
  sent: Input[];
}

async function live(codec: "json" | "binary", seconds = 10) {
  const clients: BenchClient[] = [];
  for (let i = 0; i < 4; i++) {
    const ws = new WebSocket("ws://localhost:8080/ws");
    await new Promise((r) => ws.once("open", r));
    const c: BenchClient = { ws, down: 0, up: 0, snaps: 0, seq: 0, sent: [] };
    ws.on("message", (d: Buffer, isBinary: boolean) => {
      const isSnap = isBinary || d.toString().startsWith('{"type":"snapshot"');
      if (!isSnap) return;
      c.down += d.length;
      c.snaps++;
    });
    ws.send(JSON.stringify({ type: "join", room: "verdun", name: `bot${i}`, codec }));
    clients.push(c);
  }
  await sleep(1000);
  for (const c of clients) Object.assign(c, { down: 0, up: 0, snaps: 0 });
  const timer = setInterval(() => {
    for (const [i, c] of clients.entries()) {
      const inp: Input = {
        seq: seq(++c.seq),
        thrust: true,
        turn: i % 2 ? 0.5 : -0.5,
        fire: c.seq % 4 === 0,
      };
      c.sent.push(inp);
      if (c.sent.length > 3) c.sent.shift();
      const frame = codec === "json" ? json.encodeInputs(c.sent) : binary.encodeInputs(c.sent);
      c.up += typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
      c.ws.send(frame);
    }
  }, 1000 / 30);
  await sleep(seconds * 1000);
  clearInterval(timer);
  for (const c of clients) c.ws.close();
  const avg = (f: (c: BenchClient) => number) =>
    clients.reduce((s, c) => s + f(c), 0) / clients.length;
  return {
    bytesPerSnapshot: avg((c) => c.down / c.snaps),
    kbDown: avg((c) => c.down) / seconds / 1024,
    kbUp: avg((c) => c.up) / seconds / 1024,
    snapsPerSec: avg((c) => c.snaps) / seconds,
  };
}

function micro() {
  const w = new World({ seed: 5 });
  const ships = [0, 1, 2, 3].map((i) =>
    w.spawn(new Ship({ pos: new Vector2(200 + i * 300, 300 + i * 100), name: `p${i}` })),
  );
  w.populate({ balloons: 7, hunters: 2 });
  for (let t = 0; t < 30; t++) {
    w.step(
      DT,
      new Map(
        ships.map((s, i) => [
          s.id,
          { seq: seq(t), thrust: true, turn: i % 2 ? 0.3 : -0.3, fire: true },
        ]),
      ),
    );
  }
  const snap = takeSnapshot(w, tick(999));
  const N = 20000;
  const bench = (fn: () => unknown) => {
    for (let i = 0; i < 2000; i++) fn(); // warm-up: let the JIT optimise
    const t = performance.now();
    for (let i = 0; i < N; i++) fn();
    return ((performance.now() - t) / N) * 1000;
  };
  return {
    entities: snap.entities.length,
    json: {
      bytes: Buffer.byteLength(String(json.encodeSnapshot(snap, seq(1)))),
      us: bench(() => json.decodeSnapshot(json.encodeSnapshot(snap, seq(1)))),
    },
    binary: {
      bytes: Buffer.byteLength(binary.encodeSnapshot(snap, seq(1))),
      us: bench(() => binary.decodeSnapshot(binary.encodeSnapshot(snap, seq(1)))),
    },
  };
}

const result = { live: { json: await live("json"), binary: await live("binary") }, micro: micro() };
console.log(JSON.stringify(result, null, 1));
