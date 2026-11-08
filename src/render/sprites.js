import { drawBalloon, drawBullet, drawPickup, drawShip } from "./draw.js";

export const SHIP_COLORS = ["#c0392b", "#2c3e50", "#27ae60", "#d4ac0d", "#8e44ad", "#d35400"];

/**
 * Sprite renderer: `drawImage` with source rectangles from the sprite sheet.
 * If the sheet or its atlas failed to load (404, corrupt JSON), every call falls
 * back to the vector drawing from Lab 1–2 — the game still starts.
 */
export function createSprites(sheet, atlas) {
  const ok = Boolean(sheet && atlas?.frames);

  function frame(ctx, name, x, y, angle = 0, size = 1) {
    const f = atlas.frames[name];
    if (!f) return false;
    const w = (f.w / atlas.scale) * size;
    const h = (f.h / atlas.scale) * size;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.drawImage(sheet, f.x, f.y, f.w, f.h, -w / 2, -h / 2, w, h);
    ctx.restore();
    return true;
  }

  return {
    usingSheet: ok,
    ship(ctx, ship, pos, angle, time) {
      const i = Math.max(0, SHIP_COLORS.indexOf(ship.color));
      if (ok && frame(ctx, `ship${i}${ship.thrust ? "_thrust" : ""}`, pos.x, pos.y, angle)) {
        // the propeller still spins procedurally on top of the static sprite
        ctx.save();
        ctx.translate(pos.x, pos.y);
        ctx.rotate(angle);
        ctx.strokeStyle = "rgba(30,30,30,0.8)";
        ctx.lineWidth = 2;
        const p = Math.sin(time * 60) * 11;
        ctx.beginPath();
        ctx.moveTo(21, -p);
        ctx.lineTo(21, p);
        ctx.stroke();
        ctx.restore();
        return;
      }
      drawShip(
        ctx,
        { x: pos.x, y: pos.y, angle, thrust: ship.thrust },
        { color: ship.color, time },
      );
    },
    bullet(ctx, b, pos, angle) {
      if (ok && frame(ctx, b.homing ? "bullet_homing" : "bullet", pos.x, pos.y, angle)) return;
      drawBullet(ctx, b, pos, angle);
    },
    balloon(ctx, b, pos) {
      if (ok && frame(ctx, b.homing ? "balloon_hunter" : "balloon", pos.x, pos.y, 0, b.radius / 28))
        return;
      drawBalloon(ctx, b, pos);
    },
    pickup(ctx, p, pos, angle) {
      if (ok && frame(ctx, `pickup_${p.pickup.effect}`, pos.x, pos.y, angle)) return;
      drawPickup(ctx, p, pos, angle);
    },
  };
}
