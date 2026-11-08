import assert from "node:assert/strict";
import { test } from "node:test";
import { type Input, playerId, type Seq, seq } from "@skyduel/shared/types.ts";
import { Match } from "../src/match.ts";

const arena = { balloons: 0, hunters: 0 };
const P1 = playerId(1);
const input = (n: number, turn = 0): Input => ({ seq: seq(n), thrust: true, turn, fire: false });

test("redundant inputs are de-duplicated and ack follows the applied seq", () => {
  const acks: Seq[] = [];
  const m = new Match({
    arena,
    seed: 1,
    onSnapshot: (_s, players) => {
      const p = players.get(P1);
      if (p) acks.push(p.ack);
    },
  });
  m.addPlayer(P1, "a");
  m.stop(); // drive ticks by hand
  m.onInputs(P1, [input(1)]);
  m.onInputs(P1, [input(1), input(2, 1)]);
  m.step();
  m.step();
  assert.deepEqual(acks, [1, 2]);
  m.step(); // starvation: no new input → last controls repeated, ack unchanged
  assert.equal(acks.at(-1), 2);
});

test("the input queue is capped (no speed-hack by flooding inputs)", () => {
  const m = new Match({ arena, seed: 1 });
  m.addPlayer(P1, "a");
  m.stop();
  m.onInputs(
    P1,
    Array.from({ length: 8 }, (_, i) => input(i + 1)),
  );
  const queue = m.players.get(P1)?.queue ?? [];
  assert.equal(queue.length, 3);
  assert.equal(queue[0]?.seq, 6);
});

test("the precise timer keeps ~30 ticks per second without drift", async () => {
  const m = new Match({ arena, seed: 1 });
  m.addPlayer(P1, "a");
  await new Promise((r) => setTimeout(r, 1000));
  m.stop();
  assert.ok(m.tick >= 29 && m.tick <= 31, `ticks in 1 s: ${m.tick}`);
});
