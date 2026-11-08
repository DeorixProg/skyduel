import { DT } from "./net/predict.ts";
import { dsin } from "./sim/dmath.ts";
import { Ship } from "./sim/entities.ts";
import { Vector2 } from "./sim/vector.ts";
import { World } from "./sim/world.ts";
import { hashSnapshot, takeSnapshot } from "./snapshot.ts";
import { seq, tick } from "./types.ts";

/**
 * A fixed scripted match used to compare runtimes: the same seed and inputs
 * must give the same state hash in Node and in the browser.
 */
export function scriptedRunHash(
  seed = 2026,
  steps = 1000,
): { steps: number; entities: number; hash: string } {
  const w = new World({ seed });
  const a = w.spawn(new Ship({ pos: new Vector2(400, 450), name: "a" }));
  const b = w.spawn(new Ship({ pos: new Vector2(1200, 450), angle: Math.PI, name: "b" }));
  w.populate({ balloons: 8, hunters: 3 });
  for (let i = 0; i < steps; i++) {
    w.step(
      DT,
      new Map([
        [a.id, { seq: seq(i + 1), thrust: i % 90 < 60, turn: dsin(i / 20), fire: i % 7 === 0 }],
        [b.id, { seq: seq(i + 1), thrust: true, turn: -0.4, fire: i % 11 === 0 }],
      ]),
    );
  }
  return { steps, entities: w.size, hash: hashSnapshot(takeSnapshot(w, tick(steps))) };
}

/** Per-step hashes, to find the first step where two runtimes diverge. */
export function stepHashes(seed = 2026, steps = 1000, every = 10): string[] {
  const w = new World({ seed });
  const a = w.spawn(new Ship({ pos: new Vector2(400, 450), name: "a" }));
  const b = w.spawn(new Ship({ pos: new Vector2(1200, 450), angle: Math.PI, name: "b" }));
  w.populate({ balloons: 8, hunters: 3 });
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    w.step(
      DT,
      new Map([
        [a.id, { seq: seq(i + 1), thrust: i % 90 < 60, turn: dsin(i / 20), fire: i % 7 === 0 }],
        [b.id, { seq: seq(i + 1), thrust: true, turn: -0.4, fire: i % 11 === 0 }],
      ]),
    );
    if (i % every === 0) out.push(hashSnapshot(takeSnapshot(w, tick(i))));
  }
  return out;
}
