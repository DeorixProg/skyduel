/**
 * DPR-aware canvas. The backing store is cssSize × devicePixelRatio pixels and
 * the context is scaled, so drawing code works in CSS pixels. Without this
 * every line is blurry on a 2× (retina or 150 % Windows scaling) display.
 */
export function setupCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const view = { ctx, width: 0, height: 0, dpr: 1 };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    Object.assign(view, { width, height, dpr });
  }

  resize();
  window.addEventListener("resize", resize);
  // DPR changes when the window moves to another monitor or the page is zoomed
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", resize);
  return view;
}

/** Fit the fixed-size arena into the viewport (letterboxed, aspect preserved). */
export function cameraFor(view, arena) {
  const scale = Math.min(view.width / arena.width, view.height / arena.height);
  return {
    scale,
    ox: (view.width - arena.width * scale) / 2,
    oy: (view.height - arena.height * scale) / 2,
  };
}
