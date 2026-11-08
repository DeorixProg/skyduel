import assert from "node:assert/strict";
import fc from "fast-check";
import { describe, test } from "vitest";
import * as binary from "../src/codec/binary.ts";
import { jsonCodec } from "../src/codec/json.ts";
import { DT } from "../src/net/predict.ts";
import { parseClientMessage } from "../src/protocol.ts";
import { ARENA } from "../src/sim/arena.ts";
import { naivePairs } from "../src/sim/collision.ts";
import { Balloon } from "../src/sim/entities.ts";
import { createShip, integrate } from "../src/sim/ship.ts";
import { spatialHashPairs } from "../src/sim/spatial.ts";
import { Vector2 } from "../src/sim/vector.ts";
import { World } from "../src/sim/world.ts";
import type { EntityData, Snapshot } from "../src/snapshot.ts";
import { entityId, type Input, seq, tick } from "../src/types.ts";

// ── arbitraries ──────────────────────────────────────────────────────────────
const f32 = (min: number, max: number) =>
  fc.float({ min: Math.fround(min), max: Math.fround(max), noNaN: true });
const effect = fc.constantFrom("shield" as const, "rapid" as const, "homing" as const);
const base = {
  id: fc.integer({ min: 1, max: 0xffff }).map(entityId),
  x: f32(0, 1600),
  y: f32(0, 900),
  vx: f32(-700, 700),
  vy: f32(-700, 700),
  angle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
};
const entity: fc.Arbitrary<EntityData> = fc.oneof(
  fc.record({
    ...base,
    kind: fc.constant("ship" as const),
    hp: fc.integer({ min: 0, max: 100 }),
    score: fc.integer({ min: 0, max: 999 }),
    down: fc.boolean(),
    thrust: fc.boolean(),
    effects: fc.subarray(["shield", "rapid", "homing"] as const),
  }),
  fc.record({
    ...base,
    kind: fc.constant("bullet" as const),
    owner: fc.integer({ min: 1, max: 0xffff }).map(entityId),
    seq: fc.integer({ min: 0, max: 0xffffffff }).map(seq),
    homing: fc.boolean(),
  }),
  fc.record({
    ...base,
    kind: fc.constant("balloon" as const),
    radius: fc.integer({ min: 10, max: 40 }),
    hunter: fc.boolean(),
  }),
  fc.record({ ...base, kind: fc.constant("pickup" as const), effect }),
);
const snapshot: fc.Arbitrary<Snapshot> = fc.record({
  tick: fc.integer({ min: 0, max: 0xffffffff }).map(tick),
  entities: fc.array(entity, { maxLength: 60 }),
});
const input: fc.Arbitrary<Input> = fc.record({
  seq: fc.integer({ min: 0, max: 0xffffffff }).map(seq),
  thrust: fc.boolean(),
  fire: fc.boolean(),
  turn: fc.constantFrom(-1, 0, 1),
});

describe("properties (fast-check)", () => {
  test("P1 binary snapshot round-trip within quantisation tolerance", () => {
    fc.assert(
      fc.property(snapshot, fc.integer({ min: 0, max: 0xffffffff }), (snap, ack) => {
        const back = binary.decodeSnapshot(binary.encodeSnapshot(snap, seq(ack)));
        assert.equal(back.tick, snap.tick);
        assert.equal(back.ack, ack);
        assert.equal(back.entities.length, snap.entities.length);
        snap.entities.forEach((e, i) => {
          const d = back.entities[i];
          assert.ok(d && d.kind === e.kind && d.id === e.id);
          assert.equal(d.x, Math.fround(e.x)); // f32 on the wire: exact for float32 inputs
          assert.ok(Math.abs(d.angle - e.angle) <= 0.5 / binary.ANGLE_SCALE + 1e-12);
        });
      }),
      { numRuns: 300 },
    );
  });

  test("P2 encoded length always equals the length in the written spec", () => {
    fc.assert(
      fc.property(snapshot, (snap) => {
        const expected =
          12 +
          snap.entities.reduce(
            (n, e) => n + 22 + { ship: 3, bullet: 6, balloon: 1, pickup: 1 }[e.kind],
            0,
          );
        assert.equal(binary.encodeSnapshot(snap, seq(0)).byteLength, expected);
      }),
    );
    fc.assert(
      fc.property(fc.array(input, { minLength: 1, maxLength: 8 }), (ins) =>
        assert.equal(binary.encodeInputs(ins).byteLength, 3 + 6 * ins.length),
      ),
    );
  });

  test("P3 arbitrary garbage → CodecError or a valid message, never another exception", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
        for (const decode of [binary.decodeSnapshot, binary.decodeInputs]) {
          try {
            decode(bytes);
          } catch (err) {
            assert.ok(err instanceof binary.CodecError, String(err));
          }
        }
      }),
      { numRuns: 2000 },
    );
    // mutating one byte of a VALID frame must also be handled
    fc.assert(
      fc.property(snapshot, fc.nat(), fc.integer({ min: 0, max: 255 }), (snap, pos, val) => {
        const buf = new Uint8Array(binary.encodeSnapshot(snap, seq(1)));
        buf[pos % buf.length] = val;
        try {
          binary.decodeSnapshot(buf);
        } catch (err) {
          assert.ok(err instanceof binary.CodecError);
        }
      }),
    );
  });

  test("P4 a ship stays inside the arena over 1000 random input steps", () => {
    fc.assert(
      fc.property(
        fc.array(input, { minLength: 1000, maxLength: 1000 }),
        f32(0, 1599),
        f32(0, 899),
        (inputs, x, y) => {
          let s = createShip(x, y, 0);
          for (const i of inputs) {
            s = integrate(s, i, DT);
            assert.ok(
              s.x >= 0 && s.x < ARENA.width && s.y >= 0 && s.y < ARENA.height,
              `${s.x},${s.y}`,
            );
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  test("P5 parseClientMessage accepts every valid message and rejects mutations of it", () => {
    const valid = fc.oneof(
      fc.record({
        type: fc.constant("join"),
        room: fc.stringMatching(/^[\w-]{1,32}$/),
        name: fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0),
        codec: fc.constantFrom("binary", "json"),
      }),
      fc.record({
        type: fc.constant("chat"),
        text: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
      }),
      fc.record({
        type: fc.constant("ping"),
        t: fc.double({ noNaN: true, noDefaultInfinity: true }),
      }),
      fc.record({
        type: fc.constant("input"),
        inputs: fc.array(input, { minLength: 1, maxLength: 8 }),
      }),
    );
    fc.assert(
      fc.property(valid, (msg) => assert.equal(parseClientMessage(JSON.stringify(msg)).ok, true)),
    );
    const mutate = fc.constantFrom<(m: Record<string, unknown>) => unknown>(
      (m) => ({ ...m, type: "teleport" }),
      (m) => ({ ...m, type: undefined }),
      (m) => [m],
      (m) => JSON.stringify(m).slice(0, -1), // truncated JSON
      (m) => ({
        ...m,
        ...(m.type === "join"
          ? { room: "../etc" }
          : m.type === "chat"
            ? { text: "" }
            : m.type === "ping"
              ? { t: "now" }
              : { inputs: [] }),
      }),
    );
    fc.assert(
      fc.property(valid, mutate, (msg, mut) => {
        const bad = mut(msg);
        assert.equal(
          parseClientMessage(typeof bad === "string" ? bad : JSON.stringify(bad)).ok,
          false,
        );
      }),
    );
  });

  test("P6 JSON codec round-trips (up to -0, which JSON cannot represent)", () => {
    // fast-check found it on the 2nd run: JSON.stringify(-0) === "0", so a vx of -0
    // comes back as +0. Harmless for the game, but deepEqual (Object.is) sees it.
    fc.assert(
      fc.property(snapshot, (snap) => {
        const back = jsonCodec.decodeSnapshot(jsonCodec.encodeSnapshot(snap, seq(3)));
        assert.equal(JSON.stringify(back.entities), JSON.stringify(snap.entities));
      }),
    );
  });

  test("P7 spatial hash finds exactly the pairs of the naive pass, for any layout", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ x: f32(0, 1599), y: f32(0, 899), r: fc.integer({ min: 2, max: 32 }) }),
          { maxLength: 80 },
        ),
        (circles) => {
          const w = new World();
          for (const c of circles)
            w.spawn(new Balloon({ pos: new Vector2(c.x, c.y), radius: c.r }));
          const key = (it: Iterable<readonly [{ id: number }, { id: number }]>) =>
            [...it].map(([a, b]) => `${a.id}-${b.id}`);
          assert.deepEqual(key(spatialHashPairs(w)), key(naivePairs(w)));
        },
      ),
      { numRuns: 200 },
    );
  });
});
