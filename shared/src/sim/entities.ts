import { type Controls, type EntityId, type Seq, seq } from "../types.ts";
import { ARENA, wrap } from "./arena.ts";
import { dcos, dsin } from "./dmath.ts";
import { type Effect, Entity, type EntityInit } from "./entity.ts";
import type { Rng } from "./rng.ts";
import { integrate, SHIP } from "./ship.ts";
import { Vector2 } from "./vector.ts";
import type { World } from "./world.ts";

export const BULLET = Object.freeze({ SPEED: 640, TTL: 1.1, DAMAGE: 25, RADIUS: 3 });
export const COOLDOWN = Object.freeze({ normal: 0.22, rapid: 0.08 });
export const RESPAWN_DELAY = 2;
export const EFFECTS: readonly Effect[] = ["shield", "rapid", "homing"];
export const IDLE: Controls & { seq: Seq } = Object.freeze({
  thrust: false,
  turn: 0,
  fire: false,
  seq: seq(0),
});

/** Every concrete entity. `kind` is the discriminant: `if (e.kind === "ship")` narrows to Ship. */
export type AnyEntity = Ship | Bullet | Balloon | Pickup | Explosion;
export type EntityKind = AnyEntity["kind"];
export type EntityOfKind<K extends EntityKind> = Extract<AnyEntity, { kind: K }>;

/** Entities that can take damage. */
type Damageable = Ship | Balloon;

/** A controller drives a ship from code (training drone, bots): same Controls as a human. */
export type Controller = (ship: Ship, world: World) => Controls;

/** Biplane: the only subclass with real logic. One level of `extends`, no deeper. */
export class Ship extends Entity {
  readonly kind = "ship";
  #hp: number = SHIP.MAX_HP;
  #cooldown = 0;
  name: string;
  color: string;
  thrust = false;
  score = 0;
  down = false; // shot down, waiting for respawn
  respawnIn = 0;
  controls: Controls & { seq?: Seq } = IDLE;
  controller: Controller | null = null;
  inputSeq: Seq = seq(0); // seq of the input applied in the current step
  readonly effects = new Map<Effect, number>(); // effect → seconds left

  constructor({
    pos,
    angle = 0,
    name = "pilot",
    color = "#c0392b",
  }: EntityInit & { name?: string; color?: string }) {
    super({ pos, angle, radius: SHIP.RADIUS });
    this.name = name;
    this.color = color;
  }

  get hp(): number {
    return this.#hp;
  }

  override update(dt: number): void {
    if (this.down) {
      this.respawnIn -= dt;
      if (this.respawnIn <= 0) this.respawn();
      return;
    }
    const body = integrate(
      {
        x: this.pos.x,
        y: this.pos.y,
        vx: this.vel.x,
        vy: this.vel.y,
        angle: this.angle,
        thrust: this.thrust,
      },
      this.controls,
      dt,
    );
    this.pos = new Vector2(body.x, body.y);
    this.vel = new Vector2(body.vx, body.vy);
    this.angle = body.angle;
    this.thrust = body.thrust;

    this.#cooldown = Math.max(0, this.#cooldown - dt);
    if (this.controls.fire) this.fire();

    for (const [name, left] of this.effects) {
      if (left - dt <= 0) this.effects.delete(name);
      else this.effects.set(name, left - dt);
    }
  }

  /**
   * Spawns a bullet at the nose with the ship's velocity added.
   * Uses `this` heavily — which is why passing `ship.fire` around as a bare
   * function breaks (see README, Lab 2 "The this bug").
   */
  fire(this: Ship): Bullet | null {
    if (this.down || this.#cooldown > 0) return null;
    this.#cooldown = this.effects.has("rapid") ? COOLDOWN.rapid : COOLDOWN.normal;
    const nose = this.pos.add(Vector2.fromAngle(this.angle, this.radius + 6));
    const bullet = new Bullet({
      pos: nose,
      vel: this.vel.add(Vector2.fromAngle(this.angle, BULLET.SPEED)),
      ownerId: this.id,
      seq: this.inputSeq, // which input fired it: lets the client match its predicted bullet
    });
    if (this.effects.has("homing")) {
      bullet.homing = { targetKind: "ship", turnRate: 4, range: 380, speed: BULLET.SPEED };
    }
    this.w.spawn(bullet);
    this.w.emit("fired", { by: this.id });
    return bullet;
  }

  damage(amount: number, attacker: Ship | null): void {
    if (this.down) return;
    if (this.effects.has("shield")) {
      this.w.emit("shielded", { target: this.id });
      return;
    }
    this.#hp -= amount;
    this.w.emit("hit", { target: this.id, by: attacker?.id ?? null, hp: this.#hp });
    if (this.#hp <= 0) this.#destroy(attacker);
  }

  #destroy(attacker: Ship | null): void {
    this.down = true;
    this.respawnIn = RESPAWN_DELAY;
    this.vel = new Vector2();
    this.effects.clear();
    if (attacker && attacker !== this) attacker.score += 1;
    this.w.spawn(new Explosion({ pos: this.pos, rng: this.w.rng, size: 1 }));
    this.w.emit("exploded", { target: this.id, by: attacker?.id ?? null });
  }

  respawn(): void {
    this.#hp = SHIP.MAX_HP;
    this.down = false;
    this.pos = this.w.findSafeSpot(220);
    this.vel = new Vector2();
    this.angle = this.w.rng.range(-Math.PI, Math.PI);
    this.effects.set("shield", 1.5); // spawn protection
    this.w.emit("respawned", { target: this.id });
  }

  override onHit(other: AnyEntity): void {
    if (this.down) return;
    if (other.kind === "balloon") {
      this.damage(SHIP.COLLISION_DAMAGE, null);
    } else if (other.kind === "ship" && !other.down) {
      this.damage(SHIP.COLLISION_DAMAGE, other); // mid-air collision hurts both
    }
  }
}

export class Bullet extends Entity {
  readonly kind = "bullet";
  readonly ownerId: EntityId;
  readonly seq: Seq;
  ttl: number = BULLET.TTL;

  constructor({
    pos,
    vel,
    ownerId,
    seq: s,
  }: { pos: Vector2; vel: Vector2; ownerId: EntityId; seq: Seq }) {
    super({ pos, vel, angle: vel.angle(), radius: BULLET.RADIUS });
    this.ownerId = ownerId;
    this.seq = s;
  }

  override update(dt: number): void {
    super.update(dt);
    this.angle = this.vel.angle();
    this.ttl -= dt;
    if (this.ttl <= 0) this.w.despawn(this.id);
  }

  override onHit(other: AnyEntity): void {
    if (other.id === this.ownerId || other.kind === "bullet" || other.pickup) return;
    if (other.kind === "ship" && other.down) return;
    if (!isDamageable(other)) return;
    const owner = this.w.get(this.ownerId);
    other.damage(BULLET.DAMAGE, owner?.kind === "ship" ? owner : null);
    this.w.despawn(this.id);
  }
}

function isDamageable(e: AnyEntity): e is Damageable {
  return e.kind === "ship" || e.kind === "balloon";
}

/** Barrage balloon (the "asteroid" of this theme): drifts, bounces, pops after 3 hits. */
export class Balloon extends Entity {
  readonly kind = "balloon";
  #hp = 3;

  constructor({ pos, vel, radius = 26 }: EntityInit) {
    super({ pos, vel, radius });
  }

  get hp(): number {
    return this.#hp;
  }

  damage(amount: number, _attacker: Ship | null): void {
    if (!this.alive) return;
    this.#hp -= Math.max(1, Math.round(amount / BULLET.DAMAGE)); // one bullet = one hit
    if (this.#hp > 0) return;
    const w = this.w;
    w.despawn(this.id); // balloons give no score, only (sometimes) a pickup
    w.spawn(new Explosion({ pos: this.pos, rng: w.rng, size: 0.6 }));
    w.emit("popped", { target: this.id });
    if (w.rng.next() < 0.5) w.spawn(new Pickup({ pos: this.pos, effect: w.rng.pick(EFFECTS) }));
  }

  override onHit(other: AnyEntity): void {
    if (other.kind === "balloon") {
      // elastic bounce of equal masses: swap the velocity components along the normal
      const n = other.pos.sub(this.pos).normalize();
      const rel = this.vel.sub(other.vel).dot(n);
      if (rel > 0) {
        this.vel = this.vel.sub(n.scale(rel));
        other.vel = other.vel.add(n.scale(rel));
      }
    } else if (other.kind === "ship" && !other.down) {
      this.damage(BULLET.DAMAGE * 3, null); // a plane flying into a balloon pops it
    }
  }
}

/**
 * Pickup: stationary, collidable, not a ship. The behaviour lives in the
 * `pickup` COMPONENT; this class is only a convenient constructor.
 */
export class Pickup extends Entity {
  readonly kind = "pickup";
  ttl = 15;

  constructor({ pos, effect, duration = 8 }: { pos: Vector2; effect: Effect; duration?: number }) {
    super({ pos, radius: 14 });
    this.pickup = { effect, duration };
  }

  override update(dt: number): void {
    this.angle += dt; // spins in place; no movement
    this.ttl -= dt;
    if (this.ttl <= 0) this.w.despawn(this.id);
  }
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

/** Short-lived particle burst. Many small objects — remember this for Lab 7. */
export class Explosion extends Entity {
  readonly kind = "explosion";
  ttl = 0.9;
  readonly particles: Particle[];

  constructor({ pos, rng, size = 1 }: { pos: Vector2; rng: Rng; size?: number }) {
    super({ pos, radius: 0 });
    this.collidable = false;
    this.particles = Array.from({ length: Math.round(28 * size) }, () => {
      const a = rng.range(-Math.PI, Math.PI);
      const s = rng.range(40, 220) * size;
      return { x: pos.x, y: pos.y, vx: dcos(a) * s, vy: dsin(a) * s, r: rng.range(2, 5) };
    });
  }

  override update(dt: number): void {
    for (const p of this.particles) {
      p.x = wrap(p.x + p.vx * dt, ARENA.width);
      p.y = wrap(p.y + p.vy * dt, ARENA.height);
      p.vx *= 1 - 2 * dt;
      p.vy *= 1 - 2 * dt;
    }
    this.ttl -= dt;
    if (this.ttl <= 0) this.w.despawn(this.id);
  }
}
