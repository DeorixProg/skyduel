import type { ArenaConfig } from "@skyduel/shared/arena-config.ts";
import { Bus } from "@skyduel/shared/bus.ts";
import { binaryCodec } from "@skyduel/shared/codec/binary.ts";
import type { Codec } from "@skyduel/shared/codec/codec.ts";
import { jsonCodec } from "@skyduel/shared/codec/json.ts";
import { DT, reconcile } from "@skyduel/shared/net/predict.ts";
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
import { drawBackground, drawHud, drawScoreboard } from "../render/draw.ts";
import type { Sprites } from "../render/sprites.ts";
import type { Connection } from "./connection.ts";
import { createNetgraph, type Netgraph } from "./netgraph.ts";

const TICK_MS = DT * 1000;
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
  x: number;
  y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  ttl: number;
  readonly born: number;
}

interface Explosion {
  ttl: number;
  readonly parts: Array<{ x: number; y: number; vx: number; vy: number; r: number }>;
}

export interface NetGame {
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
  let nextSeq = 0;
  const sent: Input[] = []; // last REDUNDANCY inputs (for resending)
  let pending: Input[] = []; // inputs not yet acknowledged
  let predicted: ShipBody | null = null;
  let prevPredicted: ShipBody | null = null;
  const smooth = { x: 0, y: 0 }; // visual offset that hides corrections
  let localCooldown = 0;
  const localBullets = new Map<Seq, LocalBullet>();
  const confirmed = new Set<Seq>(); // seqs of own bullets the server has shown us
  const explosions: Explosion[] = [];
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
    while (buffer.length > 60) buffer.shift();
    latest = s;
    clockOffset = Math.min(...buffer.map((b) => b.recv - b.tick * TICK_MS));

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
    const r = reconcile({ server: shipBody(mine), ack: snap.ack, pending });
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
        onSnapshot(codec.decodeSnapshot(data), data.byteLength);
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
    for (const [id, e] of next.entities) {
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
    for (const [id, old] of prev.entities) {
      if (old.kind === "balloon" && !next.entities.has(id)) {
        bus.emit("popped", { target: id });
        explode(old.x, old.y, 0.6);
      }
    }
  }

  function explode(x: number, y: number, size: number): void {
    // cosmetic only, so Math.random is fine here (it never touches the shared sim)
    const parts = Array.from({ length: Math.round(28 * size) }, () => {
      const a = Math.random() * Math.PI * 2;
      const sp = (40 + Math.random() * 180) * size;
      return { x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 2 + Math.random() * 3 };
    });
    explosions.push({ ttl: 0.9, parts });
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
        localBullets.set(inp.seq, {
          x: predicted.x + Math.cos(predicted.angle) * 24,
          y: predicted.y + Math.sin(predicted.angle) * 24,
          vx: predicted.vx + Math.cos(predicted.angle) * BULLET.SPEED,
          vy: predicted.vy + Math.sin(predicted.angle) * BULLET.SPEED,
          angle: predicted.angle,
          ttl: BULLET.TTL,
          born: performance.now(),
        });
        bus.emit("fired", { by: myShipId });
      }
    }
    const serverOwn = new Set<Seq>();
    for (const e of latest?.entities.values() ?? [])
      if (e.kind === "bullet" && e.owner === myShipId) serverOwn.add(e.seq);
    for (const [k, b] of localBullets) {
      b.x = wrap(b.x + b.vx * dt, ARENA.width);
      b.y = wrap(b.y + b.vy * dt, ARENA.height);
      b.ttl -= dt;
      const goneOnServer = confirmed.has(k) && !serverOwn.has(k);
      const neverConfirmed =
        !confirmed.has(k) && performance.now() - b.born > graph.state.rtt + 300;
      if (b.ttl <= 0 || goneOnServer || neverConfirmed) {
        localBullets.delete(k);
        confirmed.delete(k);
      }
    }
    for (const ex of explosions) {
      ex.ttl -= dt;
      for (const p of ex.parts) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 1 - 2 * dt;
        p.vy *= 1 - 2 * dt;
      }
    }
    while ((explosions[0]?.ttl ?? 1) <= 0) explosions.shift();
    hud.update(dt);
  }

  // ── render: interpolate others in the past, own ship in the present ──────
  function sampleRemote(now: number): ReadonlyMap<EntityId, EntityData> | null {
    if (!latest) return null;
    const renderTick = (now - clockOffset - graph.state.interpDelayMs) / TICK_MS;
    for (let i = buffer.length - 1; i > 0; i--) {
      const a = buffer[i - 1];
      const b = buffer[i];
      if (!a || !b || a.tick > renderTick) continue;
      const t = Math.min(1, (renderTick - a.tick) / (b.tick - a.tick));
      const out = new Map<EntityId, EntityData>();
      for (const [id, eb] of b.entities) {
        const ea = a.entities.get(id);
        if (!ea) {
          out.set(id, eb); // appeared between snapshots: show at its first known position
          continue;
        }
        out.set(id, {
          ...eb,
          x: wrap(ea.x + wrapDelta(ea.x, eb.x, ARENA.width) * t, ARENA.width),
          y: wrap(ea.y + wrapDelta(ea.y, eb.y, ARENA.height) * t, ARENA.height),
          angle: lerpAngle(ea.angle, eb.angle, t),
        });
      }
      return out;
    }
    if (renderTick > latest.tick) graph.state.underruns++;
    return latest.entities;
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

    const ships: ShipData[] = [];
    for (const e of sampleRemote(now)?.values() ?? []) {
      switch (e.kind) {
        case "balloon":
          sprites.balloon(ctx, e, e);
          break;
        case "pickup":
          sprites.pickup(ctx, e.effect, e, simTime * 2);
          break;
        case "bullet":
          if (e.owner === myShipId && predict && localBullets.has(e.seq)) break; // drawn locally
          sprites.bullet(ctx, e.homing, e, e.angle);
          break;
        case "ship":
          if (e.id !== myShipId) ships.push(e);
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
        ships.push({
          ...mine,
          x: wrap(x, ARENA.width),
          y: wrap(y, ARENA.height),
          angle,
          thrust: predicted.thrust,
        });
      } else ships.push(mine); // no prediction: the newest snapshot, i.e. one RTT late
    }
    for (const s of ships) {
      if (s.down) continue;
      const info = names.get(s.id) ?? { name: `#${s.id}`, color: "#7f8c8d" };
      sprites.ship(ctx, { color: info.color, thrust: s.thrust }, s, simTime);
      drawLabel(ctx, { ...info, hp: s.hp, shield: s.effects.includes("shield") }, s);
    }
    for (const ex of explosions) {
      const kk = Math.max(0, ex.ttl / 0.9);
      ctx.fillStyle = `rgba(${200 + 55 * kk},${80 + 120 * kk},30,${kk})`;
      for (const p of ex.parts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (0.5 + kk), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    drawHud(ctx, stats, [
      `ship     #${myShipId}`,
      `hp       ${mine?.hp ?? "-"}`,
      `arena    ${arena.name}`,
    ]);
    const rows = [];
    for (const e of latest?.entities.values() ?? []) {
      if (e.kind === "ship")
        rows.push({
          name: nameOf(e.id),
          color: names.get(e.id)?.color ?? "#7f8c8d",
          score: e.score,
          effects: new Set(e.effects),
        });
    }
    drawScoreboard(ctx, rows, view.width);
    hud.draw(ctx, view);
    graph.draw(ctx, view);
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

  const loop = createLoop({ step: DT, simulate, render });
  loop.start();
  return {
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

function drawLabel(
  ctx: CanvasRenderingContext2D,
  s: { name: string; hp: number; shield: boolean },
  pos: { x: number; y: number },
): void {
  if (s.shield) {
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
  ctx.fillStyle = "#1b2631";
  ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(s.name, pos.x, pos.y - 39);
  ctx.textAlign = "start";
}
