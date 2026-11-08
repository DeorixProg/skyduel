import type { EntityId } from "../types.ts";
import { ARENA, wrap } from "./arena.ts";
import type { AnyEntity, EntityKind } from "./entities.ts";
import { Vector2 } from "./vector.ts";
import type { World } from "./world.ts";

export type Effect = "shield" | "rapid" | "homing";

/** Component: steer towards the nearest entity of `targetKind`. */
export interface Homing {
  readonly targetKind: EntityKind;
  readonly turnRate: number;
  readonly range: number;
  readonly speed: number;
}

/** Component: touching it grants `effect` to a ship for `duration` seconds. */
export interface PickupComponent {
  readonly effect: Effect;
  readonly duration: number;
}

export interface EntityInit {
  pos?: Vector2;
  vel?: Vector2;
  angle?: number;
  radius?: number;
}

/**
 * Base entity. Behaviour that does not fit one class line (homing, being a
 * pickup) is attached as COMPONENTS and executed by systems in World.step.
 */
export abstract class Entity {
  // Lab 2 used a private STATIC counter; Lab 5 moved id allocation into World
  // (several worlds share one server process). #id is private and write-once.
  #id: EntityId | null = null;
  abstract readonly kind: EntityKind;
  pos: Vector2;
  vel: Vector2;
  angle: number;
  radius: number;
  alive = true;
  collidable = true;
  world: World | null = null; // set by World.spawn
  homing: Homing | null = null;
  pickup: PickupComponent | null = null;
  prevPos: Vector2 | null = null; // for render interpolation
  prevAngle = 0;

  constructor({ pos = new Vector2(), vel = new Vector2(), angle = 0, radius = 10 }: EntityInit) {
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
  }

  get id(): EntityId {
    if (this.#id === null) throw new Error("entity has not been spawned yet");
    return this.#id;
  }

  /** Called once by World.spawn. */
  assignId(id: EntityId): void {
    if (this.#id !== null) throw new Error(`entity already has id ${this.#id}`);
    this.#id = id;
  }

  /** The world this entity lives in; throws if used before spawn. */
  protected get w(): World {
    if (!this.world) throw new Error(`${this.kind} is not in a world`);
    return this.world;
  }

  /** Default motion: straight line with arena wrap. Subclasses extend this. */
  update(dt: number): void {
    this.pos = new Vector2(
      wrap(this.pos.x + this.vel.x * dt, ARENA.width),
      wrap(this.pos.y + this.vel.y * dt, ARENA.height),
    );
  }

  /** Called by the collision system; the default is "nothing happens". */
  onHit(_other: AnyEntity): void {}
}
