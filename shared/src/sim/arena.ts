/** Arena: a fixed-size world in "world units"; the camera scales it to the window. */
export const ARENA = Object.freeze({ width: 1600, height: 900 });
export type Arena = typeof ARENA;

/** Toroidal wrap: leaving one edge enters from the opposite one. */
export function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}

export function wrapPosition<T extends { x: number; y: number }>(body: T, arena: Arena = ARENA): T {
  return { ...body, x: wrap(body.x, arena.width), y: wrap(body.y, arena.height) };
}

/** Shortest signed distance on a wrapped axis (used for interpolation across the edge). */
export function wrapDelta(from: number, to: number, size: number): number {
  let d = to - from;
  if (d > size / 2) d -= size;
  else if (d < -size / 2) d += size;
  return d;
}
