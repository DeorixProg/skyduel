import type { Bus } from "@skyduel/shared/bus.ts";
import type { Effect } from "@skyduel/shared/sim/entity.ts";
import type { SimEvents } from "@skyduel/shared/sim/world.ts";
import type { EntityId } from "@skyduel/shared/types.ts";

export interface Hud {
  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D, view: { width: number; height: number }): void;
  dispose(): void;
}

const EFFECT_NAMES: Record<Effect, string> = {
  shield: "щит",
  rapid: "скорострільність",
  homing: "самонаведення",
};

/**
 * HUD state fed by the typed event bus: kill feed and pick-ups.
 * Like audio.ts, it only listens — the simulation does not know it exists.
 */
export function createHud(
  bus: Bus<SimEvents>,
  { nameOf }: { nameOf: (id: EntityId) => string },
): Hud {
  const feed: Array<{ text: string; ttl: number }> = [];
  const ac = new AbortController();
  const push = (text: string) => {
    feed.unshift({ text, ttl: 4 });
    feed.length = Math.min(feed.length, 5);
  };

  bus.on(
    "exploded",
    ({ target, by }) =>
      push(by ? `${nameOf(by)} ✈ збив ${nameOf(target)}` : `${nameOf(target)} розбився`),
    { signal: ac.signal },
  );
  bus.on(
    "pickup",
    ({ target, effect }) => push(`${nameOf(target)} підібрав: ${EFFECT_NAMES[effect]}`),
    {
      signal: ac.signal,
    },
  );

  return {
    update(dt) {
      for (const f of feed) f.ttl -= dt;
      while ((feed.at(-1)?.ttl ?? 1) <= 0) feed.pop();
    },
    draw(ctx, view) {
      ctx.save();
      ctx.font = "14px system-ui";
      ctx.textAlign = "center";
      feed.forEach((f, i) => {
        ctx.globalAlpha = Math.min(1, f.ttl);
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        const w = ctx.measureText(f.text).width + 16;
        ctx.fillRect(view.width / 2 - w / 2, view.height - 40 - i * 24, w, 20);
        ctx.fillStyle = "#fff";
        ctx.fillText(f.text, view.width / 2, view.height - 25 - i * 24);
      });
      ctx.restore();
    },
    dispose: () => ac.abort(),
  };
}
