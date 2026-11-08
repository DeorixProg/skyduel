/**
 * Object pool: reuse short-lived objects (particles, bullets) instead of
 * allocating new ones every frame, so the garbage collector has nothing to do
 * during play. `reset` re-initialises a reused object; callers must not keep
 * references to released items.
 */
export class Pool<T> {
  readonly #free: T[] = [];
  readonly #create: () => T;
  created = 0;

  constructor(create: () => T, prefill = 0) {
    this.#create = create;
    for (let i = 0; i < prefill; i++) this.#free.push(this.#make());
  }

  #make(): T {
    this.created++;
    return this.#create();
  }

  acquire(): T {
    return this.#free.pop() ?? this.#make();
  }

  release(item: T): void {
    this.#free.push(item);
  }

  get available(): number {
    return this.#free.length;
  }
}
