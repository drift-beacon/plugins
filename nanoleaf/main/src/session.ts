/**
 * One stretch of driving the wall, from takeover to release or yield: the frames sent (streamed, or static writes in
 * the fallback) and the brightness applied. The Director owns the session; these helpers do its per-tick I/O.
 */
import { deviceRgb } from "../../shared/color.ts";
import { staticAnimData, staticDisplay } from "../../shared/protocol.ts";
import { renderFrame } from "../../shared/render.ts";
import type { Handback, RenderState, Rgb } from "../../shared/types.ts";
import type { DirectorTimings } from "./director.ts";
import type { DirectorClient, DirectorStream, Log, Timers } from "./ports.ts";
import { frameChanged, throttleWait, type FrameEntry } from "./policy.ts";

/** extControl frames: 100 ms transitions, one frame per 100 ms tick. */
export const STREAM_TRANSITION_DS = 1;
/** Static fallback writes: 1 s transitions, since they come at most every 1.5 s. */
export const STATIC_TRANSITION_DS = 10;

const DARK: Rgb = [0, 0, 0];

/** The Director while it drives the wall (mutable fields are this session's bookkeeping). */
export interface Session {
  readonly controllerId: string;
  readonly client: DirectorClient;
  /** `stream`: extControl v2 over UDP; `static`: display writes (the controller refused extControl). */
  readonly mode: "stream" | "static";
  readonly stream: DirectorStream | null;
  /** Aborted when the session ends: in-flight writes are dropped. */
  readonly abort: AbortController;
  readonly handback: Handback | null;
  /** When the takeover finished: reports that would make it yield are re-checked until `ownWriteMs` after this. */
  readonly takenAt: number;
  lastFrame: readonly FrameEntry[] | null;
  lastSentAt: number;
  staticBusy: boolean;
  /** The brightness the wall has (written at takeover, then by `syncBrightness` once a write succeeds). */
  applied: number | null;
  brightnessAt: number;
  brightnessBusy: boolean;
  brightnessTimer: unknown;
  /** Brightness writes that failed in a row, and when the next attempt may go (backoff from `retryMs`). */
  brightnessFailures: number;
  brightnessRetryAt: number;
  polling: boolean;
  polledAt: number;
  /** A read of what the controller shows (effect and power) is scheduled, or running. */
  verifyTimer: unknown;
  verifying: boolean;
  /** Something asked for a read while one was running: read again when it ends. */
  verifyAgain: boolean;
}

/** What the helpers need from the Director. */
export interface SessionHost {
  readonly timings: DirectorTimings;
  readonly timers: Timers;
  readonly log: Log;
  now(): number;
  targetBrightness(now: number): number;
  isCurrent(session: Session): boolean;
}

/** The device colours for `order` at time `now`: renderFrame through `deviceRgb` (drive floor, hue kept). */
export function frameAt(render: RenderState, order: readonly number[], now: number): FrameEntry[] {
  const lights = renderFrame(render, order, now);
  return order.map((id) => {
    const light = lights.get(id);
    return [id, light ? deviceRgb(light) : DARK];
  });
}

/**
 * Sends the frame for `now` if it is worth it. Streaming: when any channel changed, or `keepAliveMs` passed since the
 * last send. Static: when it changed and `staticIntervalMs` passed, one write at a time. Returns whether it sent.
 */
export function sendFrame(
  host: SessionHost,
  session: Session,
  render: RenderState,
  order: readonly number[],
  now: number,
): boolean {
  const frame = frameAt(render, order, now);
  const { keepAliveMs, staticIntervalMs } = host.timings;
  if (session.mode === "stream") {
    if (!frameChanged(session.lastFrame, frame) && now - session.lastSentAt < keepAliveMs) return false;
    // A frame the stream dropped (a host name not resolved yet) is tried again next tick, not after the keep-alive.
    if (!session.stream?.send(frame, STREAM_TRANSITION_DS)) return false;
    session.lastFrame = frame;
    session.lastSentAt = now;
    return true;
  }
  if (session.staticBusy || now - session.lastSentAt < staticIntervalMs) return false;
  if (!frameChanged(session.lastFrame, frame)) return false;
  // No echo window for these: their only echo is `*Static*`, which static mode counts as its own effect.
  session.staticBusy = true;
  session.lastFrame = frame;
  session.lastSentAt = now;
  session.client
    .write(staticDisplay(staticAnimData(frame, STATIC_TRANSITION_DS)), { signal: session.abort.signal })
    .catch((error: unknown) => {
      if (session.abort.signal.aborted) return;
      host.log.warn("Couldn't write a static frame", error);
      session.lastFrame = null;
    })
    .finally(() => {
      session.staticBusy = false;
    });
  return true;
}

/**
 * Brings the wall's brightness to the target (override or setting): at most one write per `brightnessThrottleMs`,
 * one at a time, and a value that arrives meanwhile lands afterwards (the trailing write). A failed write is tried
 * again after a backoff (`retryMs`), so the target always lands once the controller answers.
 */
export function syncBrightness(host: SessionHost, session: Session, now: number): void {
  if (!host.isCurrent(session) || session.brightnessBusy) return;
  const target = host.targetBrightness(now);
  if (session.applied === target) return;
  const throttle = throttleWait(now, session.brightnessAt, host.timings.brightnessThrottleMs);
  const wait = Math.max(throttle, session.brightnessRetryAt - now);
  if (wait > 0) {
    if (session.brightnessTimer === null) {
      session.brightnessTimer = host.timers.setTimeout(() => {
        session.brightnessTimer = null;
        syncBrightness(host, session, host.now());
      }, wait);
    }
    return;
  }
  session.brightnessBusy = true;
  session.brightnessAt = now;
  session.client
    .setState({ brightness: { value: target, duration: 0 } }, { signal: session.abort.signal })
    .then(() => {
      session.applied = target;
      session.brightnessFailures = 0;
      session.brightnessRetryAt = 0;
    })
    .catch((error: unknown) => {
      if (session.abort.signal.aborted) return;
      host.log.warn("Couldn't set the brightness", error);
      const delays = host.timings.retryMs;
      session.brightnessFailures++;
      const delay = delays[Math.min(session.brightnessFailures, delays.length) - 1] ?? 5000;
      session.brightnessRetryAt = host.now() + delay;
    })
    .finally(() => {
      session.brightnessBusy = false;
      syncBrightness(host, session, host.now());
    });
}
