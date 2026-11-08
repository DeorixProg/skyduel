import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Bot } from "../src/bot.ts";
import { Bus } from "../src/bus.ts";
import { DT } from "../src/net/predict.ts";
import { Pool } from "../src/pool.ts";
import { ARENA, wrap, wrapDelta } from "../src/sim/arena.ts";
import { naivePairs, overlaps } from "../src/sim/collision.ts";
import { Balloon, BULLET, Bullet, Pickup, Ship } from "../src/sim/entities.ts";
import { createRng } from "../src/sim/rng.ts";
import { createShip, integrate, lerpAngle, normalizeAngle, SHIP } from "../src/sim/ship.ts";
import { spatialHashPairs } from "../src/sim/spatial.ts";
import { Vector2 } from "../src/sim/vector.ts";
import { World } from "../src/sim/world.ts";
import { entityId, seq } from "../src/types.ts";

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

describe("Vector2", () => {
  const a = new Vector2(3, 4);
  test("add / sub / scale are pure", () => {
    const b = a.add(new Vector2(1, 1));
    assert.deepEqual([b.x, b.y, a.x, a.y], [4, 5, 3, 4]);
    assert.ok(a.sub(new Vector2(3, 4)).equals(new Vector2()));
    assert.ok(a.scale(2).equals(new Vector2(6, 8)));
  });
  test("length, dot, normalize", () => {
    assert.equal(a.length(), 5);
    assert.equal(a.dot(new Vector2(1, 0)), 3);
    close(a.normalize().length(), 1);
    assert.ok(new Vector2().normalize().equals(new Vector2()));
  });
  test("fromAngle and angle are inverse", () => {
    for (const t of [-3, -1, 0, 0.5, 2, 3.1]) close(Vector2.fromAngle(t, 7).angle(), t, 1e-12);
  });
  test("rotate by 90° turns x into y", () => {
    assert.ok(new Vector2(1, 0).rotate(Math.PI / 2).equals(new Vector2(0, 1), 1e-12));
  });
  test("toString is readable", () => assert.equal(a.toString(), "Vector2(3.00, 4.00)"));
});

describe("arena and angles", () => {
  test("wrap brings any value into [0, size)", () => {
    assert.equal(wrap(-1, 100), 99);
    assert.equal(wrap(250, 100), 50);
  });
  test("wrapDelta takes the short way around", () => {
    assert.equal(wrapDelta(1590, 10, 1600), 20);
    assert.equal(wrapDelta(10, 1590, 1600), -20);
  });
  test("normalizeAngle and lerpAngle across ±π", () => {
    close(normalizeAngle(Math.PI * 3), -Math.PI);
    close(lerpAngle(3.1, -3.1, 0.5), Math.PI, 1e-6);
  });
});

describe("integrate", () => {
  const idle = { thrust: false, turn: 0, fire: false };
  test("thrust accelerates along the heading", () => {
    const s = integrate(createShip(100, 100, 0), { ...idle, thrust: true }, DT);
    assert.ok(s.vx > 0 && Math.abs(s.vy) < 1e-12);
  });
  test("turn changes the angle by TURN_RATE·dt", () => {
    close(integrate(createShip(100, 100, 0), { ...idle, turn: 1 }, DT).angle, SHIP.TURN_RATE * DT);
  });
  test("drag slows a coasting ship", () => {
    const s = integrate({ ...createShip(100, 100, 0), vx: 100 }, idle, DT);
    assert.ok(s.vx < 100 && s.vx > 90);
  });
  test("speed is clamped to MAX_SPEED", () => {
    let s = createShip(100, 100, 0);
    for (let i = 0; i < 600; i++) s = integrate(s, { ...idle, thrust: true }, DT);
    assert.ok(Math.hypot(s.vx, s.vy) <= SHIP.MAX_SPEED + 1e-9);
  });
  test("leaving the arena wraps to the other side", () => {
    const s = integrate({ ...createShip(1599, 450, 0), vx: 300 }, idle, DT);
    assert.ok(s.x < 20);
  });
});

describe("collisions", () => {
  const w = new World();
  const at = (x: number, y: number, r: number) => {
    const b = w.spawn(new Balloon({ pos: new Vector2(x, y), radius: r }));
    return b;
  };
  test("touching circles collide, separate ones do not", () => {
    assert.equal(overlaps(at(100, 100, 10), at(120, 100, 10)), true);
    assert.equal(overlaps(at(300, 100, 10), at(321, 100, 10)), false);
  });
  test("overlap across the wrapped edge is detected", () => {
    assert.equal(overlaps(at(2, 500, 10), at(1595, 500, 10)), true);
  });
  test("no tunnelling: the fastest closing speed per step is below the smallest collision diameter", () => {
    const perStep = (BULLET.SPEED + SHIP.MAX_SPEED) * DT; // bullet head-on into a ship
    assert.ok(perStep < 2 * (BULLET.RADIUS + SHIP.RADIUS), `${perStep.toFixed(1)} u/step`);
  });
  test("a bullet hits a ship, damages it and disappears", () => {
    const world = new World({ seed: 3 });
    const shooter = world.spawn(new Ship({ pos: new Vector2(600, 600) })); // far away: no ramming
    const target = world.spawn(new Ship({ pos: new Vector2(130, 100) }));
    const bullet = world.spawn(
      new Bullet({
        pos: new Vector2(128, 100),
        vel: new Vector2(10, 0),
        ownerId: shooter.id,
        seq: seq(1),
      }),
    );
    world.step(DT);
    assert.equal(target.hp, SHIP.MAX_HP - BULLET.DAMAGE);
    assert.equal(world.get(bullet.id), undefined);
  });
  test("a pickup grants its effect through the component system", () => {
    const world = new World({ seed: 3 });
    const ship = world.spawn(new Ship({ pos: new Vector2(500, 500) }));
    world.spawn(new Pickup({ pos: new Vector2(505, 500), effect: "rapid" }));
    let picked = "";
    world.bus.on("pickup", (d) => {
      picked = d.effect;
    });
    world.step(DT);
    assert.equal(picked, "rapid");
    assert.ok(ship.effects.has("rapid"));
  });
  test("spatial hash and naive pass yield the same pairs in the same order", () => {
    const world = new World({ seed: 9 });
    world.populate({ balloons: 40, hunters: 0 });
    const ids = (it: Iterable<readonly [{ id: number }, { id: number }]>) =>
      [...it].map(([a, b]) => `${a.id}-${b.id}`);
    assert.deepEqual(ids(spatialHashPairs(world)), ids(naivePairs(world)));
  });
});

describe("world", () => {
  test("despawn is deferred to the end of the step; ofKind filters the dead", () => {
    const w = new World();
    const b = w.spawn(new Balloon({ pos: new Vector2(10, 10) }));
    w.despawn(b.id);
    assert.equal([...w.ofKind("balloon")].length, 0);
    assert.ok(w.get(b.id)); // still stored until the sweep
    w.step(DT);
    assert.equal(w.get(b.id), undefined);
  });
  test("a ship destroyed by bullets respawns after 2 s with spawn protection", () => {
    const w = new World({ seed: 1 });
    const a = w.spawn(new Ship({ pos: new Vector2(100, 100) }));
    const b = w.spawn(new Ship({ pos: new Vector2(800, 400) }));
    for (let i = 0; i < 4; i++) b.damage(BULLET.DAMAGE, a);
    assert.equal(b.down, true);
    assert.equal(a.score, 1);
    for (let i = 0; i < 61; i++) w.step(DT);
    assert.equal(b.down, false);
    assert.ok(b.effects.has("shield"));
  });
});

describe("support code", () => {
  test("rng is reproducible from its seed; pick() refuses an empty array", () => {
    const a = createRng(5);
    const b = createRng(5);
    assert.deepEqual(
      [a.next(), a.int(1, 6), a.range(2, 3)],
      [b.next(), b.int(1, 6), b.range(2, 3)],
    );
    assert.throws(() => a.pick([]), RangeError);
  });
  test("pool reuses released objects", () => {
    const pool = new Pool(() => ({ v: 0 }), 2);
    const x = pool.acquire();
    pool.release(x);
    assert.equal(pool.acquire(), x);
    assert.equal(pool.created, 2);
  });
  test("bus: typed events, unsubscribe and AbortSignal", () => {
    const bus = new Bus<{ hit: { n: number } }>();
    const got: number[] = [];
    const off = bus.on("hit", (d) => got.push(d.n));
    const ac = new AbortController();
    bus.on("hit", (d) => got.push(d.n * 10), { signal: ac.signal });
    bus.emit("hit", { n: 1 });
    off();
    ac.abort();
    bus.emit("hit", { n: 2 });
    assert.deepEqual(got, [1, 10]);
  });
  test("bot produces valid controls and aims at the nearest ship", () => {
    const w = new World({ seed: 2 });
    const me = w.spawn(new Ship({ pos: new Vector2(400, 400), angle: 0 }));
    w.spawn(new Ship({ pos: new Vector2(700, 400) })); // straight ahead
    const c = new Bot({ skill: 0.2 }).next(me, w);
    assert.ok(c.turn >= -1 && c.turn <= 1);
    assert.equal(c.fire, true);
  });
  test("entity ids are write-once", () => {
    const w = new World();
    const s = w.spawn(new Ship({ pos: new Vector2() }));
    assert.throws(() => s.assignId(entityId(99)), /already has id/);
    assert.throws(() => new Ship({ pos: new Vector2() }).id, /not been spawned/);
    assert.equal(ARENA.width, 1600);
  });
});
