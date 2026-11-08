import { Bus } from "../bus.ts";
import { type EntityId, entityId, type Input, seq } from "../types.ts";
import { ARENA, wrapDelta } from "./arena.ts";
import { type CollisionSystem, naivePairs, resolveCollisions } from "./collision.ts";
import { dhypot } from "./dmath.ts";
import {
  type AnyEntity,
  Balloon,
  EFFECTS,
  type EntityKind,
  type EntityOfKind,
  IDLE,
  Pickup,
  type Ship,
} from "./entities.ts";
import type { Effect } from "./entity.ts";
import { homingSystem } from "./homing.ts";
import { createRng, type Rng } from "./rng.ts";
import { Vector2 } from "./vector.ts";

/** Everything the simulation announces. Audio, HUD and logs subscribe; the sim imports none of them. */
export interface SimEvents {
  fired: { by: EntityId };
  hit: { target: EntityId; by: EntityId | null; hp: number };
  shielded: { target: EntityId };
  exploded: { target: EntityId; by: EntityId | null };
  respawned: { target: EntityId };
  popped: { target: EntityId };
  pickup: { target: EntityId; effect: Effect };
}

function isKind<K extends EntityKind>(e: AnyEntity, kind: K): e is EntityOfKind<K> {
  return e.kind === kind;
}

/**
 * Entity manager over a Map<EntityId, AnyEntity>.
 *
 * - spawn() during a step goes to a pending list and is flushed after the
 *   update pass, so a bullet fired this step is not also moved this step.
 * - despawn() only marks `alive = false`; the sweep at the end of step()
 *   deletes. Deleting from a Map while iterating it is legal in JS, but it
 *   makes "who was updated this step" depend on insertion order.
 */
export class World {
  readonly #entities = new Map<EntityId, AnyEntity>();
  readonly #pending: AnyEntity[] = [];
  #stepping = false;
  #nextId = 1;
  readonly rng: Rng;
  collide: CollisionSystem;
  time = 0;
  readonly bus = new Bus<SimEvents>();
  lastCollisions = 0;
  pickupTimer = 6;

  constructor({
    seed = 1,
    collide = naivePairs,
  }: { seed?: number; collide?: CollisionSystem } = {}) {
    this.rng = createRng(seed);
    this.collide = collide; // swappable collision system
  }

  spawn<E extends AnyEntity>(entity: E): E {
    this.#invalidate();
    entity.assignId(entityId(this.#nextId++));
    entity.world = this;
    if (this.#stepping) this.#pending.push(entity);
    else this.#entities.set(entity.id, entity);
    return entity;
  }

  despawn(id: EntityId): void {
    const e = this.#entities.get(id) ?? this.#pending.find((p) => p.id === id);
    if (e) e.alive = false;
    this.#invalidate();
  }

  /** May be undefined: the entity can be gone (TypeScript makes callers handle it). */
  get(id: EntityId): AnyEntity | undefined {
    return this.#entities.get(id);
  }

  get size(): number {
    return this.#entities.size;
  }

  [Symbol.iterator](): IterableIterator<AnyEntity> {
    return this.#entities.values();
  }

  *ofKind<K extends EntityKind>(kind: K): Generator<EntityOfKind<K>> {
    for (const e of this.#entities.values()) {
      if (e.alive && isKind(e, kind)) yield e;
    }
  }

  /**
   * Live ships / balloons as ARRAYS, built at most once between changes (Lab 7):
   * 256 bots each walking the ofKind() generator over the whole Map was half of
   * the server tick. Invalidated on spawn, despawn and at every step.
   */
  #ships: Ship[] | null = null;
  #balloons: Balloon[] | null = null;
  #invalidate(): void {
    this.#ships = null;
    this.#balloons = null;
  }
  ships(): readonly Ship[] {
    this.#ships ??= [...this.ofKind("ship")];
    return this.#ships;
  }
  balloons(): readonly Balloon[] {
    this.#balloons ??= [...this.ofKind("balloon")];
    return this.#balloons;
  }

  emit<K extends keyof SimEvents>(type: K, detail: SimEvents[K]): void {
    this.bus.emit(type, detail);
  }

  /** One fixed step: inputs → update → homing → collisions → spawns → sweep. */
  step(dt: number, inputs: ReadonlyMap<EntityId, Input> = new Map()): void {
    this.#invalidate();
    this.#stepping = true;
    this.time += dt;
    for (const e of this.#entities.values()) {
      if (!e.alive) continue;
      e.prevPos = e.pos; // vectors are immutable, so keeping the reference is safe
      e.prevAngle = e.angle;
      if (e.kind === "ship") {
        const input = inputs.get(e.id);
        e.controls = input ?? e.controller?.(e, this) ?? IDLE;
        e.inputSeq = input?.seq ?? seq(0);
      }
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

  #sweep(): void {
    this.#invalidate();
    for (const [id, e] of this.#entities) if (!e.alive) this.#entities.delete(id);
  }

  #spawnPickups(dt: number): void {
    this.pickupTimer -= dt;
    if (this.pickupTimer > 0) return;
    this.pickupTimer = 9;
    let count = 0;
    for (const _ of this.ofKind("pickup")) count++;
    if (count >= 2) return;
    // ORDER MATTERS: both calls consume the seeded rng. Lab 6 first wrote this as one
    // object literal ({ pos: findSafeSpot(), effect: pick() }), which swapped the two
    // draws and changed every match after the first pickup — the determinism test caught it.
    const effect = this.rng.pick(EFFECTS);
    this.spawn(new Pickup({ pos: this.findSafeSpot(120), effect }));
  }

  /** A random point at least `clearance` away from every ship and balloon. */
  findSafeSpot(clearance: number): Vector2 {
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
        if (dhypot(dx, dy) < clearance + e.radius) {
          ok = false;
          break;
        }
      }
      if (ok) return p;
    }
    return new Vector2(ARENA.width / 2, ARENA.height / 2);
  }

  /** Populate the arena with balloons; a few are "hunters" with a homing component. */
  populate({ balloons = 7, hunters = 2 }: { balloons?: number; hunters?: number } = {}): void {
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
