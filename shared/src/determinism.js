import { DT } from "./net/predict.js";
import { dsin } from "./sim/dmath.js";
import { Ship } from "./sim/entities.js";
import { Vector2 } from "./sim/vector.js";
import { World } from "./sim/world.js";
import { hashSnapshot, takeSnapshot } from "./snapshot.js";

/**
 * A fixed scripted match used to compare runtimes: the same seed and inputs
 * must give the same state hash in Node and in the browser.
 */
export function scriptedRunHash(seed = 2026, steps = 1000) {
  const w = new World({ seed });
  const a = w.spawn(new Ship({ pos: new Vector2(400, 450), name: "a" }));
  const b = w.spawn(new Ship({ pos: new Vector2(1200, 450), angle: Math.PI, name: "b" }));
  w.populate({ balloons: 8, hunters: 3 });
  for (let i = 0; i < steps; i++) {
    w.step(
      DT,
      new Map([
        [a.id, { seq: i + 1, thrust: i % 90 < 60, turn: dsin(i / 20), fire: i % 7 === 0 }],
        [b.id, { seq: i + 1, thrust: true, turn: -0.4, fire: i % 11 === 0 }],
      ]),
    );
  }
  return { steps, entities: w.size, hash: hashSnapshot(takeSnapshot(w, steps)) };
}

/** Per-step hashes, to find the first step where two runtimes diverge. */
export function stepHashes(seed = 2026, steps = 1000, every = 10) {
  const w = new World({ seed });
  const a = w.spawn(new Ship({ pos: new Vector2(400, 450), name: "a" }));
  const b = w.spawn(new Ship({ pos: new Vector2(1200, 450), angle: Math.PI, name: "b" }));
  w.populate({ balloons: 8, hunters: 3 });
  const out = [];
  for (let i = 0; i < steps; i++) {
    w.step(
      DT,
      new Map([
        [a.id, { seq: i + 1, thrust: i % 90 < 60, turn: dsin(i / 20), fire: i % 7 === 0 }],
        [b.id, { seq: i + 1, thrust: true, turn: -0.4, fire: i % 11 === 0 }],
      ]),
    );
    if (i % every === 0) out.push(hashSnapshot(takeSnapshot(w, i)));
  }
  return out;
}
