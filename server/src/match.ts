import type { PlayerInput } from "@skyduel/shared/bot.ts";
import { DT, TICK_RATE } from "@skyduel/shared/net/predict.ts";
import { naivePairs } from "@skyduel/shared/sim/collision.ts";
import { Ship } from "@skyduel/shared/sim/entities.ts";
import { spatialHashPairs } from "@skyduel/shared/sim/spatial.ts";
import { World } from "@skyduel/shared/sim/world.ts";
import { type Snapshot, takeSnapshot } from "@skyduel/shared/snapshot.ts";
import {
  type EntityId,
  type Input,
  type PlayerId,
  type Seq,
  seq,
  type Tick,
  tick,
} from "@skyduel/shared/types.ts";
import type { ArenaConfig } from "./arenas.ts";

const COLORS = ["#c0392b", "#2c3e50", "#27ae60", "#d4ac0d", "#8e44ad", "#d35400"] as const;
const MAX_QUEUE = 3; // inputs buffered per player: deeper queue = more input latency; more = burst or speed-hack

export interface MatchPlayer {
  readonly ship: Ship;
  readonly queue: Input[];
  lastSeq: Seq;
  ack: Seq;
  last: Input | null;
  /** Server-side bot: produces the same Input a socket would, through the same queue. */
  readonly bot: PlayerInput | null;
  botSeq: number;
}

export interface MatchStats {
  tick: number;
  players: number;
  entities: number;
  tickMsP50: number;
  tickMsP99: number;
  lateMsP50: number;
  lateMsP99: number;
}

function percentile(values: readonly number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
}

/**
 * The authoritative simulation of one room. Runs World.step at 30 Hz on a
 * precise timer, applies ONE validated input per player per tick, and
 * broadcasts a snapshot with each client's lastProcessedSeq (ack).
 */
export class Match {
  #timer: NodeJS.Timeout | null = null;
  #nextAt = 0;
  readonly seed: number;
  readonly world: World;
  readonly players = new Map<PlayerId, MatchPlayer>();
  readonly onSnapshot:
    | ((snap: Snapshot, players: ReadonlyMap<PlayerId, MatchPlayer>) => void)
    | undefined;
  tick: Tick = tick(0);
  readonly tickMs: number[] = []; // durations of the last ticks, for /api/stats
  readonly lateMs: number[] = []; // how late each tick started vs its target time

  constructor({
    arena,
    seed = 1,
    onSnapshot,
    collision = "hash",
  }: {
    collision?: "naive" | "hash";
    arena: Pick<ArenaConfig, "balloons" | "hunters">;
    seed?: number;
    onSnapshot?: Match["onSnapshot"];
  }) {
    this.seed = seed;
    // Lab 7 measured both broad phases (identical results, tested bit for bit):
    //   spread-out players (load test, 256 clients): naive p99 38.8 ms, hash 21.5 ms;
    //   a clustered dogfight (256 bots): naive 18.7 ms, hash 20.2 ms.
    // The hash bounds the bad case and costs little in the clustered one → default.
    this.world = new World({ seed, collide: collision === "hash" ? spatialHashPairs : naivePairs });
    this.world.populate({ balloons: arena.balloons, hunters: arena.hunters });
    this.onSnapshot = onSnapshot;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  addPlayer(playerId: PlayerId, name: string, bot: PlayerInput | null = null): Ship {
    const color = COLORS[this.players.size % COLORS.length] ?? COLORS[0];
    const ship = this.world.spawn(new Ship({ pos: this.world.findSafeSpot(200), name, color }));
    ship.angle = this.world.rng.range(-Math.PI, Math.PI);
    this.players.set(playerId, {
      ship,
      queue: [],
      lastSeq: seq(0),
      ack: seq(0),
      last: null,
      bot,
      botSeq: 0,
    });
    if (!this.#timer) this.start();
    return ship;
  }

  removePlayer(playerId: PlayerId): void {
    const p = this.players.get(playerId);
    if (!p) return;
    this.world.despawn(p.ship.id);
    this.players.delete(playerId);
    if (this.players.size === 0) this.stop();
  }

  /** Inputs arrive with redundancy (last n); keep only new ones, in order. */
  onInputs(playerId: PlayerId, inputs: readonly Input[]): void {
    const p = this.players.get(playerId);
    if (!p) return;
    for (const input of inputs) {
      if (input.seq <= p.lastSeq) continue; // duplicate from the redundancy window
      p.lastSeq = input.seq;
      p.queue.push(input);
    }
    while (p.queue.length > MAX_QUEUE) p.queue.shift(); // speed-hack / burst guard
  }

  start(): void {
    this.#nextAt = performance.now();
    this.#schedule();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * Absolute-target scheduling: each tick is planned for nextAt += 1000/30,
   * so timer lateness never accumulates (setInterval would drift).
   */
  #schedule(): void {
    this.#nextAt += 1000 / TICK_RATE;
    const delay = Math.max(0, this.#nextAt - performance.now());
    this.#timer = setTimeout(() => this.#run(), delay);
  }

  #run(): void {
    const start = performance.now();
    this.lateMs.push(start - this.#nextAt);
    if (start - this.#nextAt > 250) this.#nextAt = start; // after a long stall, don't spiral
    this.step();
    this.tickMs.push(performance.now() - start);
    if (this.tickMs.length > 300) this.tickMs.shift();
    if (this.lateMs.length > 300) this.lateMs.shift();
    if (this.#timer) this.#schedule();
  }

  /** One authoritative tick (public so tests can step without timers). */
  step(): void {
    const inputs = new Map<EntityId, Input>();
    for (const [id, p] of this.players) {
      if (p.bot) this.onInputs(id, [{ ...p.bot.next(p.ship, this.world), seq: seq(++p.botSeq) }]);
    }
    for (const p of this.players.values()) {
      const next = p.queue.shift();
      if (next) {
        p.ack = next.seq;
        p.last = next;
        inputs.set(p.ship.id, next);
      } else if (p.last) {
        // starvation (late/lost packet): repeat the last controls, but never re-fire
        inputs.set(p.ship.id, { ...p.last, fire: false });
      }
    }
    this.world.step(DT, inputs);
    this.tick = tick(this.tick + 1);
    this.onSnapshot?.(takeSnapshot(this.world, this.tick), this.players);
  }

  stats(): MatchStats {
    return {
      tick: this.tick,
      players: this.players.size,
      entities: this.world.size,
      tickMsP50: percentile(this.tickMs, 0.5),
      tickMsP99: percentile(this.tickMs, 0.99),
      lateMsP50: percentile(this.lateMs, 0.5),
      lateMsP99: percentile(this.lateMs, 0.99),
    };
  }
}
