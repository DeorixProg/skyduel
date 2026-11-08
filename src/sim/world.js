import { ARENA, wrapDelta } from "./arena.js";
import { naivePairs, resolveCollisions } from "./collision.js";
import { Balloon, IDLE, Pickup } from "./entities.js";
import { homingSystem } from "./homing.js";
import { createRng } from "./rng.js";
import { Vector2 } from "./vector.js";

/**
 * Entity manager over a Map<id, Entity>.
 *
 * - spawn() during a step goes to a pending list and is flushed after the
 *   update pass, so a bullet fired this step is not also moved this step.
 * - despawn() only marks `alive = false`; the sweep at the end of step()
 *   deletes. Deleting from a Map while iterating it is legal in JS, but it
 *   makes "who was updated this step" depend on insertion order.
 */
export class World {
  #entities = new Map();
  #pending = [];
  #stepping = false;

  constructor({ seed = 1, collide = naivePairs } = {}) {
    this.rng = createRng(seed);
    this.collide = collide; // swappable collision system
    this.time = 0;
    this.events = []; // drained by the game each frame (Lab 3 turns this into an EventTarget bus)
    this.lastCollisions = 0;
    this.pickupTimer = 6;
  }

  spawn(entity) {
    entity.world = this;
    if (this.#stepping) this.#pending.push(entity);
    else this.#entities.set(entity.id, entity);
    return entity;
  }

  despawn(id) {
    const e = this.#entities.get(id) ?? this.#pending.find((p) => p.id === id);
    if (e) e.alive = false;
  }

  get(id) {
    return this.#entities.get(id);
  }

  get size() {
    return this.#entities.size;
  }

  [Symbol.iterator]() {
    return this.#entities.values();
  }

  *ofKind(kind) {
    for (const e of this.#entities.values()) {
      if (e.alive && e.kind === kind) yield e;
    }
  }

  emit(type, detail = {}) {
    this.events.push({ type, t: this.time, ...detail });
  }

  /** One fixed step: inputs → update → homing → collisions → spawns → sweep. */
  step(dt, inputs = new Map()) {
    this.#stepping = true;
    this.time += dt;
    for (const e of this.#entities.values()) {
      if (!e.alive) continue;
      e.prevPos = e.pos; // vectors are immutable, so keeping the reference is safe
      e.prevAngle = e.angle;
      if (e.kind === "ship") e.controls = inputs.get(e.id) ?? e.controller?.(e, this) ?? IDLE;
      e.update(dt);
    }
    homingSystem(this, dt);
    this.lastCollisions = resolveCollisions(this, this.collide(this));
    this.#stepping = false;
    for (const e of this.#pending) this.#entities.set(e.id, e);
    this.#pending.length = 0;
    this.#spawnPickups(dt);
    this.#sweep();
  }

  #sweep() {
    for (const [id, e] of this.#entities) if (!e.alive) this.#entities.delete(id);
  }

  #spawnPickups(dt) {
    this.pickupTimer -= dt;
    if (this.pickupTimer > 0) return;
    this.pickupTimer = 9;
    if ([...this.ofKind("pickup")].length >= 2) return;
    const effect = this.rng.pick(["shield", "rapid", "homing"]);
    this.spawn(new Pickup({ pos: this.findSafeSpot(120), effect }));
  }

  /** A random point at least `clearance` away from every ship and balloon. */
  findSafeSpot(clearance) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const p = new Vector2(
        this.rng.range(60, ARENA.width - 60),
        this.rng.range(60, ARENA.height - 60),
      );
      let ok = true;
      for (const e of this.#entities.values()) {
        if (e.kind !== "ship" && e.kind !== "balloon") continue;
        const dx = wrapDelta(p.x, e.pos.x, ARENA.width);
        const dy = wrapDelta(p.y, e.pos.y, ARENA.height);
        if (Math.hypot(dx, dy) < clearance + e.radius) {
          ok = false;
          break;
        }
      }
      if (ok) return p;
    }
    return new Vector2(ARENA.width / 2, ARENA.height / 2);
  }

  /** Populate the arena with balloons; a few are "hunters" with a homing component. */
  populate({ balloons = 7, hunters = 2 } = {}) {
    for (let i = 0; i < balloons; i++) {
      const b = new Balloon({
        pos: this.findSafeSpot(150),
        vel: Vector2.fromAngle(this.rng.range(-Math.PI, Math.PI), this.rng.range(15, 45)),
        radius: this.rng.range(22, 32),
      });
      if (i < hunters) b.homing = { targetKind: "ship", turnRate: 0.6, range: 450, speed: 38 };
      this.spawn(b);
    }
  }
}
