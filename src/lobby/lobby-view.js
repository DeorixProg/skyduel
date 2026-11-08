/**
 * DOM rendering of the lobby. It only listens to Lobby events and calls
 * lobby.join(); all network logic stays in lobby.js.
 */
export function mountLobbyView(root, lobby, { defaultName = "Maksym" } = {}) {
  root.innerHTML = `
    <div class="panel">
      <h1>SkyDuel</h1>
      <label>Ім'я пілота <input id="pilot" maxlength="16" value="${defaultName}" /></label>
      <h2>Кімнати</h2>
      <ul id="rooms"><li class="muted">завантаження…</li></ul>
      <p id="status" class="muted"></p>
      <button id="join" disabled>Join</button>
    </div>`;
  root.hidden = false;
  const list = root.querySelector("#rooms");
  const status = root.querySelector("#status");
  const joinBtn = root.querySelector("#join");
  const nameInput = root.querySelector("#pilot");
  let selected = null;
  const ac = new AbortController();
  const on = (type, fn) => lobby.addEventListener(type, fn, { signal: ac.signal });

  function render(rooms) {
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

  on("rooms", (e) => {
    render(e.detail.rooms);
    status.textContent = `оновлено ${e.detail.at.toLocaleTimeString("uk-UA")} · запитів: ${lobby.requests}`;
    status.className = "muted";
  });
  on("error", (e) => {
    status.textContent = `не вдалося оновити список: ${e.detail.error.name}: ${e.detail.error.message} — повтор через ${lobby.intervalMs / 1000} с`;
    status.className = "error";
  });
  on("joining", (e) => {
    joinBtn.disabled = true;
    status.textContent = `приєднуємось до «${e.detail.room.name}»…`;
  });

  joinBtn.addEventListener("click", () => lobby.join(selected, nameInput.value.trim()), {
    signal: ac.signal,
  });

  return {
    unmount() {
      ac.abort();
      root.hidden = true;
      root.replaceChildren();
    },
  };
}
