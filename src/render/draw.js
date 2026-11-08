import { ARENA } from "../sim/arena.js";

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

export function drawBackground(ctx) {
  const g = ctx.createLinearGradient(0, 0, 0, ARENA.height);
  g.addColorStop(0, "#5b9bd5");
  g.addColorStop(1, "#a9d2f0");
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
