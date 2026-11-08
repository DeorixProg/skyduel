/**
 * Deterministic math for the simulation.
 *
 * Found in Lab 5: Math.sin/cos/atan2/exp give DIFFERENT last bits in Node 26
 * (V8 14.6) and Chrome 156 — the spec only requires them to be
 * "implementation-approximated". The same seed and inputs then diverged after
 * 10 steps. +, −, ×, ÷, Math.sqrt, Math.round and Math.abs ARE exactly
 * specified by IEEE 754, so these functions use only those: same bits on
 * every engine, at ~1e-14 accuracy (far below anything visible).
 */
const PI = Math.PI;
const HALF_PI = PI / 2;
// Cody–Waite split of π/2 for an accurate range reduction
const HALF_PI_HI = 1.5707963267341256;
const HALF_PI_LO = 6.077100506506192e-11;

function sinPoly(r: number): number {
  const r2 = r * r;
  return (
    r +
    r *
      r2 *
      (-1 / 6 +
        r2 *
          (1 / 120 +
            r2 * (-1 / 5040 + r2 * (1 / 362880 + r2 * (-1 / 39916800 + r2 * (1 / 6227020800))))))
  );
}

function cosPoly(r: number): number {
  const r2 = r * r;
  return (
    1 +
    r2 *
      (-1 / 2 +
        r2 *
          (1 / 24 +
            r2 * (-1 / 720 + r2 * (1 / 40320 + r2 * (-1 / 3628800 + r2 * (1 / 479001600))))))
  );
}

/** Reduce x to r ∈ [−π/4, π/4] and the quadrant q ∈ {0,1,2,3}. */
function reduce(x: number): { r: number; q: number } {
  const k = Math.round(x / HALF_PI);
  const r = x - k * HALF_PI_HI - k * HALF_PI_LO;
  return { r, q: ((k % 4) + 4) % 4 };
}

export function dsin(x: number): number {
  const { r, q } = reduce(x);
  if (q === 0) return sinPoly(r);
  if (q === 1) return cosPoly(r);
  if (q === 2) return -sinPoly(r);
  return -cosPoly(r);
}

export function dcos(x: number): number {
  const { r, q } = reduce(x);
  if (q === 0) return cosPoly(r);
  if (q === 1) return -sinPoly(r);
  if (q === 2) return -cosPoly(r);
  return sinPoly(r);
}

/** atan for |z| ≤ tan(π/8) by its Taylor series (24 terms → error < 1e-16). */
function atanSmall(z: number): number {
  const z2 = z * z;
  let term = z;
  let sum = z;
  for (let n = 1; n < 24; n++) {
    term *= -z2;
    sum += term / (2 * n + 1);
  }
  return sum;
}

const TAN_PI_8 = 0.41421356237309503;

export function datan(z: number): number {
  if (z < 0) return -datan(-z);
  if (z > 1) return HALF_PI - datan(1 / z);
  if (z > TAN_PI_8) return PI / 4 + atanSmall((z - 1) / (z + 1));
  return atanSmall(z);
}

export function datan2(y: number, x: number): number {
  if (x > 0) return datan(y / x);
  if (x < 0) return y >= 0 ? datan(y / x) + PI : datan(y / x) - PI;
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

export function dhypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y); // sqrt is correctly rounded by IEEE 754
}
