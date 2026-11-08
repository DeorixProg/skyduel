/**
 * An offscreen layer for slowly changing text (HUD, scoreboard, netgraph).
 * `fillText` is expensive and builds new strings every call; redrawing the
 * text only every `intervalMs` and blitting the cached bitmap each frame keeps
 * both CPU time and garbage per frame near zero.
 */
export interface Overlay {
  draw(
    ctx: CanvasRenderingContext2D,
    view: { width: number; height: number; dpr: number },
    now: number,
    paint: (octx: CanvasRenderingContext2D) => void,
  ): void;
}

export function createOverlay(intervalMs: number): Overlay {
  const canvas = document.createElement("canvas");
  const octx = canvas.getContext("2d");
  let last = Number.NEGATIVE_INFINITY;
  let w = 0;
  let h = 0;
  return {
    draw(ctx, view, now, paint) {
      if (!octx) {
        paint(ctx); // no 2D context for the layer: draw directly
        return;
      }
      const resized = w !== view.width || h !== view.height;
      if (resized) {
        w = view.width;
        h = view.height;
        canvas.width = Math.round(w * view.dpr);
        canvas.height = Math.round(h * view.dpr);
      }
      if (resized || now - last >= intervalMs) {
        last = now;
        octx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
        octx.clearRect(0, 0, w, h);
        paint(octx);
      }
      ctx.drawImage(canvas, 0, 0, w, h);
    },
  };
}
