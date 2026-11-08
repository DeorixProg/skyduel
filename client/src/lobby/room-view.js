/**
 * Room side panel: connection status, roster and chat. DOM only — it listens
 * to the Connection's events and calls conn.send().
 */
export function mountRoomView(root, conn, { room, selfName }) {
  root.innerHTML = `
    <div class="side">
      <div class="side-head"><b></b> <span id="net" class="muted">підключення…</span></div>
      <h3>Пілоти</h3><ul id="roster"></ul>
      <h3>Чат</h3><div id="chatlog"></div>
      <form id="chatform"><input id="chatin" maxlength="200" placeholder="Enter — написати" autocomplete="off" /></form>
    </div>`;
  root.hidden = false;
  root.querySelector(".side-head b").textContent = room.name;
  const net = root.querySelector("#net");
  const roster = root.querySelector("#roster");
  const log = root.querySelector("#chatlog");
  const form = root.querySelector("#chatform");
  const input = root.querySelector("#chatin");
  const ac = new AbortController();
  const on = (type, fn) => conn.addEventListener(type, fn, { signal: ac.signal });

  const line = (text, cls = "") => {
    const p = document.createElement("p");
    p.className = cls;
    p.textContent = text; // textContent, never innerHTML: chat is untrusted input
    log.append(p);
    while (log.children.length > 60) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  };

  on("open", () => {
    net.textContent = "online";
    net.className = "ok";
  });
  on("welcome", (e) =>
    line(`ви в кімнаті «${e.detail.room.name}» як #${e.detail.playerId}`, "sys"),
  );
  on("roster", (e) => {
    roster.replaceChildren(
      ...e.detail.players.map((p) => {
        const li = document.createElement("li");
        li.textContent = p.name === selfName ? `${p.name} (ви)` : p.name;
        return li;
      }),
    );
  });
  on("chat", (e) => line(`${e.detail.name}: ${e.detail.text}`));
  on("shutdown", () => line("сервер перезапускається…", "sys"));
  on("close", (e) => {
    const { code, willRetry, inMs } = e.detail;
    net.textContent = willRetry
      ? `offline, повтор через ${(inMs / 1000).toFixed(1)} с`
      : `закрито (${code})`;
    net.className = "error";
    line(`з'єднання закрито, код ${code}${e.detail.reason ? `: ${e.detail.reason}` : ""}`, "sys");
  });

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code === "Enter" && document.activeElement !== input) {
        e.preventDefault();
        input.focus();
      }
    },
    { signal: ac.signal },
  );
  form.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (text) conn.send({ type: "chat", text });
      input.value = "";
      input.blur();
    },
    { signal: ac.signal },
  );

  return {
    unmount() {
      ac.abort();
      root.hidden = true;
      root.replaceChildren();
    },
  };
}
