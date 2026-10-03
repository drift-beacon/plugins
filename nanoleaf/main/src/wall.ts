/**
 * The device side of the Director: taking the controller over, handing it back, yielding it, and giving back a wall
 * that an earlier run left streaming. One operation runs at a time, and each ends by asking the Director to look
 * again. The Director (director.ts) decides when; the Wall does it and keeps the session while it drives.
 */
import { readHandback } from "../../shared/storage.ts";
import { type ControllerConfig, type Handback, type IdleBehaviour, STORAGE_KEYS } from "../../shared/types.ts";
import { acquire, type ClaimOwner, clearYielded, release as releaseClaim } from "./claims.ts";
import { type HandbackClient, stillOurs } from "./handback.ts";
import type { DirectorClient, DirectorStream, Link, StoragePort } from "./ports.ts";
import type { Session, SessionHost } from "./session.ts";
import { handBack, saveHandback, takeOver } from "./takeover.ts";

/** What the Wall needs from the Director. */
export interface WallHost extends SessionHost {
  readonly owner: ClaimOwner;
  readonly storage: StoragePort;
  readonly createClient: (config: ControllerConfig) => DirectorClient;
  readonly createStream: (host: string) => DirectorStream;
  readonly onDeviceError?: (error: unknown) => void;
  /** The connection now. */
  link(): Link;
  /** `settings.idle` now. */
  idle(): IdleBehaviour;
  /** A takeover finished: the Director shows its first frame. */
  tookOver(session: Session, now: number): void;
  /** An operation ended: the Director evaluates again. */
  settled(): void;
}

/** A takeover under way: what it has done so far, so a stop can undo it. */
interface Pending {
  readonly controllerId: string;
  readonly client: DirectorClient;
  readonly abort: AbortController;
  handback: Handback | null;
  /** It has started changing the wall (brightness, power or effect). */
  touched: boolean;
}

/** Shown while driving with static writes. */
export const STATIC_NOTE = "The controller refused streaming, so the wall updates less smoothly";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One instance's hold on one wall at a time. */
export class Wall {
  readonly #host: WallHost;
  #client: { readonly key: string; readonly client: DirectorClient } | null = null;
  #session: Session | null = null;
  #pending: Pending | null = null;
  #op: Promise<void> | null = null;
  #note: string | null = null;
  #retryAt = 0;
  #failures = 0;
  /** The controller whose leftover hand-back (from before a restart) has been dealt with. */
  #orphanChecked: string | null = null;
  /** No new attempt at a leftover hand-back before this, after one failed; the backoff follows `retryMs`. */
  #orphanRetryAt = 0;
  #orphanFailures = 0;
  /**
   * A hand-back to this controller failed partway since the link last moved, so the wall may already show the scene it
   * was putting back (while brightness or power are still the plugin's): that counts as the plugin's output too.
   */
  #partial: string | null = null;

  constructor(host: WallHost) {
    this.#host = host;
  }

  /** The session while it drives the wall. */
  get session(): Session | null {
    return this.#session;
  }

  /** It drives the wall, or is taking it over. */
  get engaged(): boolean {
    return this.#session !== null || this.#pending !== null;
  }

  /** A takeover or hand-back is running. */
  get busy(): boolean {
    return this.#op !== null;
  }

  /** What to say about driving (static fallback, a failed takeover), for `output.detail`. */
  get note(): string | null {
    return this.#note;
  }

  /** No takeover before this, after a failed one. */
  get retryAt(): number {
    return this.#retryAt;
  }

  clearNote(): void {
    this.#note = null;
  }

  /** Forgets earlier failures, so the next takeover may start at once (`resume`). */
  resetRetry(): void {
    this.#retryAt = 0;
    this.#failures = 0;
    this.#note = null;
  }

  /** The connection moved (status, controller or address): look for a leftover hand-back again, at once. */
  linkMoved(): void {
    this.#orphanChecked = null;
    this.#orphanRetryAt = 0;
    this.#orphanFailures = 0;
    this.#partial = null;
  }

  /** Resolves once no operation runs. */
  async settle(): Promise<void> {
    while (this.#op) await this.#op;
  }

  takeOver(): void {
    this.#run(() => this.#takeover());
  }

  release(): void {
    this.#run(() => this.#release());
  }

  /** Someone else changed the wall: stop at once and restore nothing (the stored hand-back is stale now). */
  yield(reason: string): void {
    const session = this.#session;
    if (!session) return;
    this.#endSession(session);
    releaseClaim(session.controllerId, this.#host.owner);
    this.#note = null;
    void saveHandback(this.#host.storage, null, this.#host.log);
    this.#host.log.info(`Yielded ${session.controllerId}: ${reason}`);
  }

  /** Lets go without a hand-back: the link now points at another controller (pair() hands back first). */
  drop(): void {
    const session = this.#session;
    if (!session) return;
    this.#endSession(session);
    releaseClaim(session.controllerId, this.#host.owner);
  }

  /**
   * Stops for good: a takeover under way is abandoned, and if it drove the wall (or had begun to change it) it hands
   * it back as `settings.idle` says, within `stopTimeoutMs` in all. Never throws.
   */
  async stop(): Promise<void> {
    const host = this.#host;
    const started = host.now();
    const budget = host.timings.stopTimeoutMs;
    const pending = this.#pending;
    pending?.abort.abort();
    if (this.#op) await this.#within(this.#op, budget);
    const remaining = Math.max(0, budget - (host.now() - started));
    const session = this.#session;
    const driving = session ?? (pending?.touched ? pending : null);
    if (session) this.#endSession(session);
    try {
      if (driving && this.#reachable(driving.controllerId)) {
        await this.#handBack(driving.client, driving.handback, host.idle(), remaining);
        host.log.info(`Handed ${driving.controllerId} back on stop (${host.idle()})`);
      }
    } catch (error) {
      host.log.warn("Couldn't hand the wall back while stopping", error);
    } finally {
      const controllerId = session?.controllerId ?? pending?.controllerId;
      if (controllerId !== undefined) releaseClaim(controllerId, host.owner);
    }
  }

  /**
   * A hand-back left in storage by a run that didn't give the wall back (a crash, the controller dropping off
   * mid-stream, or a hand-back that failed): once connected and not wanting the wall, restore it if the wall still
   * shows the plugin's output (`stillOurs`: streaming, or the static fallback's frozen frame; or the scene a failed
   * hand-back had already put back), else drop it. A failed attempt is tried again after a backoff.
   */
  checkOrphan(): void {
    const host = this.#host;
    const { config, controllerId, status } = host.link();
    if (status !== "connected" || !config || controllerId === null || this.#orphanChecked === controllerId) return;
    if (host.now() < this.#orphanRetryAt) return;
    const stored = readHandback(host.storage.get(STORAGE_KEYS.handback));
    if (!stored || stored.controllerId !== controllerId) {
      this.#orphanChecked = controllerId;
      return;
    }
    if (!acquire(controllerId, host.owner)) return; // Someone else drives it now: look again later.
    this.#orphanChecked = controllerId;
    const client = this.#clientFor(config);
    this.#run(async () => {
      try {
        const effect = await client.select();
        const partial = this.#partial === controllerId && effect === stored.effect;
        if (stillOurs(stored, controllerId, effect) || partial) {
          await this.#handBack(client, stored, host.idle(), null);
          host.log.info(`Handed ${controllerId} back${partial ? "" : " after a restart"}`);
        } else await saveHandback(host.storage, null, host.log);
        this.#orphanFailures = 0;
        this.#partial = null;
      } catch (error) {
        host.log.warn("Couldn't hand back a wall left streaming", error);
        this.#handbackFailed(controllerId, error);
      } finally {
        if (this.#session?.controllerId !== controllerId) releaseClaim(controllerId, host.owner);
      }
    });
  }

  /* ---- Operations ---- */

  /** Runs one operation at a time; when it ends, the Director evaluates again. */
  #run(task: () => Promise<void>): void {
    const host = this.#host;
    const op = task().catch((error: unknown) => host.log.error("A takeover or hand-back failed", error));
    this.#op = op;
    void op.finally(() => {
      if (this.#op === op) this.#op = null;
      try {
        host.settled();
      } catch (error) {
        host.log.error("The Director's evaluation failed", error);
      }
    });
  }

  #clientFor(config: ControllerConfig): DirectorClient {
    const key = `${config.host}\n${config.port}\n${config.token}`;
    if (this.#client?.key !== key) this.#client = { key, client: this.#host.createClient(config) };
    return this.#client.client;
  }

  #reachable(controllerId: string): boolean {
    const link = this.#host.link();
    return link.status === "connected" && link.controllerId === controllerId && link.config !== null;
  }

  /** Claim, then takeover.ts's sequence, then the session (and the Director's first frame). */
  async #takeover(): Promise<void> {
    const host = this.#host;
    const { config, controllerId } = host.link();
    if (!config || controllerId === null || !acquire(controllerId, host.owner)) return;
    const client = this.#clientFor(config);
    const pending: Pending = { controllerId, client, abort: new AbortController(), handback: null, touched: false };
    this.#pending = pending;
    const brightness = host.targetBrightness(host.now());
    try {
      const mode = await takeOver({
        client,
        controllerId,
        storage: host.storage,
        log: host.log,
        brightness,
        takenAt: new Date(host.now()).toISOString(),
        signal: pending.abort.signal,
        onHandback: (handback) => (pending.handback = handback),
        onTouch: () => (pending.touched = true),
      });
      if (pending.abort.signal.aborted) throw pending.abort.signal.reason;
      const now = host.now();
      const session: Session = {
        controllerId,
        client,
        mode,
        stream: mode === "stream" ? host.createStream(config.host) : null,
        abort: pending.abort,
        handback: pending.handback,
        takenAt: now,
        lastFrame: null,
        lastSentAt: -Infinity,
        staticBusy: false,
        applied: brightness,
        brightnessAt: now,
        brightnessBusy: false,
        brightnessTimer: null,
        brightnessFailures: 0,
        brightnessRetryAt: 0,
        polling: false,
        polledAt: now,
        verifyTimer: null,
        verifying: false,
        verifyAgain: false,
      };
      this.#pending = null;
      this.#session = session;
      clearYielded(controllerId); // The plugin drives the wall again: a yield to the outside is over for everyone.
      this.#failures = 0;
      this.#retryAt = 0;
      this.#note = mode === "static" ? STATIC_NOTE : null;
      host.log.info(`Took over ${controllerId} (${mode === "stream" ? "streaming" : "static writes"})`);
      host.tookOver(session, now);
    } catch (error) {
      if (this.#pending === pending) this.#pending = null;
      if (pending.abort.signal.aborted) return; // stop() undoes what was done.
      await this.#takeoverFailed(pending, error);
    }
  }

  async #takeoverFailed(pending: Pending, error: unknown): Promise<void> {
    const host = this.#host;
    const delays = host.timings.retryMs;
    this.#failures++;
    this.#retryAt = host.now() + (delays[Math.min(this.#failures, delays.length) - 1] ?? 5000);
    this.#note = `Couldn't take over the wall: ${describe(error)}`;
    host.log.warn("Couldn't take over the wall", error);
    host.onDeviceError?.(error);
    try {
      // Put back whatever changed before it failed, as it was: never "off", since nothing was shown yet.
      if (pending.touched) await this.#handBack(pending.client, pending.handback, "restore", null);
    } catch (failure) {
      host.log.warn("Couldn't undo the failed takeover", failure);
    } finally {
      releaseClaim(pending.controllerId, host.owner);
    }
  }

  /** After the grace: stop streaming, hand back as `settings.idle` says (when reachable), free the claim. */
  async #release(): Promise<void> {
    const host = this.#host;
    const session = this.#session;
    if (!session) return;
    this.#endSession(session);
    this.#note = null;
    try {
      if (this.#reachable(session.controllerId)) {
        await this.#handBack(session.client, session.handback, host.idle(), null);
        host.log.info(`Handed ${session.controllerId} back (${host.idle()})`);
      } else {
        host.log.info(`Can't reach ${session.controllerId}: stopped driving it without handing it back`);
      }
    } catch (error) {
      host.log.warn("Couldn't hand the wall back", error);
      this.#handbackFailed(session.controllerId, error);
    } finally {
      releaseClaim(session.controllerId, host.owner);
    }
  }

  /**
   * A hand-back didn't get through, so the stored one stays: the leftover check tries it again after a backoff (sooner
   * if the link moves), and the connection is checked.
   */
  #handbackFailed(controllerId: string, error: unknown): void {
    const host = this.#host;
    const delays = host.timings.retryMs;
    this.#orphanFailures++;
    this.#orphanRetryAt = host.now() + (delays[Math.min(this.#orphanFailures, delays.length) - 1] ?? 5000);
    this.#orphanChecked = null;
    this.#partial = controllerId;
    host.onDeviceError?.(error);
  }

  #handBack(client: HandbackClient, handback: Handback | null, idle: IdleBehaviour, timeoutMs: number | null) {
    const { storage, log, timers } = this.#host;
    return handBack({ client, handback, idle, storage, log, timers, timeoutMs });
  }

  #endSession(session: Session): void {
    if (this.#session === session) this.#session = null;
    session.abort.abort();
    if (session.brightnessTimer !== null) this.#host.timers.clearTimeout(session.brightnessTimer);
    session.brightnessTimer = null;
    if (session.verifyTimer !== null) this.#host.timers.clearTimeout(session.verifyTimer);
    session.verifyTimer = null;
    session.stream?.close();
  }

  /** Waits for `promise`, but no longer than `ms`. */
  async #within(promise: Promise<unknown>, ms: number): Promise<void> {
    const timers = this.#host.timers;
    let timer: unknown = null;
    const settled = promise.then(
      () => undefined,
      () => undefined,
    );
    const timeout = new Promise<void>((resolve) => {
      timer = timers.setTimeout(resolve, ms);
    });
    await Promise.race([settled, timeout]);
    if (timer !== null) timers.clearTimeout(timer);
  }
}
