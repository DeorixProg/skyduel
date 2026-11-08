export function probe() {
  const out = {};
  const fns = {
    sin: Math.sin,
    cos: Math.cos,
    atan2: (x) => Math.atan2(x, 0.7),
    hypot: (x) => Math.hypot(x, 0.3),
    exp: Math.exp,
    imul: (x) => Math.imul(x * 1e9, 7),
  };
  for (const [k, f] of Object.entries(fns)) {
    let acc = "";
    for (let i = 1; i < 2000; i++) {
      const x = ((i * 0.6180339887) % 7) - 3.5 + i * 1e-3;
      acc += f(x).toString() + ",";
    }
    let h = 0x811c9dc5;
    for (let i = 0; i < acc.length; i++) h = Math.imul(h ^ acc.charCodeAt(i), 0x01000193) >>> 0;
    out[k] = h.toString(16);
  }
  return out;
}
