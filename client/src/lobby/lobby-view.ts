import type { RoomInfo } from "@skyduel/shared/protocol.ts";
import type { Lobby } from "./lobby.ts";

/** Typed querySelector: throws if the element is missing or of the wrong class (no `as`). */
export function $<T extends Element>(root: ParentNode, selector: string, type: new () => T): T {
  const el = root.querySelector(selector);
  if (!(el instanceof type)) throw new Error(`${selector}: expected ${type.name}`);
  return el;
}

/**
 * DOM rendering of the lobby. It only listens to Lobby events and calls
 * lobby.join(); all network logic stays in lobby.ts.
 */
export function mountLobbyView(
  root: HTMLElement,
  lobby: Lobby,
  { defaultName = "Maksym" } = {},
): { unmount(): void } {
  root.innerHTML = `
    <div class="panel">
      <h1>SkyDuel</h1>
      <label>Ім'я пілота <input id="pilot" maxlength="16" /></label>
      <h2>Кімнати</h2>
      <ul id="rooms"><li class="muted">завантаження…</li></ul>
      <form id="create"><input id="newroom" maxlength="32" placeholder="нова кімната" /> <button type="submit">Створити</button></form>
      <p id="status" class="muted"></p>
      <button id="join" type="button" disabled>Join</button>
    </div>`;
  root.hidden = false;
  const list = $(root, "#rooms", HTMLUListElement);
  const status = $(root, "#status", HTMLParagraphElement);
  const joinBtn = $(root, "#join", HTMLButtonElement);
  const nameInput = $(root, "#pilot", HTMLInputElement);
  const createForm = $(root, "#create", HTMLFormElement);
  const newRoom = $(root, "#newroom", HTMLInputElement);
  nameInput.value = defaultName;
  let selected: string | null = null;
  const ac = new AbortController();
  const opts = { signal: ac.signal };

  function render(rooms: readonly RoomInfo[]): void {
    list.replaceChildren(
      ...rooms.map((r) => {
        const li = document.createElement("li");
        li.className = r.id === selected ? "room selected" : "room";
        li.textContent = `${r.name} — ${r.players}/${r.maxPlayers}`;
        li.dataset.id = r.id;
        li.addEventListener("click", () => {
          selected = r.id;
          joinBtn.disabled = false;
          render(lobby.rooms);
        });
        return li;
      }),
    );
  }

  lobby.events.on(
    "rooms",
    ({ rooms, at }) => {
      render(rooms);
      status.textContent = `оновлено ${at.toLocaleTimeString("uk-UA")} · запитів: ${lobby.requests}`;
      status.className = "muted";
    },
    opts,
  );
  lobby.events.on(
    "error",
    ({ error }) => {
      const why = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      status.textContent = `не вдалося оновити список: ${why} — повтор через ${lobby.intervalMs / 1000} с`;
      status.className = "error";
    },
    opts,
  );
  lobby.events.on(
    "joining",
    ({ room }) => {
      joinBtn.disabled = true;
      status.textContent = `приєднуємось до «${room.name}»…`;
    },
    opts,
  );

  createForm.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      const name = newRoom.value.trim();
      if (!name) return;
      lobby
        .createRoom(name)
        .then((room) => {
          selected = room.id;
          joinBtn.disabled = false;
          render(lobby.rooms);
          newRoom.value = "";
        })
        .catch((err: unknown) => {
          status.textContent = `не вдалося створити кімнату: ${err instanceof Error ? err.message : String(err)}`;
          status.className = "error";
        });
    },
    opts,
  );

  joinBtn.addEventListener(
    "click",
    () => {
      if (selected) void lobby.join(selected, nameInput.value.trim());
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
