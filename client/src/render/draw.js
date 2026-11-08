import { ARENA } from "@skyduel/shared/sim/arena.js";

const clouds = makeClouds(14, 7);

/** Deterministic cloud layout, so the background is the same on every reload. */
function makeClouds(n, seed) {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  return Array.from({ length: n }, () => ({
    x: rnd() * ARENA.width,
    y: rnd() * ARENA.height,
    r: 30 + rnd() * 50,
  }));
}

export function drawBackground(ctx, sky = ["#5b9bd5", "#a9d2f0"]) {
  const g = ctx.createLinearGradient(0, 0, 0, ARENA.height);
  g.addColorStop(0, sky[0]);
  g.addColorStop(1, sky[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, ARENA.width, ARENA.height);

  // grid: makes motion readable even over an empty sky
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= ARENA.width; x += 100) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ARENA.height);
  }
  for (let y = 0; y <= ARENA.height; y += 100) {
    ctx.moveTo(0, y);
    ctx.lineTo(ARENA.width, y);
  }
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.55)";
  for (const c of clouds) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.arc(c.x + c.r * 0.8, c.y + c.r * 0.2, c.r * 0.7, 0, Math.PI * 2);
    ctx.arc(c.x - c.r * 0.8, c.y + c.r * 0.25, c.r * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Top-down biplane drawn at the origin pointing along +x; the canvas
 * transform (translate + rotate) places it in the world.
 */
export function drawShip(ctx, ship, { color = "#c0392b", time = 0 } = {}) {
  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.angle);

  if (ship.thrust) {
    const len = 10 + 6 * Math.sin(time * 40); // flickering exhaust flames
    ctx.fillStyle = "rgba(255,170,40,0.9)";
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(4, side * 5);
      ctx.lineTo(-len, side * 9);
      ctx.lineTo(4, side * 9);
      ctx.fill();
    }
  }

  ctx.fillStyle = "#5d4037"; // tailplane
  ctx.fillRect(-20, -9, 6, 18);
  ctx.fillStyle = color; // fuselage
  ctx.beginPath();
  ctx.ellipse(0, 0, 20, 4.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shade(color); // lower wing
  ctx.fillRect(-2, -22, 8, 44);
  ctx.fillStyle = color; // upper wing, offset forward: the "bi" in biplane
  ctx.fillRect(3, -20, 8, 40);
  ctx.strokeStyle = "#3e2723";
  ctx.lineWidth = 1;
  ctx.strokeRect(3, -20, 8, 40);
  ctx.fillStyle = "#212121"; // cockpit
  ctx.beginPath();
  ctx.arc(-6, 0, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(30,30,30,0.8)"; // spinning propeller
  ctx.lineWidth = 2;
  const p = Math.sin(time * 60) * 11;
  ctx.beginPath();
  ctx.moveTo(21, -p);
  ctx.lineTo(21, p);
  ctx.stroke();
  ctx.restore();
}

function shade(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(v * 0.7);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

export function drawHud(ctx, stats, extra = []) {
  const lines = [
    `steps/s  ${stats.stepsPerSec.toFixed(1)}`,
    `frames/s ${stats.framesPerSec.toFixed(1)}`,
    `frame    ${stats.frameMs.toFixed(2)} ms`,
    ...extra,
  ];
  ctx.save();
  ctx.font = "13px ui-monospace, Consolas, monospace";
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(8, 8, 190, 10 + lines.length * 17);
  ctx.fillStyle = "#e8f5e9";
  lines.forEach((line, i) => {
    ctx.fillText(line, 16, 26 + i * 17);
  });
  ctx.restore();
}

export function drawBullet(ctx, b, pos = b.pos, angle = b.angle) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(angle);
  ctx.fillStyle = b.homing ? "#8e44ad" : "#212121";
  ctx.fillRect(-5, -1.5, 10, 3);
  ctx.restore();
}

export function drawBalloon(ctx, b, pos = b.pos) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.fillStyle = "rgba(0,0,0,0.15)"; // shadow
  ctx.beginPath();
  ctx.ellipse(6, 8, b.radius, b.radius * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = b.homing ? "#7f8c8d" : "#95a5a6";
  ctx.beginPath();
  ctx.ellipse(0, 0, b.radius, b.radius * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#566573";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = b.homing ? "#c0392b" : "#566573"; // hunters have a red stripe
  ctx.fillRect(-b.radius * 0.7, -2, b.radius * 1.4, 4);
  ctx.restore();
}

const PICKUP_COLORS = { shield: "#2980b9", rapid: "#e67e22", homing: "#8e44ad" };
const PICKUP_LETTER = { shield: "S", rapid: "R", homing: "H" };

export function drawPickup(ctx, p, pos = p.pos, angle = p.angle) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(angle);
  ctx.fillStyle = PICKUP_COLORS[p.pickup.effect];
  ctx.fillRect(-11, -11, 22, 22);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.strokeRect(-11, -11, 22, 22);
  ctx.rotate(-angle);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 14px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(PICKUP_LETTER[p.pickup.effect], 0, 1);
  ctx.restore();
}

export function drawExplosion(ctx, e) {
  const k = Math.max(0, e.ttl / 0.9);
  ctx.fillStyle = `rgba(${200 + 55 * k},${80 + 120 * k},30,${k})`;
  for (const p of e.particles) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * (0.5 + k), 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawScoreboard(ctx, ships, viewWidth) {
  const rows = [...ships].sort((a, b) => b.score - a.score);
  ctx.save();
  ctx.font = "14px ui-monospace, Consolas, monospace";
  const w = 200;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(viewWidth - w - 8, 8, w, 14 + rows.length * 18);
  rows.forEach((s, i) => {
    ctx.fillStyle = s.color;
    ctx.fillRect(viewWidth - w, 17 + i * 18, 10, 10);
    ctx.fillStyle = "#ecf0f1";
    const fx = [...s.effects.keys()].map((k) => k[0].toUpperCase()).join("");
    ctx.fillText(
      `${s.name.padEnd(9)} ${String(s.score).padStart(3)} ${fx}`,
      viewWidth - w + 16,
      27 + i * 18,
    );
  });
  ctx.restore();
}
