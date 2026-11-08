import { ARENA } from "./arena.ts";
import { overlaps, type Pair } from "./collision.ts";
import type { AnyEntity } from "./entities.ts";
import type { World } from "./world.ts";

/**
 * Spatial hash broad phase (Lab 7): the arena is cut into CELL×CELL cells; an
 * entity is tested only against entities in its own and the 8 neighbouring
 * cells (with wrap-around). CELL must be ≥ the largest possible r_a + r_b
 * (balloon 32 + balloon 32 = 64), so no overlapping pair is ever missed.
 *
 * Determinism: pairs are returned in exactly the order naivePairs() would
 * produce them (sorted by the entities' iteration index), so swapping the
 * collision system does not change the simulation by a single bit.
 */
export const CELL = 100; // 1600×900 → 16×9 cells, divides the arena exactly
const COLS = ARENA.width / CELL;
const ROWS = ARENA.height / CELL;

const list: AnyEntity[] = [];
const cells: number[][] = Array.from({ length: COLS * ROWS }, () => []);
const found: number[] = []; // flat pairs of indices: i0, j0, i1, j1, …

export function* spatialHashPairs(world: World): Generator<Pair> {
  list.length = 0;
  for (const cell of cells) cell.length = 0;
  for (const e of world) if (e.alive && e.collidable) list.push(e);
  const cellOf = new Int32Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e) continue;
    const cx = Math.floor(e.pos.x / CELL) % COLS;
    const cy = Math.floor(e.pos.y / CELL) % ROWS;
    const c = cy * COLS + cx;
    cellOf[i] = c;
    cells[c]?.push(i);
  }
  found.length = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a) continue;
    const c = cellOf[i] ?? 0;
    const cx = c % COLS;
    const cy = (c - cx) / COLS;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = (cx + dx + COLS) % COLS;
        const ny = (cy + dy + ROWS) % ROWS;
        for (const j of cells[ny * COLS + nx] ?? []) {
          if (j <= i) continue; // each unordered pair once, i < j like naivePairs
          const b = list[j];
          if (b && overlaps(a, b)) found.push(i, j);
        }
      }
    }
  }
  // restore naivePairs order: by i, then by j
  const order = Array.from({ length: found.length / 2 }, (_, k) => k);
  order.sort(
    (p, q) =>
      (found[2 * p] ?? 0) - (found[2 * q] ?? 0) ||
      (found[2 * p + 1] ?? 0) - (found[2 * q + 1] ?? 0),
  );
  for (const k of order) {
    const a = list[found[2 * k] ?? -1];
    const b = list[found[2 * k + 1] ?? -1];
    if (a && b) yield [a, b];
  }
}
