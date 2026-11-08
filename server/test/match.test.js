import assert from "node:assert/strict";
import { test } from "node:test";
import { Match } from "../src/match.js";

const arena = { balloons: 0, hunters: 0 };

test("redundant inputs are de-duplicated and ack follows the applied seq", () => {
  const snaps = [];
  const m = new Match({
    arena,
    seed: 1,
    onSnapshot: (s, players) => snaps.push({ s, ack: players.get(1).ack }),
  });
  m.addPlayer(1, "a");
  m.stop(); // drive ticks by hand
  m.onInputs(1, [{ seq: 1, thrust: true, turn: 0, fire: false }]);
  m.onInputs(1, [
    { seq: 1, thrust: true, turn: 0, fire: false },
    { seq: 2, thrust: true, turn: 1, fire: false },
  ]);
  m.step();
  m.step();
  assert.deepEqual(
    snaps.map((x) => x.ack),
    [1, 2],
  );
  m.step(); // starvation: no new input → last controls repeated, ack unchanged
  assert.equal(snaps.at(-1).ack, 2);
});

test("the input queue is capped (no speed-hack by flooding inputs)", () => {
  const m = new Match({ arena, seed: 1 });
  m.addPlayer(1, "a");
  m.stop();
  m.onInputs(
    1,
    Array.from({ length: 8 }, (_, i) => ({ seq: i + 1, thrust: true, turn: 0, fire: false })),
  );
  assert.equal(m.players.get(1).queue.length, 3);
  assert.equal(m.players.get(1).queue[0].seq, 6);
});

test("the precise timer keeps ~30 ticks per second without drift", async () => {
  const m = new Match({ arena, seed: 1 });
  m.addPlayer(1, "a");
  await new Promise((r) => setTimeout(r, 1000));
  m.stop();
  assert.ok(m.tick >= 29 && m.tick <= 31, `ticks in 1 s: ${m.tick}`);
});
