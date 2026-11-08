/**
 * DPR-aware canvas. The backing store is cssSize × devicePixelRatio pixels and
 * the context is scaled, so drawing code works in CSS pixels. Without this
 * every line is blurry on a 2× (retina or 150 % Windows scaling) display.
 */
export interface View {
  readonly ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
}

export interface Camera {
  scale: number;
  ox: number;
  oy: number;
}

export function setupCanvas(canvas: HTMLCanvasElement): View {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available");
  const view: View = { ctx, width: 0, height: 0, dpr: 1 };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    view.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    Object.assign(view, { width, height, dpr });
  }

  resize();
  window.addEventListener("resize", resize);
  // DPR changes when the window moves to another monitor or the page is zoomed
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", resize);
  return view;
}

/** Fit the fixed-size arena into the viewport (letterboxed, aspect preserved). */
export function cameraFor(view: View, arena: { width: number; height: number }): Camera {
  const scale = Math.min(view.width / arena.width, view.height / arena.height);
  return {
    scale,
    ox: (view.width - arena.width * scale) / 2,
    oy: (view.height - arena.height * scale) / 2,
  };
}
