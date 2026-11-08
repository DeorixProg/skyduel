export interface Rng {
  next(): number;
  range(min: number, max: number): number;
  int(min: number, max: number): number;
  /** Throws on an empty array instead of returning `undefined` (noUncheckedIndexedAccess). */
  pick<T>(items: readonly T[]): T;
}

/**
 * mulberry32: a tiny seeded PRNG. The simulation never calls Math.random(),
 * so a run is reproducible from its seed (the server sends the seed).
 */
export function createRng(seed = 1): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    pick<T>(items: readonly T[]): T {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new RangeError("pick() from an empty array");
      return item;
    },
  };
}
