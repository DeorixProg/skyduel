import { ARENA, wrapDelta } from "./sim/arena.ts";
import { datan2, dhypot } from "./sim/dmath.ts";
import type { Ship } from "./sim/entities.ts";
import type { World } from "./sim/world.ts";
import type { Controls } from "./types.ts";

/**
 * A bot is just a source of Controls — the SAME interface a human produces
 * from the keyboard. The server feeds its output through the same input
 * queue as a socket, so it cannot tell bots from people. Pure and
 * deterministic (dmath only), so it also runs headless in the load test.
 */
export interface PlayerInput {
  next(ship: Ship, world: World): Controls;
}

function normalize(a: number): number {
  let d = a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class Bot implements PlayerInput {
  readonly #skill: number;
  #phase: number;

  constructor({ skill = 0.15, phase = 0 }: { skill?: number; phase?: number } = {}) {
    this.#skill = skill; // aim tolerance in radians: lower = better shooter
    this.#phase = phase;
  }

  next(ship: Ship, world: World): Controls {
    this.#phase++;
    // evade: a balloon close ahead → turn away and keep the throttle
    for (const b of world.balloons()) {
      const dx = wrapDelta(ship.pos.x, b.pos.x, ARENA.width);
      const dy = wrapDelta(ship.pos.y, b.pos.y, ARENA.height);
      if (dhypot(dx, dy) < b.radius + 70) {
        const off = normalize(datan2(dy, dx) - ship.angle);
        if (Math.abs(off) < 1.2) return { thrust: true, turn: off > 0 ? -1 : 1, fire: false };
      }
    }
    // chase: nearest live ship that is not us
    let target: Ship | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const s of world.ships()) {
      if (s === ship || s.down) continue;
      const d = dhypot(
        wrapDelta(ship.pos.x, s.pos.x, ARENA.width),
        wrapDelta(ship.pos.y, s.pos.y, ARENA.height),
      );
      if (d < best) {
        best = d;
        target = s;
      }
    }
    if (!target) return { thrust: this.#phase % 120 < 80, turn: 0.4, fire: false }; // patrol
    const dx = wrapDelta(ship.pos.x, target.pos.x, ARENA.width);
    const dy = wrapDelta(ship.pos.y, target.pos.y, ARENA.height);
    const off = normalize(datan2(dy, dx) - ship.angle);
    return {
      thrust: best > 160,
      turn: Math.max(-1, Math.min(1, off * 3)),
      fire: Math.abs(off) < this.#skill && best < 520,
    };
  }
}
