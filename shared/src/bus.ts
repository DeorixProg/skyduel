/**
 * Typed event bus. `Bus<{ hit: { target: EntityId } }>` makes
 * `bus.emit("hit", { target })` and `bus.on("hit", (d) => d.target)`
 * type-checked: a misspelled event name or a missing field is a compile error.
 *
 * Lab 3 used a bare EventTarget + CustomEvent; its `detail` is `unknown` to
 * the type system, so every listener would need a cast. A mapped type of
 * listener arrays gives the same API with zero casts.
 */
type Listeners<E> = { [K in keyof E]?: Array<(detail: E[K]) => void> };

export class Bus<Events extends { [K in keyof Events]: object }> {
  readonly #listeners: Listeners<Events> = {};

  emit<K extends keyof Events>(type: K, detail: Events[K]): void {
    for (const listener of this.#listeners[type] ?? []) listener(detail);
  }

  /** Subscribe; returns an unsubscribe function. An AbortSignal also unsubscribes. */
  on<K extends keyof Events>(
    type: K,
    listener: (detail: Events[K]) => void,
    options: { signal?: AbortSignal } = {},
  ): () => void {
    const list = this.#listeners[type] ?? [];
    this.#listeners[type] = list;
    list.push(listener);
    const off = () => {
      const i = list.indexOf(listener);
      if (i >= 0) list.splice(i, 1);
    };
    options.signal?.addEventListener("abort", off, { once: true });
    return off;
  }
}
