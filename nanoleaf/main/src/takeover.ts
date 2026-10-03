/**
 * The device sequences behind taking the wall and giving it back. Takeover (DESIGN.md "Takeover"): record the
 * hand-back first, so a failure never leaves the wall streaming without a record of what to restore; then brightness
 * and power; then extControl, or static mode when the controller refuses it with a 4xx.
 */
import { readHandback } from "../../shared/storage.ts";
import { type Handback, type IdleBehaviour, STORAGE_KEYS } from "../../shared/types.ts";
import { captureHandback, handbackPlan, runHandback, STATIC_EFFECT, type HandbackClient } from "./handback.ts";
import { NanoleafError } from "./nanoleaf/http.ts";
import type { DirectorClient, Log, StoragePort, Timers } from "./ports.ts";

/** How the plugin drives the wall: extControl frames over UDP, or static display writes (the fallback). */
export type DriveMode = "stream" | "static";

/** One takeover of one controller. */
export interface TakeoverRequest {
  readonly client: DirectorClient;
  readonly controllerId: string;
  readonly storage: StoragePort;
  readonly log: Log;
  /** The brightness to drive at: the user's maximum, or a running override. */
  readonly brightness: number;
  /** ISO time, for the hand-back. */
  readonly takenAt: string;
  /** Aborts the takeover between (and during) requests. */
  readonly signal: AbortSignal;
  /** The hand-back is known and saved: called before anything on the wall changes. */
  readonly onHandback: (handback: Handback) => void;
  /** Called just before the first request that changes the wall. */
  readonly onTouch: () => void;
}

/** A 4xx answer: the controller understood and refused (for extControl: it doesn't support streaming). */
export function isRefusal(error: unknown): boolean {
  return error instanceof NanoleafError && error.status !== null && error.status >= 400 && error.status < 500;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

/** Writes (or clears, with null) the stored hand-back; failures are logged, never thrown. */
export async function saveHandback(storage: StoragePort, handback: Handback | null, log: Log): Promise<void> {
  try {
    await storage.set(STORAGE_KEYS.handback, handback);
  } catch (error) {
    log.warn("Couldn't save the hand-back", error);
  }
}

/**
 * Takes the wall: `info()` (plus `requestStatic()` for a `*Static*` scene) → hand-back saved → brightness and on →
 * extControl. Resolves with how to drive it; throws on any other failure (the caller undoes what `onTouch` began).
 */
export async function takeOver(request: TakeoverRequest): Promise<DriveMode> {
  const { client, signal, storage, log } = request;
  const options = { signal };
  const info = await client.info(options);
  const staticData = info.effects.select === STATIC_EFFECT ? await client.requestStatic(options) : null;
  throwIfAborted(signal);
  const stored = readHandback(storage.get(STORAGE_KEYS.handback));
  const handback = captureHandback(request.controllerId, info, staticData, stored, request.takenAt);
  request.onHandback(handback);
  if (handback !== stored) await saveHandback(storage, handback, log);
  throwIfAborted(signal);
  request.onTouch();
  await client.setState({ brightness: { value: request.brightness, duration: 0 }, on: { value: true } }, options);
  try {
    await client.enterExtControl(options);
    return "stream";
  } catch (error) {
    if (!isRefusal(error) || signal.aborted) throw error;
    log.warn("The controller refused extControl streaming; falling back to static writes", error);
    return "static";
  }
}

/** One hand-back: the plan for `handback` and `idle`, with an overall time limit (null: the requests' own). */
export interface HandbackRequest {
  readonly client: HandbackClient;
  readonly handback: Handback | null;
  readonly idle: IdleBehaviour;
  readonly storage: StoragePort;
  readonly log: Log;
  readonly timers: Timers;
  readonly timeoutMs: number | null;
}

/** Hands the wall back, then forgets the stored hand-back. Throws when the controller can't be reached in time. */
export async function handBack(request: HandbackRequest): Promise<void> {
  const { timers, timeoutMs, log } = request;
  const abort = new AbortController();
  const timer =
    timeoutMs === null
      ? null
      : timers.setTimeout(() => {
          abort.abort(new NanoleafError("timeout", `The hand-back took longer than ${timeoutMs} ms`));
        }, timeoutMs);
  try {
    const plan = handbackPlan(request.handback, request.idle);
    const refused = await runHandback(request.client, plan, { signal: abort.signal });
    for (const error of refused) log.warn("The controller refused part of the hand-back", error);
    await saveHandback(request.storage, null, log);
  } finally {
    if (timer !== null) timers.clearTimeout(timer);
  }
}
