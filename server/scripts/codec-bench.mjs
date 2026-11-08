// Lab 5 table: JSON vs binary with 4 players at 30 Hz against the running server (:8080),
// plus an encode+decode micro-benchmark on a realistic snapshot.
// Usage: node scripts/codec-bench.mjs
import * as binary from "@skyduel/shared/codec/binary.js";
import * as json from "@skyduel/shared/codec/json.js";
import { DT } from "@skyduel/shared/net/predict.js";
import { Ship } from "@skyduel/shared/sim/entities.js";
import { Vector2 } from "@skyduel/shared/sim/vector.js";
import { World } from "@skyduel/shared/sim/world.js";
import { takeSnapshot } from "@skyduel/shared/snapshot.js";
import { WebSocket } from "ws";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function live(codec, seconds = 10) {
  const clients = [];
  for (let i = 0; i < 4; i++) {
    const ws = new WebSocket("ws://localhost:8080/ws");
    await new Promise((r) => ws.once("open", r));
    const c = { ws, down: 0, up: 0, snaps: 0, seq: 0, sent: [] };
    ws.on("message", (d, isBinary) => {
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
      const inp = { seq: ++c.seq, thrust: true, turn: i % 2 ? 0.5 : -0.5, fire: c.seq % 4 === 0 };
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
  const avg = (f) => clients.reduce((s, c) => s + f(c), 0) / clients.length;
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
        ships.map((s, i) => [s.id, { seq: t, thrust: true, turn: i % 2 ? 0.3 : -0.3, fire: true }]),
      ),
    );
  }
  const snap = takeSnapshot(w, 999);
  const N = 20000;
  const bench = (fn) => {
    for (let i = 0; i < 2000; i++) fn(); // warm-up: let the JIT optimise
    const t = performance.now();
    for (let i = 0; i < N; i++) fn();
    return ((performance.now() - t) / N) * 1000;
  };
  return {
    entities: snap.entities.length,
    json: {
      bytes: Buffer.byteLength(json.encodeSnapshot(snap, 1)),
      us: bench(() => JSON.parse(json.encodeSnapshot(snap, 1))),
    },
    binary: {
      bytes: binary.encodeSnapshot(snap, 1).byteLength,
      us: bench(() => binary.decodeSnapshot(binary.encodeSnapshot(snap, 1))),
    },
  };
}

const result = { live: { json: await live("json"), binary: await live("binary") }, micro: micro() };
console.log(JSON.stringify(result, null, 1));
