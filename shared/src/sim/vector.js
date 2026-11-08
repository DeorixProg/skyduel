import { datan2, dcos, dhypot, dsin } from "./dmath.js";
/**
 * 2D vector with PURE methods: `a.add(b)` returns a new vector and never
 * mutates `a` or `b`. Pure methods make aliasing bugs impossible
 * (two entities can safely share one vector), at the price of an
 * allocation per operation — Lab 7 measures whether that price matters.
 */
export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle, length = 1) {
    return new Vector2(dcos(angle) * length, dsin(angle) * length);
  }

  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k) {
    return new Vector2(this.x * k, this.y * k);
  }

  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  length() {
    return dhypot(this.x, this.y);
  }

  normalize() {
    const len = this.length();
    return len === 0 ? new Vector2(0, 0) : new Vector2(this.x / len, this.y / len);
  }

  rotate(angle) {
    const c = dcos(angle);
    const s = dsin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  angle() {
    return datan2(this.y, this.x);
  }

  clone() {
    return new Vector2(this.x, this.y);
  }

  equals(v, eps = 1e-9) {
    return Math.abs(this.x - v.x) <= eps && Math.abs(this.y - v.y) <= eps;
  }

  toString() {
    return `Vector2(${this.x.toFixed(2)}, ${this.y.toFixed(2)})`;
  }
}
