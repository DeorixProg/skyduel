/**
 * HUD state fed by the world's event bus: kill feed and score pop-ups.
 * Like audio.js, it only listens — the simulation does not know it exists.
 */
export function createHud(bus, { nameOf }) {
  const feed = []; // { text, ttl }
  const ac = new AbortController();
  const push = (text) => {
    feed.unshift({ text, ttl: 4 });
    feed.length = Math.min(feed.length, 5);
  };
  const on = (type, fn) => bus.addEventListener(type, fn, { signal: ac.signal });

  on("exploded", (e) => {
    const { target, by } = e.detail;
    push(by ? `${nameOf(by)} ✈ збив ${nameOf(target)}` : `${nameOf(target)} розбився`);
  });
  on("pickup", (e) => {
    const names = { shield: "щит", rapid: "скорострільність", homing: "самонаведення" };
    push(`${nameOf(e.detail.target)} підібрав: ${names[e.detail.effect]}`);
  });

  return {
    update(dt) {
      for (const f of feed) f.ttl -= dt;
      while (feed.length && feed.at(-1).ttl <= 0) feed.pop();
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
