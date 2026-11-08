import { ARENA, wrap } from "./arena.js";
import { Vector2 } from "./vector.js";

/**
 * Base entity. Every thing in the world is an Entity; behaviour that does not
 * fit a single class line (homing, being a pickup) is attached as COMPONENTS
 * (plain data on the entity) and executed by systems in World.step.
 */
export class Entity {
  static #nextId = 1; // private static counter: nobody can reset or forge ids
  #id;

  constructor({ pos = new Vector2(), vel = new Vector2(), angle = 0, radius = 10, kind }) {
    this.#id = Entity.#nextId++;
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

  /** Default motion: straight line with arena wrap. Subclasses extend this. */
  update(dt) {
    this.pos = new Vector2(
      wrap(this.pos.x + this.vel.x * dt, ARENA.width),
      wrap(this.pos.y + this.vel.y * dt, ARENA.height),
    );
  }

  /** Called by the collision system; the default is "nothing happens". */
  onHit(_other) {}

  static resetIds() {
    Entity.#nextId = 1;
  }
}
