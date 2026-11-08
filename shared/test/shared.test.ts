import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as binary from "../src/codec/binary.ts";
import { jsonCodec } from "../src/codec/json.ts";
import { scriptedRunHash } from "../src/determinism.ts";
import { DT, reconcile, replay } from "../src/net/predict.ts";
import { parseClientMessage } from "../src/protocol.ts";
import { Ship } from "../src/sim/entities.ts";
import { createShip, integrate, SIM_FLAGS } from "../src/sim/ship.ts";
import { Vector2 } from "../src/sim/vector.ts";
import { World } from "../src/sim/world.ts";
import { hashSnapshot, takeSnapshot } from "../src/snapshot.ts";
import { type Input, seq, tick } from "../src/types.ts";

describe("shared imports in Node", () => {
  test("no DOM globals are needed by the simulation", () => {
    assert.equal("document" in globalThis, false);
    assert.equal("window" in globalThis, false);
    const w = new World({ seed: 1 });
    w.populate();
    w.step(DT);
    assert.ok(w.size > 0);
  });
});

/** Same seed + same scripted inputs → same world, step by step. */
function runMatch(seed: number, steps: number) {
  const w = new World({ seed });
  const a = w.spawn(new Ship({ pos: new Vector2(400, 450), name: "a" }));
  const b = w.spawn(new Ship({ pos: new Vector2(1200, 450), angle: Math.PI, name: "b" }));
  w.populate({ balloons: 8, hunters: 3 });
  const hashes: string[] = [];
  for (let i = 0; i < steps; i++) {
    const inputs = new Map([
      [a.id, { seq: seq(i + 1), thrust: i % 90 < 60, turn: Math.sin(i / 20), fire: i % 7 === 0 }],
      [b.id, { seq: seq(i + 1), thrust: true, turn: -0.4, fire: i % 11 === 0 }],
    ]);
    w.step(DT, inputs);
    if (i % 100 === 99) hashes.push(hashSnapshot(takeSnapshot(w, tick(i))));
  }
  return { hashes, final: takeSnapshot(w, tick(steps)) };
}

describe("determinism", () => {
  test("golden hash: the scripted 1000-step match is bit-identical to Lab 5", () => {
    // c82272da = the Lab 5 JavaScript simulation (verified step by step for 5000 steps);
    // a refactor that changes ANY bit of the simulation breaks this test.
    assert.equal(scriptedRunHash().hash, "c82272da");
  });
  test("two worlds with the same seed and inputs stay identical for 1000 steps", () => {
    const r1 = runMatch(42, 1000);
    const r2 = runMatch(42, 1000);
    assert.deepEqual(r1.hashes, r2.hashes);
    assert.deepEqual(r1.final, r2.final);
  });
  test("a different seed gives a different world", () => {
    assert.notDeepEqual(runMatch(1, 200).hashes, runMatch(2, 200).hashes);
  });
  test("Math.random in integrate breaks it (the Lab 5 experiment)", () => {
    SIM_FLAGS.chaos = true;
    try {
      assert.notDeepEqual(runMatch(42, 300).hashes, runMatch(42, 300).hashes);
    } finally {
      SIM_FLAGS.chaos = false;
    }
  });
  test("entity ids are per world (two worlds in one process don't interfere)", () => {
    const w1 = new World({ seed: 1 });
    const w2 = new World({ seed: 1 });
    const s1 = w1.spawn(new Ship({ pos: new Vector2(1, 1) }));
    w2.spawn(new Ship({ pos: new Vector2(1, 1) }));
    w2.spawn(new Ship({ pos: new Vector2(1, 1) }));
    const s1b = w1.spawn(new Ship({ pos: new Vector2(1, 1) }));
    assert.deepEqual([s1.id, s1b.id], [1, 2]);
  });
});

describe("prediction / reconciliation", () => {
  const inputs: Input[] = Array.from({ length: 10 }, (_, i) => ({
    seq: seq(i + 1),
    thrust: true,
    turn: i < 5 ? 1 : -1,
    fire: false,
  }));
  test("reconcile with a correct server state reproduces the prediction exactly", () => {
    const start = createShip(100, 100, 0);
    const predicted = replay(start, inputs);
    const server = replay(start, inputs.slice(0, 4)); // server has applied seq 1..4
    const r = reconcile({ server, ack: seq(4), pending: inputs });
    assert.deepEqual(r.state, predicted);
    assert.equal(r.pending.length, 6);
  });
  test("a server correction moves the result by exactly the correction", () => {
    const start = createShip(100, 100, 0);
    const server = { ...replay(start, inputs.slice(0, 4)) };
    server.x += 5; // e.g. pushed by something the client did not predict
    const r = reconcile({ server, ack: seq(4), pending: inputs });
    const predicted = replay(start, inputs);
    assert.ok(Math.abs(r.state.x - predicted.x - 5) < 1e-9);
  });
  test("integrate is pure", () => {
    const s = createShip();
    const copy = { ...s };
    integrate(s, { thrust: true, turn: 1, fire: false }, DT);
    assert.deepEqual(s, copy);
  });
});

describe("binary codec", () => {
  const w = new World({ seed: 9 });
  const ship = w.spawn(new Ship({ pos: new Vector2(321.5, 123.25), angle: -2.5, name: "x" }));
  w.populate({ balloons: 5, hunters: 2 });
  for (let i = 0; i < 40; i++) {
    w.step(DT, new Map([[ship.id, { seq: seq(i + 1), thrust: true, turn: 0.3, fire: true }]]));
  }
  ship.effects.set("shield", 1);
  ship.effects.set("homing", 2);
  const snap = takeSnapshot(w, tick(1234));

  test("snapshot round-trip within quantisation tolerance", () => {
    const buf = binary.encodeSnapshot(snap, seq(77));
    assert.equal(buf.byteLength, binary.snapshotSize(snap.entities));
    const back = binary.decodeSnapshot(buf);
    assert.equal(back.tick, 1234);
    assert.equal(back.ack, 77);
    assert.equal(back.entities.length, snap.entities.length);
    snap.entities.forEach((e, i) => {
      const d = back.entities[i];
      assert.ok(d);
      assert.equal(d.id, e.id);
      assert.equal(d.kind, e.kind);
      assert.ok(Math.abs(d.x - e.x) < 1e-3 && Math.abs(d.y - e.y) < 1e-3);
      assert.ok(Math.abs(d.angle - e.angle) <= 0.5 / binary.ANGLE_SCALE + 1e-12);
      if (e.kind === "ship" && d.kind === "ship") {
        assert.deepEqual(d.effects, e.effects);
        assert.equal(d.hp, e.hp);
      }
      if (e.kind === "bullet" && d.kind === "bullet") assert.equal(d.seq, e.seq);
    });
  });
  test("works on a Node Buffer slice with an offset", () => {
    const buf = Buffer.from(binary.encodeSnapshot(snap, seq(1)));
    const padded = Buffer.concat([Buffer.alloc(7), buf]).subarray(7);
    assert.equal(binary.decodeSnapshot(padded).entities.length, snap.entities.length);
  });
  test("bad buffers → CodecError, never a crash", () => {
    const good = new Uint8Array(binary.encodeSnapshot(snap, seq(1)));
    const cases = [
      new Uint8Array(3),
      good.slice(0, good.length - 1),
      Uint8Array.of(...good, 0),
      Uint8Array.from(good, (b, i) => (i === 1 ? 99 : b)),
      Uint8Array.from(good, (b, i) => (i === 14 ? 200 : b)),
    ];
    for (const c of cases) assert.throws(() => binary.decodeSnapshot(c), binary.CodecError);
  });
  test("inputs round-trip, including redundancy", () => {
    const inputs: Input[] = [
      { seq: seq(10), thrust: true, turn: -1, fire: false },
      { seq: seq(11), thrust: false, turn: 0, fire: true },
      { seq: seq(12), thrust: true, turn: 1, fire: true },
    ];
    const buf = binary.encodeInputs(inputs);
    assert.equal(buf.byteLength, 3 + 6 * 3);
    assert.deepEqual(binary.decodeInputs(buf), inputs);
    assert.throws(() => binary.decodeInputs(new Uint8Array([1, 1, 0])), binary.CodecError);
  });
  test("binary is much smaller than JSON", () => {
    const b = binary.encodeSnapshot(snap, seq(1)).byteLength;
    const j = new TextEncoder().encode(String(jsonCodec.encodeSnapshot(snap, seq(1)))).byteLength;
    assert.ok(j / b > 4, `JSON ${j} B vs binary ${b} B`);
  });
});

describe("protocol", () => {
  test("input messages are validated", () => {
    assert.equal(
      parseClientMessage(
        '{"type":"input","inputs":[{"seq":1,"thrust":true,"turn":0,"fire":false}]}',
      ).ok,
      true,
    );
    assert.equal(
      parseClientMessage(
        '{"type":"input","inputs":[{"seq":1,"thrust":true,"turn":1000,"fire":false}]}',
      ).ok,
      false,
    );
    assert.equal(
      parseClientMessage('{"type":"join","room":"a","name":"b","codec":"xml"}').ok,
      false,
    );
  });
});
