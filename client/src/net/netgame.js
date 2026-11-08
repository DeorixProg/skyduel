import * as binary from "@skyduel/shared/codec/binary.js";
import * as json from "@skyduel/shared/codec/json.js";
import { DT, reconcile } from "@skyduel/shared/net/predict.js";
import { ARENA, wrap, wrapDelta } from "@skyduel/shared/sim/arena.js";
import { BULLET, COOLDOWN } from "@skyduel/shared/sim/entities.js";
import { integrate, lerpAngle, SIM_FLAGS } from "@skyduel/shared/sim/ship.js";
import { createRecorder } from "../experiments.js";
import { createHud } from "../hud.js";
import { readControls } from "../input.js";
import { createLoop } from "../loop.js";
import { cameraFor } from "../render/canvas.js";
import { drawBackground, drawHud, drawScoreboard } from "../render/draw.js";
import { createNetgraph } from "./netgraph.js";

const TICK_MS = DT * 1000;
const REDUNDANCY = 3; // every input packet carries the last 3 inputs
const SMOOTH_TAU = 0.04; // s; the correction offset decays to ~8 % in 100 ms
const SNAP_DIST = 150; // corrections larger than this are teleports (respawn): no smoothing

/**
 * Networked match. The server is the authority; this client
 *  - sends INPUTS (never positions), 30 per second, each with a seq;
 *  - predicts its own ship with the shared integrate() and reconciles on every snapshot;
 *  - draws everything else `interpDelay` in the past, between two snapshots;
 *  - predicts its own bullets and drops them when the server's copy disappears.
 */
export function startNetGame({ view, input, sprites, audio, arena, conn, welcome, params }) {
  const myShipId = welcome.shipId;
  const codec = welcome.codec;
  const predict = params.get("predict") !== "0";
  SIM_FLAGS.chaos = params.has("chaos");
  const graph = createNetgraph();
  Object.assign(graph.state, { codec, predict, netsim: welcome.netsim });
  graph.state.interpDelayMs = Number(params.get("interp") ?? 100);
  const recorder = createRecorder();
  const bus = new EventTarget();
  const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  const names = new Map(); // shipId → { name, color }
  const nameOf = (shipId) => names.get(shipId)?.name ?? `#${shipId}`;
  const hud = createHud(bus, { nameOf });
  audio?.attach(bus, {
    localId: myShipId,
    panOf: (id) => {
      const e = latest?.entities.get(id);
      return e ? (e.x / ARENA.width) * 2 - 1 : 0;
    },
  });

  // ── state ────────────────────────────────────────────────────────────────
  const buffer = []; // snapshots: { tick, recv, entities: Map }
  let latest = null;
  let clockOffset = Number.POSITIVE_INFINITY; // recv − tick·TICK_MS, minimum over a window
  let seq = 0;
  const sent = []; // last REDUNDANCY inputs (for resending)
  let pending = []; // inputs not yet acknowledged
  let predicted = null; // own ship {x,y,vx,vy,angle,thrust}
  let prevPredicted = null;
  const smooth = { x: 0, y: 0 }; // visual offset that hides corrections
  let localCooldown = 0;
  const localBullets = new Map(); // seq → bullet
  const confirmed = new Set(); // seqs the server has shown us
  const explosions = [];
  let simTime = 0;

  // ── network in ───────────────────────────────────────────────────────────
  const onSnapshot = (snap, bytes) => {
    const recv = performance.now();
    graph.onSnapshot(bytes);
    const entities = new Map(snap.entities.map((e) => [e.id, e]));
    const s = { tick: snap.tick, recv, entities, ack: snap.ack };
    if (latest && snap.tick <= latest.tick) return; // stale (cannot happen over TCP, but be safe)
    deriveEvents(latest, s);
    buffer.push(s);
    while (buffer.length > 60) buffer.shift();
    latest = s;
    clockOffset = Math.min(...buffer.map((b) => b.recv - b.tick * TICK_MS));

    const mine = entities.get(myShipId);
    if (!mine) return;
    for (const b of snap.entities)
      if (b.kind === "bullet" && b.owner === myShipId) confirmed.add(b.seq);
    if (!predict || mine.down || !predicted) {
      pending = pending.filter((i) => i.seq > snap.ack);
      predicted = shipState(mine);
      prevPredicted = predicted;
      return;
    }
    const before = predicted;
    const r = reconcile({ server: shipState(mine), ack: snap.ack, pending });
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
  };

  conn.addEventListener("binary", (e) => {
    try {
      onSnapshot(binary.decodeSnapshot(e.detail), e.detail.byteLength);
    } catch (err) {
      console.warn("bad snapshot dropped:", err.message);
    }
  });
  conn.addEventListener("snapshot", (e) => {
    onSnapshot(json.decodeSnapshot(e.detail), JSON.stringify(e.detail).length);
  });
  conn.addEventListener("roster", (e) => {
    for (const p of e.detail.players) names.set(p.shipId, { name: p.name, color: p.color });
  });
  conn.addEventListener("pong", (e) => graph.onRtt(performance.now() - e.detail.t));
  const pinger = setInterval(() => conn.send({ type: "ping", t: performance.now() }), 500);

  /** Turn snapshot differences into game events (sounds, kill feed, explosions). */
  function deriveEvents(prev, next) {
    if (!prev) return;
    for (const [id, e] of next.entities) {
      const old = prev.entities.get(id);
      if (e.kind === "ship" && old) {
        if (!old.down && e.down) {
          const killer = [...next.entities.values()].find(
            (s) =>
              s.kind === "ship" && s.id !== id && s.score > (prev.entities.get(s.id)?.score ?? 0),
          );
          emit("exploded", { target: id, by: killer?.id ?? 0 });
          explode(e.x, e.y, 1);
        } else if (e.hp < old.hp) emit("hit", { target: id });
        const gained = e.effects.find((fx) => !old.effects.includes(fx));
        if (gained) emit("pickup", { target: id, effect: gained });
      }
      if (e.kind === "bullet" && !old && e.owner !== myShipId) emit("fired", { by: e.owner });
    }
    for (const [id, old] of prev.entities) {
      if (old.kind === "balloon" && !next.entities.has(id)) {
        emit("popped", { target: id });
        explode(old.x, old.y, 0.6);
      }
    }
  }

  function explode(x, y, size) {
    // cosmetic only, so Math.random is fine here (it never touches the shared sim)
    const parts = Array.from({ length: Math.round(28 * size) }, () => {
      const a = Math.random() * Math.PI * 2;
      const sp = (40 + Math.random() * 180) * size;
      return { x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 2 + Math.random() * 3 };
    });
    explosions.push({ ttl: 0.9, parts });
  }

  // ── fixed step: sample input, send, predict ──────────────────────────────
  function simulate(dt) {
    simTime += dt;
    const c = readControls(input);
    input.endStep();
    const inp = { seq: ++seq, thrust: c.thrust, turn: c.turn, fire: c.fire };
    sent.push(inp);
    if (sent.length > REDUNDANCY) sent.shift();
    if (codec === "json") conn.sendRaw(json.encodeInputs(sent));
    else conn.sendRaw(binary.encodeInputs(sent));
    pending.push(inp);
    if (pending.length > 90) pending.shift(); // 3 s without acks: something is very wrong
    graph.state.pending = pending.length;

    const mine = latest?.entities.get(myShipId);
    if (predict && predicted && mine && !mine.down) {
      prevPredicted = predicted;
      predicted = integrate(predicted, inp, dt);
      localCooldown = Math.max(0, localCooldown - dt);
      if (inp.fire && localCooldown === 0 && !mine.effects.includes("homing")) {
        localCooldown = mine.effects.includes("rapid") ? COOLDOWN.rapid : COOLDOWN.normal;
        const nx = predicted.x + Math.cos(predicted.angle) * 24;
        const ny = predicted.y + Math.sin(predicted.angle) * 24;
        localBullets.set(inp.seq, {
          seq: inp.seq,
          x: nx,
          y: ny,
          vx: predicted.vx + Math.cos(predicted.angle) * BULLET.SPEED,
          vy: predicted.vy + Math.sin(predicted.angle) * BULLET.SPEED,
          angle: predicted.angle,
          ttl: BULLET.TTL,
          born: performance.now(),
        });
        emit("fired", { by: myShipId });
      }
    }
    for (const [k, b] of localBullets) {
      b.x = wrap(b.x + b.vx * dt, ARENA.width);
      b.y = wrap(b.y + b.vy * dt, ARENA.height);
      b.ttl -= dt;
      const serverHasIt =
        latest &&
        [...latest.entities.values()].some(
          (e) => e.kind === "bullet" && e.owner === myShipId && e.seq === k,
        );
      const goneOnServer = confirmed.has(k) && !serverHasIt;
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
    while (explosions.length && explosions[0].ttl <= 0) explosions.shift();
    hud.update(dt);
  }

  // ── render: interpolate others in the past, own ship in the present ──────
  function sampleRemote(now) {
    if (buffer.length === 0) return null;
    const renderTick = (now - clockOffset - graph.state.interpDelayMs) / TICK_MS;
    let a = null;
    let b = null;
    for (let i = buffer.length - 1; i > 0; i--) {
      if (buffer[i - 1].tick <= renderTick) {
        a = buffer[i - 1];
        b = buffer[i];
        break;
      }
    }
    if (!a) {
      if (renderTick > latest.tick) graph.state.underruns++;
      return { entities: latest.entities, t: 0, a: latest };
    }
    const t = Math.min(1, (renderTick - a.tick) / (b.tick - a.tick));
    const out = new Map();
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
    return { entities: out };
  }

  function render(alpha, stats) {
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

    const remote = sampleRemote(now);
    const ships = [];
    if (remote) {
      for (const e of remote.entities.values()) {
        const pos = { x: e.x, y: e.y };
        if (e.kind === "balloon") sprites.balloon(ctx, { radius: e.radius, homing: e.hunter }, pos);
        else if (e.kind === "pickup")
          sprites.pickup(ctx, { pickup: { effect: e.effect } }, pos, simTime * 2);
        else if (e.kind === "bullet") {
          if (e.owner === myShipId && predict && localBullets.has(e.seq)) continue; // drawn locally
          sprites.bullet(ctx, { homing: e.homing }, pos, e.angle);
        } else if (e.kind === "ship" && e.id !== myShipId) ships.push(e);
      }
    }
    for (const b of localBullets.values()) sprites.bullet(ctx, {}, b, b.angle);

    const mine = latest?.entities.get(myShipId);
    if (mine) {
      if (predict && predicted && prevPredicted && !mine.down) {
        const x =
          prevPredicted.x + wrapDelta(prevPredicted.x, predicted.x, ARENA.width) * alpha + smooth.x;
        const y =
          prevPredicted.y +
          wrapDelta(prevPredicted.y, predicted.y, ARENA.height) * alpha +
          smooth.y;
        ships.push({
          ...mine,
          x: wrap(x, ARENA.width),
          y: wrap(y, ARENA.height),
          angle: lerpAngle(prevPredicted.angle, predicted.angle, alpha),
          thrust: predicted.thrust,
        });
      } else ships.push(mine); // no prediction: the newest snapshot, i.e. one RTT late
    }
    for (const s of ships) {
      if (s.down) continue;
      const info = names.get(s.id) ?? { name: `#${s.id}`, color: "#7f8c8d" };
      const fake = {
        color: info.color,
        thrust: s.thrust,
        effects: new Set(s.effects),
        radius: 18,
        hp: s.hp,
        name: info.name,
      };
      sprites.ship(ctx, fake, s, s.angle, simTime);
      drawLabel(ctx, fake, s);
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
    const scoreShips = latest
      ? [...latest.entities.values()]
          .filter((e) => e.kind === "ship")
          .map((e) => ({
            name: nameOf(e.id),
            color: names.get(e.id)?.color ?? "#7f8c8d",
            score: e.score,
            effects: new Set(e.effects),
          }))
      : [];
    drawScoreboard(ctx, scoreShips, view.width);
    hud.draw(ctx, view);
    graph.draw(ctx, view);
  }

  // live tuning of the interpolation delay
  const onKey = (e) => {
    if (e.code === "BracketLeft")
      graph.state.interpDelayMs = Math.max(0, graph.state.interpDelayMs - 16);
    if (e.code === "BracketRight") graph.state.interpDelayMs += 16;
  };
  window.addEventListener("keydown", onKey);

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
    /** The own ship as the player SEES it (for the input-latency measurement). */
    get own() {
      const mine = latest?.entities.get(myShipId);
      return predict && predicted && mine && !mine.down ? predicted : mine;
    },
    stop() {
      loop.stop();
      clearInterval(pinger);
      window.removeEventListener("keydown", onKey);
    },
  };
}

function shipState(e) {
  return { x: e.x, y: e.y, vx: e.vx, vy: e.vy, angle: e.angle, thrust: e.thrust };
}

function drawLabel(ctx, s, pos) {
  if (s.effects.has("shield")) {
    ctx.strokeStyle = "rgba(41,128,185,0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, s.radius + 8, 0, Math.PI * 2);
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
