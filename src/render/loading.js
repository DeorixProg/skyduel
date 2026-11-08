/** Loading screen drawn on the canvas: a real progress bar plus per-item status. */
const ICON = { pending: "·", loading: "…", ok: "✔", skipped: "⚠", failed: "✖", retry: "↻" };

export function drawLoading(ctx, view, state) {
  const { width: W, height: H } = view;
  ctx.fillStyle = "#0b1d2e";
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = "#ecf0f1";
  ctx.font = "bold 40px system-ui";
  ctx.fillText("SkyDuel", W / 2, H / 2 - 120);
  ctx.font = "16px system-ui";
  ctx.fillText(state.title, W / 2, H / 2 - 80);

  const bw = Math.min(520, W - 80);
  const x = (W - bw) / 2;
  const y = H / 2 - 55;
  ctx.fillStyle = "#1f3a52";
  ctx.fillRect(x, y, bw, 22);
  ctx.fillStyle = state.error ? "#c0392b" : "#27ae60";
  ctx.fillRect(x, y, bw * (state.total ? state.done / state.total : 0), 22);
  ctx.strokeStyle = "#ecf0f1";
  ctx.strokeRect(x, y, bw, 22);
  ctx.fillStyle = "#fff";
  ctx.font = "13px ui-monospace, Consolas, monospace";
  ctx.fillText(`${state.done} / ${state.total}`, W / 2, y + 16);

  ctx.textAlign = "left";
  let row = y + 50;
  for (const [id, s] of state.items) {
    ctx.fillStyle =
      s.state === "failed" ? "#e74c3c" : s.state === "skipped" ? "#f1c40f" : "#bdc3c7";
    const note = s.note ? `  ${s.note}` : "";
    ctx.fillText(`${ICON[s.state] ?? "?"} ${id.padEnd(10)} ${s.state}${note}`.slice(0, 80), x, row);
    row += 18;
  }
  if (state.error) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#e74c3c";
    ctx.font = "15px system-ui";
    ctx.fillText(state.error, W / 2, row + 16);
  }
  ctx.restore();
}
