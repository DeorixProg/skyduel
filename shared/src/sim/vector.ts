import { datan2, dcos, dhypot, dsin } from "./dmath.ts";

/**
 * 2D vector with PURE methods and readonly fields: `a.add(b)` returns a new
 * vector, and `a.x = 1` is a compile error, so aliasing bugs are impossible
 * (two entities can safely share one vector).
 */
export class Vector2 {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(dcos(angle) * length, dsin(angle) * length);
  }

  add(v: Vector2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v: Vector2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k: number): Vector2 {
    return new Vector2(this.x * k, this.y * k);
  }

  dot(v: Vector2): number {
    return this.x * v.x + this.y * v.y;
  }

  length(): number {
    return dhypot(this.x, this.y);
  }

  normalize(): Vector2 {
    const len = this.length();
    return len === 0 ? new Vector2(0, 0) : new Vector2(this.x / len, this.y / len);
  }

  rotate(angle: number): Vector2 {
    const c = dcos(angle);
    const s = dsin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  angle(): number {
    return datan2(this.y, this.x);
  }

  equals(v: Vector2, eps = 1e-9): boolean {
    return Math.abs(this.x - v.x) <= eps && Math.abs(this.y - v.y) <= eps;
  }

  toString(): string {
    return `Vector2(${this.x.toFixed(2)}, ${this.y.toFixed(2)})`;
  }
}
