/**
 * How main's parts see time: a clock and timers, injectable so the tests can drive presence (offline after a silence,
 * throttled `lastHeardAt` writes) without waiting. index.ts plugs in the real ones.
 */

/** Timer functions. Handles are opaque. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The global timers, looked up at call time (the plugin host patches them to track and clear them). */
export const GLOBAL_TIMERS: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Milliseconds since the epoch, like `Date.now`. */
export type Clock = () => number;

export const iso = (ms: number): string => new Date(ms).toISOString();
