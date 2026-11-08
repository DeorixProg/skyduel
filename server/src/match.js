import { DT, TICK_RATE } from "@skyduel/shared/net/predict.js";
import { Ship } from "@skyduel/shared/sim/entities.js";
import { World } from "@skyduel/shared/sim/world.js";
import { takeSnapshot } from "@skyduel/shared/snapshot.js";

const COLORS = ["#c0392b", "#2c3e50", "#27ae60", "#d4ac0d", "#8e44ad", "#d35400"];
const MAX_QUEUE = 3; // inputs buffered per player: deeper queue = more input latency; more = burst or speed-hack

/**
 * The authoritative simulation of one room. Runs World.step at 30 Hz on a
 * precise timer, applies ONE validated input per player per tick, and
 * broadcasts a snapshot with each client's lastProcessedSeq (ack).
 */
export class Match {
  #timer = null;
  #nextAt = 0;

  constructor({ arena, seed = 1, onSnapshot }) {
    this.seed = seed;
    this.world = new World({ seed });
    this.world.populate({ balloons: arena.balloons, hunters: arena.hunters });
    this.players = new Map(); // playerId → { ship, queue, lastSeq, ack, last }
    this.onSnapshot = onSnapshot; // (snapshot, players) => void
    this.tick = 0;
    this.tickMs = []; // durations of the last ticks, for /api/stats
    this.lateMs = []; // how late each tick started vs its target time
  }

  addPlayer(playerId, name) {
    const color = COLORS[this.players.size % COLORS.length];
    const ship = this.world.spawn(new Ship({ pos: this.world.findSafeSpot(200), name, color }));
    ship.angle = this.world.rng.range(-Math.PI, Math.PI);
    this.players.set(playerId, { ship, queue: [], lastSeq: 0, ack: 0, last: null });
    if (!this.#timer) this.start();
    return ship;
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    this.world.despawn(p.ship.id);
    this.players.delete(playerId);
    if (this.players.size === 0) this.stop();
  }

  /** Inputs arrive with redundancy (last n); keep only new ones, in order. */
  onInputs(playerId, inputs) {
    const p = this.players.get(playerId);
    if (!p) return;
    for (const input of inputs) {
      if (input.seq <= p.lastSeq) continue; // duplicate from the redundancy window
      p.lastSeq = input.seq;
      p.queue.push(input);
    }
    while (p.queue.length > MAX_QUEUE) p.queue.shift(); // speed-hack / burst guard
  }

  start() {
    this.#nextAt = performance.now();
    this.#schedule();
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * Absolute-target scheduling: each tick is planned for nextAt += 1000/30,
   * so timer lateness never accumulates (setInterval would drift).
   */
  #schedule() {
    this.#nextAt += 1000 / TICK_RATE;
    const delay = Math.max(0, this.#nextAt - performance.now());
    this.#timer = setTimeout(() => this.#run(), delay);
  }

  #run() {
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
  step() {
    const inputs = new Map();
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
    this.tick++;
    this.onSnapshot?.(takeSnapshot(this.world, this.tick), this.players);
  }

  stats() {
    const pct = (arr, q) => {
      const s = [...arr].sort((a, b) => a - b);
      return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
    };
    return {
      tick: this.tick,
      players: this.players.size,
      entities: this.world.size,
      tickMsP50: pct(this.tickMs, 0.5),
      tickMsP99: pct(this.tickMs, 0.99),
      lateMsP50: pct(this.lateMs, 0.5),
      lateMsP99: pct(this.lateMs, 0.99),
    };
  }
}
