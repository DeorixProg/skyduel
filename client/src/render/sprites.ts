import type { Effect } from "@skyduel/shared/sim/entity.ts";
import { z } from "zod";
import {
  drawBalloon,
  drawBullet,
  drawPickup,
  drawShip,
  type Point,
  type ShipPose,
} from "./draw.ts";

export const SHIP_COLORS = [
  "#c0392b",
  "#2c3e50",
  "#27ae60",
  "#d4ac0d",
  "#8e44ad",
  "#d35400",
] as const;

/** The atlas is loaded over the network: validate it before trusting it. */
export const AtlasSchema = z.object({
  cell: z.number(),
  scale: z.number().positive(),
  frames: z.record(
    z.string(),
    z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  ),
});
export type Atlas = z.infer<typeof AtlasSchema>;

export interface Sprites {
  readonly usingSheet: boolean;
  ship(
    ctx: CanvasRenderingContext2D,
    ship: { color: string; thrust: boolean },
    pose: ShipPose,
    time: number,
  ): void;
  bullet(ctx: CanvasRenderingContext2D, homing: boolean, pos: Point, angle: number): void;
  balloon(ctx: CanvasRenderingContext2D, b: { radius: number; hunter: boolean }, pos: Point): void;
  pickup(ctx: CanvasRenderingContext2D, effect: Effect, pos: Point, angle: number): void;
}

/**
 * Sprite renderer: `drawImage` with source rectangles from the sprite sheet.
 * If the sheet or its atlas failed to load (404, corrupt JSON), every call falls
 * back to the vector drawing from Labs 1–2 — the game still starts.
 */
// frame names built once: a template string per sprite per frame is garbage per frame
const COLOR_INDEX: ReadonlyMap<string, number> = new Map(SHIP_COLORS.map((c, i) => [c, i]));
const SHIP_FRAMES = SHIP_COLORS.map((_, i) => [`ship${i}`, `ship${i}_thrust`] as const);
const PICKUP_FRAMES: Record<Effect, string> = {
  shield: "pickup_shield",
  rapid: "pickup_rapid",
  homing: "pickup_homing",
};

export function createSprites(sheet: ImageBitmap | null, atlas: Atlas | null): Sprites {
  function frame(
    ctx: CanvasRenderingContext2D,
    name: string,
    x: number,
    y: number,
    angle = 0,
    size = 1,
  ): boolean {
    const f = atlas?.frames[name];
    if (!sheet || !atlas || !f) return false;
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
    usingSheet: Boolean(sheet && atlas),
    ship(ctx, ship, pose, time) {
      const i = COLOR_INDEX.get(ship.color) ?? 0;
      if (
        frame(ctx, SHIP_FRAMES[i]?.[ship.thrust ? 1 : 0] ?? "ship0", pose.x, pose.y, pose.angle)
      ) {
        // the propeller still spins procedurally on top of the static sprite
        ctx.save();
        ctx.translate(pose.x, pose.y);
        ctx.rotate(pose.angle);
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
      drawShip(ctx, pose, { color: ship.color, time });
    },
    bullet(ctx, homing, pos, angle) {
      if (!frame(ctx, homing ? "bullet_homing" : "bullet", pos.x, pos.y, angle))
        drawBullet(ctx, homing, pos, angle);
    },
    balloon(ctx, b, pos) {
      if (!frame(ctx, b.hunter ? "balloon_hunter" : "balloon", pos.x, pos.y, 0, b.radius / 28))
        drawBalloon(ctx, b, pos);
    },
    pickup(ctx, effect, pos, angle) {
      if (!frame(ctx, PICKUP_FRAMES[effect], pos.x, pos.y, angle))
        drawPickup(ctx, effect, pos, angle);
    },
  };
}
