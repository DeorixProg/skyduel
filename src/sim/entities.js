import { ARENA, wrap } from "./arena.js";
import { Entity } from "./entity.js";
import { integrate, SHIP } from "./ship.js";
import { Vector2 } from "./vector.js";

export const BULLET = Object.freeze({ SPEED: 640, TTL: 1.1, DAMAGE: 25, RADIUS: 3 });
export const COOLDOWN = Object.freeze({ normal: 0.22, rapid: 0.08 });
export const RESPAWN_DELAY = 2;
const IDLE = Object.freeze({ thrust: false, turn: 0, fire: false });

/** Biplane: the only subclass with real logic. One level of `extends`, no deeper. */
export class Ship extends Entity {
  #hp = SHIP.MAX_HP;
  #cooldown = 0;

  constructor({ pos, angle = 0, name = "pilot", color = "#c0392b" }) {
    super({ pos, angle, radius: SHIP.RADIUS, kind: "ship" });
    this.name = name;
    this.color = color;
    this.thrust = false;
    this.score = 0;
    this.down = false; // shot down, waiting for respawn
    this.respawnIn = 0;
    this.controls = IDLE;
    this.controller = null; // optional (ship, world) => controls, used by the training drone
    this.effects = new Map(); // effect name -> seconds left (shield, rapid, homing)
  }

  get hp() {
    return this.#hp;
  }

  update(dt) {
    if (this.down) {
      this.respawnIn -= dt;
      if (this.respawnIn <= 0) this.respawn();
      return;
    }
    const body = integrate(
      { x: this.pos.x, y: this.pos.y, vx: this.vel.x, vy: this.vel.y, angle: this.angle },
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
   * Uses `this` heavily — which is exactly why passing `ship.fire` around
   * as a bare function breaks (see README, "The this bug").
   */
  fire() {
    if (this.down || this.#cooldown > 0) return null;
    this.#cooldown = this.effects.has("rapid") ? COOLDOWN.rapid : COOLDOWN.normal;
    const nose = this.pos.add(Vector2.fromAngle(this.angle, this.radius + 6));
    const bullet = new Bullet({
      pos: nose,
      vel: this.vel.add(Vector2.fromAngle(this.angle, BULLET.SPEED)),
      ownerId: this.id,
    });
    if (this.effects.has("homing")) {
      bullet.homing = { targetKind: "ship", turnRate: 4, range: 380, speed: BULLET.SPEED };
    }
    this.world.spawn(bullet);
    this.world.emit("fired", { by: this.id });
    return bullet;
  }

  damage(amount, attacker) {
    if (this.down) return;
    if (this.effects.has("shield")) {
      this.world.emit("shielded", { target: this.id });
      return;
    }
    this.#hp -= amount;
    this.world.emit("hit", { target: this.id, by: attacker?.id ?? 0, hp: this.#hp });
    if (this.#hp <= 0) this.#destroy(attacker);
  }

  #destroy(attacker) {
    this.down = true;
    this.respawnIn = RESPAWN_DELAY;
    this.vel = new Vector2();
    this.effects.clear();
    if (attacker && attacker !== this) attacker.score += 1;
    this.world.spawn(new Explosion({ pos: this.pos, rng: this.world.rng, size: 1 }));
    this.world.emit("exploded", { target: this.id, by: attacker?.id ?? 0 });
  }

  respawn() {
    this.#hp = SHIP.MAX_HP;
    this.down = false;
    this.pos = this.world.findSafeSpot(220);
    this.vel = new Vector2();
    this.angle = this.world.rng.range(-Math.PI, Math.PI);
    this.effects.set("shield", 1.5); // spawn protection
    this.world.emit("respawned", { target: this.id });
  }

  onHit(other) {
    if (this.down) return;
    if (other.kind === "balloon") {
      this.damage(SHIP.COLLISION_DAMAGE, null);
    } else if (other.kind === "ship" && !other.down) {
      this.damage(SHIP.COLLISION_DAMAGE, other); // mid-air collision hurts both
    }
  }
}

export class Bullet extends Entity {
  constructor({ pos, vel, ownerId }) {
    super({ pos, vel, angle: vel.angle(), radius: BULLET.RADIUS, kind: "bullet" });
    this.ownerId = ownerId;
    this.ttl = BULLET.TTL;
  }

  update(dt) {
    super.update(dt);
    this.angle = this.vel.angle();
    this.ttl -= dt;
    if (this.ttl <= 0) this.world.despawn(this.id);
  }

  onHit(other) {
    if (other.id === this.ownerId || other.kind === "bullet" || other.pickup) return;
    if (other.kind === "ship" && other.down) return;
    const owner = this.world.get(this.ownerId);
    if (typeof other.damage === "function") other.damage(BULLET.DAMAGE, owner);
    this.world.despawn(this.id);
  }
}

/** Barrage balloon (the "asteroid" of this theme): drifts, bounces, pops after 3 hits. */
export class Balloon extends Entity {
  #hp = 3;

  constructor({ pos, vel, radius = 26 }) {
    super({ pos, vel, radius, kind: "balloon" });
  }

  get hp() {
    return this.#hp;
  }

  damage(amount, _attacker) {
    if (!this.alive) return;
    this.#hp -= Math.max(1, Math.round(amount / BULLET.DAMAGE)); // one bullet = one hit
    if (this.#hp > 0) return;
    this.world.despawn(this.id); // balloons give no score, only (sometimes) a pickup
    this.world.spawn(new Explosion({ pos: this.pos, rng: this.world.rng, size: 0.6 }));
    this.world.emit("popped", { target: this.id });
    if (this.world.rng.next() < 0.5) {
      const effect = this.world.rng.pick(["shield", "rapid", "homing"]);
      this.world.spawn(new Pickup({ pos: this.pos, effect }));
    }
  }

  onHit(other) {
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
 * `pickup` COMPONENT, so the pickup system would treat any entity carrying it
 * the same way; this class is only a convenient constructor.
 */
export class Pickup extends Entity {
  constructor({ pos, effect, duration = 8 }) {
    super({ pos, radius: 14, kind: "pickup" });
    this.pickup = { effect, duration };
    this.ttl = 15;
  }

  update(dt) {
    this.angle += dt; // spins in place; no movement
    this.ttl -= dt;
    if (this.ttl <= 0) this.world.despawn(this.id);
  }
}

/** Short-lived particle burst. Many small objects — remember this for Lab 7. */
export class Explosion extends Entity {
  constructor({ pos, rng, size = 1 }) {
    super({ pos, radius: 0, kind: "explosion" });
    this.collidable = false;
    this.ttl = 0.9;
    this.particles = Array.from({ length: Math.round(28 * size) }, () => {
      const a = rng.range(-Math.PI, Math.PI);
      const s = rng.range(40, 220) * size;
      return { x: pos.x, y: pos.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: rng.range(2, 5) };
    });
  }

  update(dt) {
    for (const p of this.particles) {
      p.x = wrap(p.x + p.vx * dt, ARENA.width);
      p.y = wrap(p.y + p.vy * dt, ARENA.height);
      p.vx *= 1 - 2 * dt;
      p.vy *= 1 - 2 * dt;
    }
    this.ttl -= dt;
    if (this.ttl <= 0) this.world.despawn(this.id);
  }
}

export { IDLE };
