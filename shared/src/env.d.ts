/*
 * The ONLY globals shared/ may use: things that exist identically in browsers
 * and in Node ≥ 19. shared/tsconfig.json has `lib: ["es2023"]` and no `types`,
 * so `document`, `window`, `Buffer`, `process`… are compile errors here —
 * the "no DOM, no Node built-ins" rule of Lab 5 is now enforced by tsc.
 */
declare class Event {
  constructor(type: string);
  readonly type: string;
}

declare class CustomEvent<T = unknown> extends Event {
  constructor(type: string, init?: { detail?: T });
  readonly detail: T;
}

interface SharedListenerOptions {
  once?: boolean;
  signal?: AbortSignal;
}

declare class EventTarget {
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: SharedListenerOptions,
  ): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
}

declare class TextDecoder {
  decode(input?: ArrayBuffer | ArrayBufferView): string;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class AbortSignal extends EventTarget {
  readonly aborted: boolean;
}
