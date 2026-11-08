/**
 * Keyboard input as a closure: the key sets are private, the returned object
 * is the whole API. Nothing outside this function can mutate `down`.
 *
 * `justPressed(code)` is edge-triggered. A keydown is remembered in `pressed`
 * until the simulation calls `endStep()`. Clearing per *step* (not per frame)
 * matters with a fixed timestep: a frame may run 0, 1 or 3 steps, and a press
 * must be seen by exactly one step — never lost, never repeated.
 */
export function createInput(target = window) {
  const down = new Set();
  const pressed = new Set();

  const onDown = (e) => {
    if (!e.repeat) pressed.add(e.code);
    down.add(e.code);
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
  };
  const onUp = (e) => down.delete(e.code);
  const onBlur = () => down.clear(); // alt-tab with W held must not leave W "stuck"

  target.addEventListener("keydown", onDown);
  target.addEventListener("keyup", onUp);
  target.addEventListener("blur", onBlur);

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    endStep: () => pressed.clear(),
    dispose() {
      target.removeEventListener("keydown", onDown);
      target.removeEventListener("keyup", onUp);
      target.removeEventListener("blur", onBlur);
    },
  };
}

/** Map raw keys to the game's control intent: a plain, serializable object. */
export function readControls(input) {
  const left = input.isDown("KeyA") || input.isDown("ArrowLeft");
  const right = input.isDown("KeyD") || input.isDown("ArrowRight");
  return {
    thrust: input.isDown("KeyW") || input.isDown("ArrowUp"),
    turn: (right ? 1 : 0) - (left ? 1 : 0),
    fire: input.isDown("Space"),
  };
}
