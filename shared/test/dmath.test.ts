import assert from "node:assert/strict";
import { test } from "node:test";
import { datan2, dcos, dhypot, dsin } from "../src/sim/dmath.ts";

test("dsin/dcos match Math within 1e-12 on [-50, 50]", () => {
  let max = 0;
  for (let x = -50; x <= 50; x += 0.0137) {
    max = Math.max(max, Math.abs(dsin(x) - Math.sin(x)), Math.abs(dcos(x) - Math.cos(x)));
  }
  assert.ok(max < 1e-12, `max error ${max}`);
});

test("datan2 matches Math.atan2 within 1e-14 in all quadrants", () => {
  let max = 0;
  for (let a = -Math.PI; a < Math.PI; a += 0.001) {
    for (const r of [0.001, 1, 1234]) {
      const y = r * Math.sin(a);
      const x = r * Math.cos(a);
      max = Math.max(max, Math.abs(datan2(y, x) - Math.atan2(y, x)));
    }
  }
  assert.ok(max < 1e-14, `max error ${max}`);
  assert.equal(datan2(0, 0), 0);
  assert.equal(datan2(1, 0), Math.PI / 2);
});

test("dhypot", () => {
  assert.equal(dhypot(3, 4), 5);
});
