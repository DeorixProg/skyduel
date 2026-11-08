import { ARENA, wrap } from "./arena.js";
import { Vector2 } from "./vector.js";

/**
 * Base entity. Every thing in the world is an Entity; behaviour that does not
 * fit a single class line (homing, being a pickup) is attached as COMPONENTS
 * (plain data on the entity) and executed by systems in World.step.
 */
export class Entity {
  // Lab 2 used a private STATIC counter here. Lab 5 broke it: the server runs
  // many worlds in one process, so ids depended on what other rooms had spawned,
  // and the same seed + inputs produced different ids on client and server.
  // Ids are now allocated by the owning World; #id stays private and write-once.
  #id = 0;

  constructor({ pos = new Vector2(), vel = new Vector2(), angle = 0, radius = 10, kind }) {
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
    this.kind = kind;
    this.alive = true;
    this.world = null; // set by World.spawn
    this.homing = null; // component: { targetKind, turnRate, range, speed }
    this.pickup = null; // component: { effect, duration }
  }

  get id() {
    return this.#id;
  }

  /** Called once by World.spawn. */
  assignId(id) {
    if (this.#id !== 0) throw new Error(`entity already has id ${this.#id}`);
    this.#id = id;
  }

  /** Default motion: straight line with arena wrap. Subclasses extend this. */
  update(dt) {
    this.pos = new Vector2(
      wrap(this.pos.x + this.vel.x * dt, ARENA.width),
      wrap(this.pos.y + this.vel.y * dt, ARENA.height),
    );
  }

  /** Called by the collision system; the default is "nothing happens". */
  onHit(_other) {}
}
