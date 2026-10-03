import type { PreviewRequest } from "../model.ts";

/** A standing wall preview is renewed this often, each time with a lease this long, so a closed tab lets it lapse. */
export const RENEW_MS = 1500;
export const LEASE_MS = 4000;
/** The shortest lease main accepts (shared/ui-channel.ts: `ttlMs` ≥ 500). */
export const MIN_LEASE_MS = 500;
/** At most one request per this many ms; the latest one always lands. */
export const THROTTLE_MS = 120;

/** A preview for the wall without its lease: the lease sets and renews `ttlMs`. */
export type WallRequest = Omit<PreviewRequest, "mode" | "ttlMs"> & { readonly mode: "identify" | "fill" | "order" };

/** Time and timers, injectable so tests can drive the lease deterministically. */
export interface LeaseClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const SYSTEM_CLOCK: LeaseClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

/** The wall channel of the editor's previews: what it shows, and how to let go. */
export interface WallLease {
  /** Shows `request` until replaced or cleared (null), or for `ms`, renewing its lease meanwhile. */
  show(request: WallRequest | null, ms?: number): void;
  /** Sends what is showing again now, without waiting for the next renewal: main may no longer hold it. */
  resend(): void;
  /** Stops renewing and clears anything still showing (unmount). */
  release(): void;
}

/**
 * Leased `preview` requests for the wall. A standing one is re-sent every `RENEW_MS` with a `LEASE_MS` lease, so the
 * wall falls back by itself if the interface goes away; a timed one is sent with a lease that ends with it. Clearing
 * sends `mode: "none"` (only if something was showing). Requests are throttled to one per `THROTTLE_MS`, and the
 * latest one always lands.
 */
export function createWallLease(
  send: (request: PreviewRequest) => Promise<void>,
  clock: LeaseClock = SYSTEM_CLOCK,
): WallLease {
  let request: WallRequest | null = null;
  let key = "";
  let until: number | null = null;
  let sentAt = Number.NEGATIVE_INFINITY;
  let shown = false;
  let trailing: unknown = null;
  let renewal: unknown = null;

  const fire = (r: PreviewRequest) => void send(r).catch(() => undefined);

  const flush = () => {
    const now = clock.now();
    const wait = sentAt + THROTTLE_MS - now;
    if (wait > 0) {
      trailing ??= clock.setTimeout(() => {
        trailing = null;
        flush();
      }, wait);
      return;
    }
    if (request) {
      const left = until === null ? LEASE_MS : until - now;
      if (left <= 0) return;
      sentAt = now;
      shown = true;
      fire({ ...request, ttlMs: Math.round(Math.min(LEASE_MS, Math.max(MIN_LEASE_MS, left))) });
    } else if (shown) {
      sentAt = now;
      shown = false;
      fire({ mode: "none" });
    }
  };

  const stopRenewal = () => {
    if (renewal !== null) clock.clearInterval(renewal);
    renewal = null;
  };

  const renew = () => {
    if (!request) return stopRenewal();
    if (until !== null && clock.now() >= until) {
      // A timed request ends on its own: its last lease ran out with it.
      request = null;
      key = "";
      until = null;
      shown = false;
      return stopRenewal();
    }
    flush();
  };

  return {
    show(next, ms) {
      const nextKey = next ? JSON.stringify(next) : "";
      const nextUntil = next && ms !== undefined ? clock.now() + ms : null;
      // The same standing request is already being renewed.
      if (nextKey === key && nextUntil === null && until === null) return;
      request = next;
      key = nextKey;
      until = nextUntil;
      stopRenewal();
      if (next) renewal = clock.setInterval(renew, RENEW_MS);
      flush();
    },
    resend() {
      if (request) flush();
    },
    release() {
      stopRenewal();
      if (trailing !== null) clock.clearTimeout(trailing);
      trailing = null;
      request = null;
      key = "";
      until = null;
      if (shown) {
        shown = false;
        sentAt = clock.now();
        fire({ mode: "none" });
      }
    },
  };
}
