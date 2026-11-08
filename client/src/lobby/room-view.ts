import type { RoomInfo } from "@skyduel/shared/protocol.ts";
import type { Connection } from "../net/connection.ts";
import { $ } from "./lobby-view.ts";

/**
 * Room side panel: connection status, roster and chat. DOM only — it listens
 * to the Connection's typed events and calls conn.send().
 */
export function mountRoomView(
  root: HTMLElement,
  conn: Connection,
  { room, selfName }: { room: RoomInfo; selfName: string },
): { unmount(): void } {
  root.innerHTML = `
    <div class="side">
      <div class="side-head"><b></b> <span id="net" class="muted">підключення…</span></div>
      <h3>Пілоти</h3><ul id="roster"></ul>
      <h3>Чат</h3><div id="chatlog"></div>
      <form id="chatform"><input id="chatin" maxlength="200" placeholder="Enter — написати" autocomplete="off" /></form>
    </div>`;
  root.hidden = false;
  $(root, ".side-head b", HTMLElement).textContent = room.name;
  const net = $(root, "#net", HTMLSpanElement);
  const roster = $(root, "#roster", HTMLUListElement);
  const log = $(root, "#chatlog", HTMLDivElement);
  const form = $(root, "#chatform", HTMLFormElement);
  const input = $(root, "#chatin", HTMLInputElement);
  const ac = new AbortController();
  const opts = { signal: ac.signal };

  const line = (text: string, cls = "") => {
    const p = document.createElement("p");
    p.className = cls;
    p.textContent = text; // textContent, never innerHTML: chat is untrusted input
    log.append(p);
    while (log.children.length > 60) log.firstChild?.remove();
    log.scrollTop = log.scrollHeight;
  };

  conn.events.on(
    "open",
    () => {
      net.textContent = "online";
      net.className = "ok";
    },
    opts,
  );
  conn.on("welcome", (m) => line(`ви в кімнаті «${m.room.name}» як #${m.playerId}`, "sys"), opts);
  conn.on(
    "roster",
    (m) => {
      roster.replaceChildren(
        ...m.players.map((p) => {
          const li = document.createElement("li");
          li.textContent = p.name === selfName ? `${p.name} (ви)` : p.name;
          return li;
        }),
      );
    },
    opts,
  );
  conn.on("chat", (m) => line(`${m.name}: ${m.text}`), opts);
  conn.on("shutdown", () => line("сервер перезапускається…", "sys"), opts);
  conn.events.on(
    "close",
    ({ code, reason, willRetry, inMs }) => {
      net.textContent = willRetry
        ? `offline, повтор через ${(inMs / 1000).toFixed(1)} с`
        : `закрито (${code})`;
      net.className = "error";
      line(`з'єднання закрито, код ${code}${reason ? `: ${reason}` : ""}`, "sys");
    },
    opts,
  );

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code === "Enter" && document.activeElement !== input) {
        e.preventDefault();
        input.focus();
      }
    },
    opts,
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
    opts,
  );

  return {
    unmount() {
      ac.abort();
      root.hidden = true;
      root.replaceChildren();
    },
  };
}
