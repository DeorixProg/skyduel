/**
 * Branded types: at runtime an EntityId is just a number, but the compiler
 * treats EntityId, Tick and Seq as DIFFERENT types, so passing a seq where an
 * entity id is expected is a compile error.
 */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type EntityId = Brand<number, "EntityId">;
export type Tick = Brand<number, "Tick">;
export type Seq = Brand<number, "Seq">;
export type PlayerId = Brand<number, "PlayerId">;

/**
 * The single place where a plain number becomes a branded one.
 * Every caller is a trusted producer (World's id counter, the tick counter,
 * the codec after range checks, zod after validation).
 */
function unsafeBrand<T extends Brand<number, string>>(n: number): T {
  return n as T; // `as` #1: branding cannot be expressed without a cast; validated by callers
}

export const entityId = (n: number): EntityId => unsafeBrand<EntityId>(n);
export const tick = (n: number): Tick => unsafeBrand<Tick>(n);
export const seq = (n: number): Seq => unsafeBrand<Seq>(n);
export const playerId = (n: number): PlayerId => unsafeBrand<PlayerId>(n);

/** Player controls for one simulation step. */
export interface Controls {
  readonly thrust: boolean;
  readonly turn: number; // −1..1
  readonly fire: boolean;
}

/** Controls tagged with the client's sequence number. */
export interface Input extends Controls {
  readonly seq: Seq;
}

/** Compile-time exhaustiveness: a new union member without a branch is a tsc error. */
export function assertNever(x: never, what = "value"): never {
  throw new Error(`unhandled ${what}: ${JSON.stringify(x)}`);
}

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
