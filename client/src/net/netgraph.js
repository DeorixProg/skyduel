/**
 * Netgraph overlay: the instrument for Lab 5. Everything here is measured on
 * the client: RTT from ping/pong, snapshot age, bytes per second both ways,
 * unacknowledged inputs, reconciliation correction, interpolation delay.
 */
export function createNetgraph() {
  const s = {
    rtt: 0,
    rttHistory: [],
    snapshotAge: 0,
    snapshotsPerSec: 0,
    bytesInPerSec: 0,
    bytesOutPerSec: 0,
    pending: 0,
    correction: 0,
    correctionMax1s: 0,
    corrections: [], // last 120 corrections (one per snapshot)
    interpDelayMs: 100,
    underruns: 0,
    codec: "binary",
    predict: true,
    netsim: { lag: 0, jitter: 0, drop: 0 },
    lastSnapshotBytes: 0,
  };
  let windowStart = performance.now();
  let snaps = 0;
  let lastIn = 0;
  let lastOut = 0;
  let maxC = 0;

  return {
    state: s,
    onSnapshot(bytes) {
      snaps++;
      s.lastSnapshotBytes = bytes;
    },
    onCorrection(dist) {
      s.correction = dist;
      maxC = Math.max(maxC, dist);
      s.corrections.push(dist);
      if (s.corrections.length > 120) s.corrections.shift();
    },
    onRtt(ms) {
      s.rtt = ms;
      s.rttHistory.push(ms);
      if (s.rttHistory.length > 20) s.rttHistory.shift();
    },
    /** Once per frame: roll the per-second counters. */
    tick(conn) {
      const now = performance.now();
      if (now - windowStart >= 1000) {
        const sec = (now - windowStart) / 1000;
        s.snapshotsPerSec = snaps / sec;
        s.bytesInPerSec = (conn.bytesIn - lastIn) / sec;
        s.bytesOutPerSec = (conn.bytesOut - lastOut) / sec;
        s.correctionMax1s = maxC;
        lastIn = conn.bytesIn;
        lastOut = conn.bytesOut;
        snaps = 0;
        maxC = 0;
        windowStart = now;
      }
    },
    draw(ctx, view) {
      const lines = [
        `RTT         ${s.rtt.toFixed(0)} ms`,
        `snap age    ${s.snapshotAge.toFixed(0)} ms   ${s.snapshotsPerSec.toFixed(0)}/s`,
        `down        ${(s.bytesInPerSec / 1024).toFixed(2)} KB/s  (${s.lastSnapshotBytes} B/snap)`,
        `up          ${(s.bytesOutPerSec / 1024).toFixed(2)} KB/s`,
        `pending in  ${s.pending}`,
        `correction  ${s.correction.toFixed(2)}  max/s ${s.correctionMax1s.toFixed(2)}`,
        `interp      ${s.interpDelayMs.toFixed(0)} ms  ([ / ])  underruns ${s.underruns}`,
        `codec ${s.codec}  predict ${s.predict ? "on" : "off"}`,
        `netsim lag ${s.netsim.lag} ±${s.netsim.jitter / 2} drop ${(s.netsim.drop * 100).toFixed(0)}%`,
      ];
      const w = 330;
      const h = 14 + lines.length * 16 + 46;
      const x = 8;
      const y = view.height - h - 8;
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(x, y, w, h);
      ctx.font = "12px ui-monospace, Consolas, monospace";
      ctx.fillStyle = "#d5f5e3";
      lines.forEach((l, i) => {
        ctx.fillText(l, x + 8, y + 18 + i * 16);
      });
      // correction history: one bar per snapshot; 36 px = 1 world unit, clipped;
      // red = a visible correction (> 0.1 unit), green = prediction was right
      const gy = y + h - 8;
      s.corrections.forEach((c, i) => {
        ctx.fillStyle = c > 0.1 ? "#e74c3c" : "#2ecc71";
        const bh = Math.max(1, Math.min(36, c * 36));
        ctx.fillRect(x + 8 + i * 2.6, gy - bh, 2, bh);
      });
      ctx.restore();
    },
  };
}
