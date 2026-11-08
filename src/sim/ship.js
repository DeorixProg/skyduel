import { ARENA, wrapPosition } from "./arena.js";

/**
 * Biplane flight model. Everything here is plain data + pure functions:
 * no DOM, no canvas, no clock. Same state + same input + same dt ⇒ same result.
 *
 * Tuning notes (see README, "M2 — tuning"):
 *  - TURN_RATE 3.4 rad/s: a full circle in ~1.85 s; 5.0 felt twitchy, 2.5 sluggish.
 *  - THRUST 520 u/s² with DRAG 0.9 /s: reaches ~85% of max speed in ~2 s.
 *  - MAX_SPEED 420 u/s: crossing the 1600-wide arena takes ~4 s.
 */
export const SHIP = Object.freeze({
  TURN_RATE: 3.4,
  THRUST: 520,
  DRAG: 0.9,
  MAX_SPEED: 420,
  RADIUS: 18,
});

export function createShip(x = ARENA.width / 2, y = ARENA.height / 2, angle = -Math.PI / 2) {
  return { x, y, vx: 0, vy: 0, angle, thrust: false };
}

/** Pure: returns a NEW ship, never mutates the argument. */
export function integrate(ship, input, dt) {
  const angle = ship.angle + input.turn * SHIP.TURN_RATE * dt;
  let vx = ship.vx;
  let vy = ship.vy;

  if (input.thrust) {
    vx += Math.cos(angle) * SHIP.THRUST * dt;
    vy += Math.sin(angle) * SHIP.THRUST * dt;
  }

  // linear drag (explicit Euler — intentionally dt-dependent, see experiment 3)
  const k = Math.max(0, 1 - SHIP.DRAG * dt);
  vx *= k;
  vy *= k;

  const speed = Math.hypot(vx, vy);
  if (speed > SHIP.MAX_SPEED) {
    vx = (vx / speed) * SHIP.MAX_SPEED;
    vy = (vy / speed) * SHIP.MAX_SPEED;
  }

  return wrapPosition({
    x: ship.x + vx * dt,
    y: ship.y + vy * dt,
    vx,
    vy,
    angle: normalizeAngle(angle),
    thrust: input.thrust,
  });
}

export function normalizeAngle(a) {
  const TAU = Math.PI * 2;
  return ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

/** Shortest-path angle lerp: from 179° to -179° goes through 180°, not through 0°. */
export function lerpAngle(a, b, t) {
  let d = b - a;
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
