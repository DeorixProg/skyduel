import type { ArenaConfig } from "@skyduel/shared/arena-config.ts";
import { Bus } from "@skyduel/shared/bus.ts";
import { binaryCodec } from "@skyduel/shared/codec/binary.ts";
import type { Codec } from "@skyduel/shared/codec/codec.ts";
import { jsonCodec } from "@skyduel/shared/codec/json.ts";
import { DT, reconcile } from "@skyduel/shared/net/predict.ts";
import { Pool } from "@skyduel/shared/pool.ts";
import type { ServerMessageOf } from "@skyduel/shared/protocol.ts";
import { ARENA, wrap, wrapDelta } from "@skyduel/shared/sim/arena.ts";
import { BULLET, COOLDOWN } from "@skyduel/shared/sim/entities.ts";
import { integrate, lerpAngle, type ShipBody, SIM_FLAGS } from "@skyduel/shared/sim/ship.ts";
import type { SimEvents } from "@skyduel/shared/sim/world.ts";
import type { ClientSnapshot, EntityData, ShipData } from "@skyduel/shared/snapshot.ts";
import {
  assertNever,
  type EntityId,
  type Input,
  type Seq,
  seq,
  type Tick,
} from "@skyduel/shared/types.ts";
import type { Audio } from "../audio.ts";
import { createRecorder, type Recorder } from "../experiments.ts";
import { createHud } from "../hud.ts";
import { type Input as KeyInput, readControls } from "../input.ts";
import { createLoop, type Loop, type LoopStats } from "../loop.ts";
import { cameraFor, type View } from "../render/canvas.ts";
import { drawBackground, drawHud, drawScoreboard, type ScoreRow } from "../render/draw.ts";
import { createOverlay } from "../render/overlay.ts";
import type { Sprites } from "../render/sprites.ts";
import type { Connection } from "./connection.ts";
import { createNetgraph, type Netgraph } from "./netgraph.ts";

const TICK_MS = DT * 1000;

/** performance.mark/measure around the hot paths, only with ?perf=1 (entries allocate). */
const PERF = new URLSearchParams(location.search).has("perf");
function timed<T>(name: string, fn: () => T): T {
  if (!PERF) return fn();
  performance.mark(`${name}:start`);
  try {
    return fn();
  } finally {
    performance.measure(name, `${name}:start`);
  }
}
const REDUNDANCY = 3; // every input packet carries the last 3 inputs
const SMOOTH_TAU = 0.04; // s; the correction offset decays to ~8 % in 100 ms
const SNAP_DIST = 150; // corrections larger than this are teleports (respawn): no smoothing

interface BufferedSnapshot {
  readonly tick: Tick;
  readonly recv: number;
  readonly ack: Seq;
  readonly entities: ReadonlyMap<EntityId, EntityData>;
}

interface LocalBullet {
  seq: Seq;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  ttl: number;
  born: number;
}

/** One live particle; explosions are just particles with a shared lifetime. */
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  ttl: number;
}

/** Interpolated view of a remote entity; reused frame after frame (no per-frame allocation). */
interface RemoteView {
  src: EntityData;
  x: number;
  y: number;
  angle: number;
  seen: number;
}

// Lab 7: pools for everything that is created in bursts during a fight
const bulletPool = new Pool<LocalBullet>(
  () => ({ seq: seq(0), x: 0, y: 0, vx: 0, vy: 0, angle: 0, ttl: 0, born: 0 }),
  32,
);
const sparkPool = new Pool<Spark>(() => ({ x: 0, y: 0, vx: 0, vy: 0, r: 0, ttl: 0 }), 512);

export interface NetGame {
  readonly shipId: EntityId;
  readonly loop: Loop;
  readonly recorder: Recorder;
  readonly graph: Netgraph;
  readonly predicted: ShipBody | null;
  readonly latest: BufferedSnapshot | null;
  /** The own ship as the player SEES it (for the input-latency measurement). */
  readonly own: { angle: number } | null;
  stop(): void;
}

const shipBody = (e: ShipData): ShipBody => ({
  x: e.x,
  y: e.y,
  vx: e.vx,
  vy: e.vy,
  angle: e.angle,
  thrust: e.thrust,
});

/**
 * Networked match. The server is the authority; this client
 *  - sends INPUTS (never positions), 30 per second, each with a seq;
 *  - predicts its own ship with the shared integrate() and reconciles on every snapshot;
 *  - draws everything else `interpDelay` in the past, between two snapshots;
 *  - predicts its own bullets and drops them when the server's copy disappears.
 */
export function startNetGame({
  view,
  input,
  sprites,
  audio,
  arena,
  conn,
  welcome,
  params,
}: {
  view: View;
  input: KeyInput;
  sprites: Sprites;
  audio: Audio | null;
  arena: ArenaConfig;
  conn: Connection;
  welcome: ServerMessageOf<"welcome">;
  params: URLSearchParams;
}): NetGame {
  const myShipId = welcome.shipId;
  const codec: Codec = welcome.codec === "json" ? jsonCodec : binaryCodec;
  const predict = params.get("predict") !== "0";
  SIM_FLAGS.chaos = params.has("chaos");
  const graph = createNetgraph();
  Object.assign(graph.state, { codec: codec.name, predict, netsim: welcome.netsim });
  graph.state.interpDelayMs = Number(params.get("interp") ?? 100);
  const recorder = createRecorder();
  const bus = new Bus<SimEvents>();
  const names = new Map<EntityId, { name: string; color: string }>();
  const nameOf = (id: EntityId) => names.get(id)?.name ?? `#${id}`;
  const hud = createHud(bus, { nameOf });
  const ac = new AbortController(); // everything subscribed below is removed by stop()
  const opts = { signal: ac.signal };
  const detachAudio = audio?.attach(bus, {
    localId: myShipId,
    panOf: (id) => {
      const e = latest?.entities.get(id);
      return e ? (e.x / ARENA.width) * 2 - 1 : 0;
    },
  });

  // ── state ────────────────────────────────────────────────────────────────
  const buffer: BufferedSnapshot[] = [];
  let latest: BufferedSnapshot | null = null;
  let clockOffset = Number.POSITIVE_INFINITY; // recv − tick·TICK_MS, minimum over a window
  // the offsets live in a ring of plain numbers: the snapshots themselves can die young
  const offsets = new Float64Array(60).fill(Number.POSITIVE_INFINITY);
  let offsetAt = 0;
  let nextSeq = 0;
  const sent: Input[] = []; // last REDUNDANCY inputs (for resending)
  let pending: Input[] = []; // inputs not yet acknowledged
  let predicted: ShipBody | null = null;
  let prevPredicted: ShipBody | null = null;
  const smooth = { x: 0, y: 0 }; // visual offset that hides corrections
  let localCooldown = 0;
  const localBullets = new Map<Seq, LocalBullet>();
  const confirmed = new Set<Seq>(); // seqs of own bullets the server has shown us
  const sparks: Spark[] = []; // active particles (swap-remove, no per-explosion arrays)
  const serverOwn = new Set<Seq>(); // reused every step
  const remote = new Map<EntityId, RemoteView>();
  let frameNo = 0;
  interface ShipSlot {
    s: ShipData | null;
    x: number;
    y: number;
    angle: number;
    thrust: boolean;
  }
  const shipSlots: ShipSlot[] = Array.from({ length: 64 }, () => ({
    s: null,
    x: 0,
    y: 0,
    angle: 0,
    thrust: false,
  }));
  const ships: ShipSlot[] = [];
  const look = { color: "", thrust: false }; // scratch object for sprites.ship
  const overlay = createOverlay(250); // HUD, scoreboard and netgraph: text redrawn 4×/s, blitted every frame
  const scoreRows: ScoreRow[] = [];
  let simTime = 0;

  const myShip = (s: BufferedSnapshot | null): ShipData | null => {
    const e = s?.entities.get(myShipId);
    return e?.kind === "ship" ? e : null;
  };

  // ── network in ───────────────────────────────────────────────────────────
  function onSnapshot(snap: ClientSnapshot, bytes: number): void {
    const recv = performance.now();
    graph.onSnapshot(bytes);
    if (latest && snap.tick <= latest.tick) return; // stale (cannot happen over TCP, but be safe)
    const s: BufferedSnapshot = {
      tick: snap.tick,
      recv,
      ack: snap.ack,
      entities: new Map(snap.entities.map((e) => [e.id, e])),
    };
    deriveEvents(latest, s);
    buffer.push(s);
    // 12 snapshots = 400 ms ≥ interpolation delay + jitter. Lab 6 kept 60 (2 s): they
    // survived two scavenges, got promoted to old space and fed the major GCs (Lab 7).
    while (buffer.length > 12) buffer.shift();
    latest = s;
    offsets[offsetAt++ % offsets.length] = recv - s.tick * TICK_MS;
    clockOffset = Number.POSITIVE_INFINITY;
    for (const o of offsets) if (o < clockOffset) clockOffset = o;

    const mine = myShip(s);
    if (!mine) return;
    for (const b of snap.entities)
      if (b.kind === "bullet" && b.owner === myShipId) confirmed.add(b.seq);
    if (!predict || mine.down || !predicted) {
      pending = pending.filter((i) => i.seq > snap.ack);
      predicted = shipBody(mine);
      prevPredicted = predicted;
      return;
    }
    const before = predicted;
    const r = timed("reconcile", () =>
      reconcile({ server: shipBody(mine), ack: snap.ack, pending }),
    );
    pending = r.pending;
    predicted = { ...r.state, thrust: mine.thrust };
    const dx = wrapDelta(predicted.x, before.x, ARENA.width);
    const dy = wrapDelta(predicted.y, before.y, ARENA.height);
    const dist = Math.hypot(dx, dy);
    graph.onCorrection(dist);
    if (dist > SNAP_DIST) {
      smooth.x = 0;
      smooth.y = 0;
      prevPredicted = predicted;
    } else {
      smooth.x += dx; // keep showing the old position, then glide to the new one
      smooth.y += dy;
    }
  }

  conn.events.on(
    "binary",
    ({ data }) => {
      try {
        onSnapshot(
          timed("decode", () => codec.decodeSnapshot(data)),
          data.byteLength,
        );
      } catch (err: unknown) {
        console.warn("bad snapshot dropped:", err instanceof Error ? err.message : err);
      }
    },
    opts,
  );
  conn.on("snapshot", (m) => onSnapshot(m, JSON.stringify(m).length), opts);
  conn.on(
    "roster",
    (m) => {
      for (const p of m.players) names.set(p.shipId, { name: p.name, color: p.color });
    },
    opts,
  );
  conn.on("pong", (m) => graph.onRtt(performance.now() - m.t), opts);
  const pinger = setInterval(() => conn.send({ type: "ping", t: performance.now() }), 500);

  /** Turn snapshot differences into game events (sounds, kill feed, explosions). */
  function deriveEvents(prev: BufferedSnapshot | null, next: BufferedSnapshot): void {
    if (!prev) return;
    // .values() + e.id instead of `for (const [id, e] of map)`: no [k, v] array per entry
    for (const e of next.entities.values()) {
      const id = e.id;
      const old = prev.entities.get(id);
      switch (e.kind) {
        case "ship": {
          if (old?.kind !== "ship") break;
          if (!old.down && e.down) {
            let killer: EntityId | null = null;
            for (const s of next.entities.values()) {
              const was = prev.entities.get(s.id);
              if (s.kind === "ship" && s.id !== id && was?.kind === "ship" && s.score > was.score)
                killer = s.id;
            }
            bus.emit("exploded", { target: id, by: killer });
            explode(e.x, e.y, 1);
          } else if (e.hp < old.hp) bus.emit("hit", { target: id, by: null, hp: e.hp });
          const gained = e.effects.find((fx) => !old.effects.includes(fx));
          if (gained) bus.emit("pickup", { target: id, effect: gained });
          break;
        }
        case "bullet":
          if (!old && e.owner !== myShipId) bus.emit("fired", { by: e.owner });
          break;
        case "balloon":
        case "pickup":
          break;
        default:
          assertNever(e, "entity kind");
      }
    }
    for (const old of prev.entities.values()) {
      const id = old.id;
      if (old.kind === "balloon" && !next.entities.has(id)) {
        bus.emit("popped", { target: id });
        explode(old.x, old.y, 0.6);
      }
    }
  }

  function explode(x: number, y: number, size: number): void {
    // cosmetic only, so Math.random is fine here (it never touches the shared sim)
    const n = Math.round(28 * size);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (40 + Math.random() * 180) * size;
      const p = sparkPool.acquire();
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.r = 2 + Math.random() * 3;
      p.ttl = 0.9;
      sparks.push(p);
    }
  }

  // ── fixed step: sample input, send, predict ──────────────────────────────
  function simulate(dt: number): void {
    simTime += dt;
    const c = readControls(input);
    input.endStep();
    const inp: Input = { seq: seq(++nextSeq), thrust: c.thrust, turn: c.turn, fire: c.fire };
    sent.push(inp);
    if (sent.length > REDUNDANCY) sent.shift();
    conn.sendRaw(codec.encodeInputs(sent));
    pending.push(inp);
    if (pending.length > 90) pending.shift(); // 3 s without acks: something is very wrong
    graph.state.pending = pending.length;

    const mine = myShip(latest);
    if (predict && predicted && mine && !mine.down) {
      prevPredicted = predicted;
      predicted = integrate(predicted, inp, dt);
      localCooldown = Math.max(0, localCooldown - dt);
      if (inp.fire && localCooldown === 0 && !mine.effects.includes("homing")) {
        localCooldown = mine.effects.includes("rapid") ? COOLDOWN.rapid : COOLDOWN.normal;
        const b = bulletPool.acquire();
        b.seq = inp.seq;
        b.x = predicted.x + Math.cos(predicted.angle) * 24;
        b.y = predicted.y + Math.sin(predicted.angle) * 24;
        b.vx = predicted.vx + Math.cos(predicted.angle) * BULLET.SPEED;
        b.vy = predicted.vy + Math.sin(predicted.angle) * BULLET.SPEED;
        b.angle = predicted.angle;
        b.ttl = BULLET.TTL;
        b.born = performance.now();
        localBullets.set(inp.seq, b);
        bus.emit("fired", { by: myShipId });
      }
    }
    serverOwn.clear();
    for (const e of latest?.entities.values() ?? [])
      if (e.kind === "bullet" && e.owner === myShipId) serverOwn.add(e.seq);
    for (const b of localBullets.values()) {
      const k = b.seq;
      b.x = wrap(b.x + b.vx * dt, ARENA.width);
      b.y = wrap(b.y + b.vy * dt, ARENA.height);
      b.ttl -= dt;
      const goneOnServer = confirmed.has(k) && !serverOwn.has(k);
      const neverConfirmed =
        !confirmed.has(k) && performance.now() - b.born > graph.state.rtt + 300;
      if (b.ttl <= 0 || goneOnServer || neverConfirmed) {
        localBullets.delete(k);
        confirmed.delete(k);
        bulletPool.release(b);
      }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      if (!p) continue;
      p.ttl -= dt;
      if (p.ttl <= 0) {
        sparks[i] = sparks[sparks.length - 1] ?? p; // swap-remove: O(1), no array copy
        sparks.pop();
        sparkPool.release(p);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 2 * dt;
      p.vy *= 1 - 2 * dt;
    }
    hud.update(dt);
  }

  // ── render: interpolate others in the past, own ship in the present ──────
  // defined once, not inside render(): a closure per frame is garbage per frame
  function addShip(s: ShipData, x: number, y: number, angle: number, thrust: boolean): void {
    const slot = shipSlots[ships.length];
    if (!slot) return;
    slot.s = s;
    slot.x = x;
    slot.y = y;
    slot.angle = angle;
    slot.thrust = thrust;
    ships.push(slot);
  }

  let overlayStats: Readonly<LoopStats> | null = null;
  function paintOverlay(octx: CanvasRenderingContext2D): void {
    if (!overlayStats) return;
    const stats = overlayStats;
    const mine = myShip(latest);
    drawHud(octx, stats, [
      `ship     #${myShipId}`,
      `hp       ${mine?.hp ?? "-"}`,
      `arena    ${arena.name}`,
    ]);
    scoreRows.length = 0;
    for (const e of latest?.entities.values() ?? []) {
      if (e.kind !== "ship") continue;
      const info = names.get(e.id) ?? UNKNOWN;
      scoreRows.push({ name: info.name, color: info.color, score: e.score, effects: e.effects });
    }
    drawScoreboard(octx, scoreRows, view.width);
    graph.draw(octx, view);
  }

  /** Writes interpolated poses into `remote` (objects reused frame to frame). */
  function sampleRemote(now: number): void {
    frameNo++;
    if (!latest) return;
    const renderTick = (now - clockOffset - graph.state.interpDelayMs) / TICK_MS;
    let a: BufferedSnapshot | undefined;
    let b: BufferedSnapshot | undefined;
    for (let i = buffer.length - 1; i > 0; i--) {
      const x = buffer[i - 1];
      if (x && x.tick <= renderTick) {
        a = x;
        b = buffer[i];
        break;
      }
    }
    if (!a || !b) {
      if (renderTick > latest.tick) graph.state.underruns++;
      a = latest;
      b = latest;
    }
    const t = b === a ? 0 : Math.min(1, (renderTick - a.tick) / (b.tick - a.tick));
    for (const eb of b.entities.values()) {
      const id = eb.id;
      const ea = a.entities.get(id) ?? eb; // appeared between snapshots: first known position
      let v = remote.get(id);
      if (!v) {
        v = { src: eb, x: 0, y: 0, angle: 0, seen: 0 };
        remote.set(id, v);
      }
      v.src = eb;
      v.x = wrap(ea.x + wrapDelta(ea.x, eb.x, ARENA.width) * t, ARENA.width);
      v.y = wrap(ea.y + wrapDelta(ea.y, eb.y, ARENA.height) * t, ARENA.height);
      v.angle = lerpAngle(ea.angle, eb.angle, t);
      v.seen = frameNo;
    }
    for (const v of remote.values()) if (v.seen !== frameNo) remote.delete(v.src.id);
  }

  function render(alpha: number, stats: Readonly<LoopStats>): void {
    const now = performance.now();
    recorder.mark(now);
    graph.tick(conn);
    graph.state.snapshotAge = latest ? now - latest.recv : 0;
    const k = Math.exp(-(stats.frameMs / 1000) / SMOOTH_TAU);
    smooth.x *= k;
    smooth.y *= k;

    const { ctx } = view;
    const cam = cameraFor(view, ARENA);
    ctx.fillStyle = "#0b1d2e";
    ctx.fillRect(0, 0, view.width, view.height);
    ctx.save();
    ctx.translate(cam.ox, cam.oy);
    ctx.scale(cam.scale, cam.scale);
    ctx.beginPath();
    ctx.rect(0, 0, ARENA.width, ARENA.height);
    ctx.clip();
    drawBackground(ctx, arena.sky);

    sampleRemote(now);
    ships.length = 0;
    for (const v of remote.values()) {
      const e = v.src;
      switch (e.kind) {
        case "balloon":
          sprites.balloon(ctx, e, v);
          break;
        case "pickup":
          sprites.pickup(ctx, e.effect, v, simTime * 2);
          break;
        case "bullet":
          if (e.owner === myShipId && predict && localBullets.has(e.seq)) break; // drawn locally
          sprites.bullet(ctx, e.homing, v, v.angle);
          break;
        case "ship":
          if (e.id !== myShipId) addShip(e, v.x, v.y, v.angle, e.thrust);
          break;
        default:
          assertNever(e, "entity kind");
      }
    }
    for (const b of localBullets.values()) sprites.bullet(ctx, false, b, b.angle);

    const mine = myShip(latest);
    if (mine) {
      if (predict && predicted && prevPredicted && !mine.down) {
        const x =
          prevPredicted.x + wrapDelta(prevPredicted.x, predicted.x, ARENA.width) * alpha + smooth.x;
        const y =
          prevPredicted.y +
          wrapDelta(prevPredicted.y, predicted.y, ARENA.height) * alpha +
          smooth.y;
        const angle = lerpAngle(prevPredicted.angle, predicted.angle, alpha);
        addShip(mine, wrap(x, ARENA.width), wrap(y, ARENA.height), angle, predicted.thrust);
      } else addShip(mine, mine.x, mine.y, mine.angle, mine.thrust); // no prediction: one RTT late
    }
    for (const ship of ships) {
      const s = ship.s;
      if (!s || s.down) continue;
      const info = names.get(s.id) ?? UNKNOWN;
      look.color = info.color;
      look.thrust = ship.thrust;
      sprites.ship(ctx, look, ship, simTime);
      drawLabel(ctx, info.name, s.hp, s.effects.includes("shield"), ship);
    }
    // sparks: one colour per 0.1 s of age instead of a new rgba() string per particle
    for (let band = 0; band < 9; band++) {
      const kk = (band + 0.5) / 9;
      ctx.fillStyle = SPARK_COLORS[band] ?? "#fff";
      ctx.beginPath();
      for (const p of sparks) {
        if (Math.min(8, Math.floor((p.ttl / 0.9) * 9)) !== band) continue;
        ctx.moveTo(p.x + p.r * (0.5 + kk), p.y);
        ctx.arc(p.x, p.y, p.r * (0.5 + kk), 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.restore();

    // text is the most expensive thing on screen (fillText); it changes slowly, so
    // it is rendered into an offscreen layer 4 times a second and blitted every frame
    overlayStats = stats;
    overlay.draw(ctx, view, now, paintOverlay);
    hud.draw(ctx, view);
  }

  // live tuning of the interpolation delay
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code === "BracketLeft")
        graph.state.interpDelayMs = Math.max(0, graph.state.interpDelayMs - 16);
      if (e.code === "BracketRight") graph.state.interpDelayMs += 16;
    },
    opts,
  );

  const loop = createLoop({
    step: DT,
    // without ?perf the raw functions are passed: no wrapper closures per frame
    simulate: PERF ? (dt) => timed("simulate", () => simulate(dt)) : simulate,
    render: PERF ? (alpha, stats) => timed("render", () => render(alpha, stats)) : render,
  });
  loop.start();
  return {
    shipId: myShipId,
    loop,
    recorder,
    graph,
    get predicted() {
      return predicted;
    },
    get latest() {
      return latest;
    },
    get own() {
      const mine = myShip(latest);
      return predict && predicted && mine && !mine.down ? predicted : mine;
    },
    stop() {
      loop.stop();
      clearInterval(pinger);
      ac.abort();
      detachAudio?.();
      hud.dispose();
    },
  };
}

const UNKNOWN = { name: "?", color: "#7f8c8d", thrust: false };
const SPARK_COLORS = Array.from({ length: 9 }, (_, band) => {
  const k = (band + 0.5) / 9;
  return `rgba(${Math.round(200 + 55 * k)},${Math.round(80 + 120 * k)},30,${k.toFixed(2)})`;
});

/** Names are rasterised once and reused (fillText per ship per frame was the top self-time). */
const nameCache = new Map<string, HTMLCanvasElement>();
function nameBitmap(name: string): HTMLCanvasElement {
  let c = nameCache.get(name);
  if (c) return c;
  c = document.createElement("canvas");
  const dpr = 2;
  c.width = 120 * dpr;
  c.height = 16 * dpr;
  const g = c.getContext("2d");
  if (g) {
    g.scale(dpr, dpr);
    g.font = "12px system-ui";
    g.textAlign = "center";
    g.fillStyle = "#1b2631";
    g.fillText(name, 60, 12);
  }
  nameCache.set(name, c);
  return c;
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  name: string,
  hp: number,
  shield: boolean,
  pos: { x: number; y: number },
): void {
  const s = { hp };
  if (shield) {
    ctx.strokeStyle = "rgba(41,128,185,0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 26, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(pos.x - 20, pos.y - 34, 40, 5);
  ctx.fillStyle = s.hp > 50 ? "#27ae60" : s.hp > 25 ? "#f39c12" : "#c0392b";
  ctx.fillRect(pos.x - 20, pos.y - 34, 40 * (s.hp / 100), 5);
  ctx.drawImage(nameBitmap(name), pos.x - 60, pos.y - 51, 120, 16);
}
