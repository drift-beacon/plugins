/**
 * The Director turns what should show (scene.ts) into light on the wall: it wants the controller when there is
 * something to show, streams frames from render.ts at 10 Hz, lets go after a short grace, yields to anyone else who
 * changes the wall, and publishes `output`. Decisions are in policy.ts, the takeover and hand-back in wall.ts, and the
 * per-tick I/O in session.ts; this class holds the inputs. Clock, timers, client and stream are injected.
 */
import { parseColor, toLedRgb, WARM_WHITE } from "../../shared/color.ts";
import { effectDuration, type EffectSpec, sameSpec } from "../../shared/effects.ts";
import { placeLayout } from "../../shared/geometry.ts";
import { resolveOrder } from "../../shared/order.ts";
import { advance, alerting, fromDark, initialRenderState, withAlert, withPreview } from "../../shared/render.ts";
import { decideScene, OFF_SCENE } from "../../shared/scene.ts";
import { DEFAULT_SETTINGS, readLayout, readOrder, readSettings } from "../../shared/storage.ts";
import {
  type ControlEffect,
  type ControlInfo,
  type ControllerConfig,
  type OutputInfo,
  type Preview,
  type RenderState,
  type Rgb,
  type Scene,
  type Settings,
  STORAGE_KEYS,
} from "../../shared/types.ts";
import type { PreviewRequest } from "../../shared/ui-channel.ts";
import { type ClaimOwner, holder, markYielded, yieldedMark } from "./claims.ts";
import {
  deriveOutput,
  echoWait,
  sameOutput,
  wantsControl,
  yieldReason,
  type ControlInput,
  type OutputCore,
} from "./policy.ts";
import {
  type DeviceEvent,
  type DirectorClient,
  type DirectorStream,
  GLOBAL_TIMERS,
  type Link,
  type Log,
  NO_LINK,
  type StoragePort,
  type Timers,
  type WorkspaceData,
} from "./ports.ts";
import { sendFrame, syncBrightness, type Session } from "./session.ts";
import { Wall, type WallHost } from "./wall.ts";

export { STATIC_NOTE } from "./wall.ts";

/** How the Director paces itself. Production uses `DEFAULT_TIMINGS`; tests shorten them. */
export interface DirectorTimings {
  /** Frame tick (10 Hz). */
  readonly tickMs: number;
  /** Scene recompute without any change notice. */
  readonly recomputeMs: number;
  /** Resend an unchanged frame this often while streaming. */
  readonly keepAliveMs: number;
  /** Keep control this long after it is no longer wanted (session end, then a pin). */
  readonly graceMs: number;
  /**
   * After a takeover, an effect or power report that would make it yield may be an echo (of the takeover, or of a
   * hand-back just before it) this long: it is checked again with a read once this has passed.
   */
  readonly ownWriteMs: number;
  /** Static fallback: at most one display write this often. */
  readonly staticIntervalMs: number;
  /** Without the event stream, check `effects/select` this often while in control. */
  readonly pollMs: number;
  /** A preview lease without `ttlMs`. */
  readonly previewTtlMs: number;
  /** A schedule alert that fires while the wall isn't the plugin's waits this long for it, then is dropped. */
  readonly alertWaitMs: number;
  /** A controller's lease without `ttlMs`. */
  readonly controlTtlMs: number;
  /** A `takeControl` answer is kept this long, to answer a repeat of its `requestId` without running it again. */
  readonly requestMemoryMs: number;
  /** A `brightness` request overrides the setting this long. */
  readonly overrideMs: number;
  /** At most one brightness write this often (the last value always lands). */
  readonly brightnessThrottleMs: number;
  /** The hand-back when the instance stops (its budget is 5 s). */
  readonly stopTimeoutMs: number;
  /** Waits before retrying a failed takeover or brightness write; the last repeats. */
  readonly retryMs: readonly number[];
}

/** The pacing DESIGN.md specifies. */
export const DEFAULT_TIMINGS: DirectorTimings = Object.freeze({
  tickMs: 100,
  recomputeMs: 1000,
  keepAliveMs: 1000,
  graceMs: 1500,
  ownWriteMs: 2000,
  staticIntervalMs: 1500,
  pollMs: 15_000,
  previewTtlMs: 4000,
  alertWaitMs: 5000,
  controlTtlMs: 30_000,
  requestMemoryMs: 60_000,
  overrideMs: 3000,
  brightnessThrottleMs: 150,
  stopTimeoutMs: 3000,
  retryMs: Object.freeze([2000, 5000, 10_000, 30_000]),
});

/** Everything a Director needs. */
export interface DirectorOptions {
  readonly userId: string;
  /** This instance, for the controller claim. */
  readonly owner: ClaimOwner;
  readonly data: () => WorkspaceData;
  readonly storage: StoragePort;
  readonly createClient: (config: ControllerConfig) => DirectorClient;
  readonly createStream: (host: string) => DirectorStream;
  readonly publish: (output: OutputInfo) => void;
  /** Publishes the `control` state: the held lock, or null. */
  readonly publishControl?: (control: ControlInfo | null) => void;
  readonly log: Log;
  readonly now?: () => number;
  readonly timers?: Timers;
  readonly timings?: Partial<DirectorTimings>;
  /** Told when a device request fails while driving, so the connection can check the controller again. */
  readonly onDeviceError?: (error: unknown) => void;
}

/** Why `takeControl` was refused: someone else holds the lock, driving is switched off, or the setting forbids it. */
export type ControlRefusal = "held" | "paused" | "not-allowed";

/** What `takeControl` answers (manifest.json). `granted` is about the lock; `shown` about the wall. */
export interface ControlAnswer {
  readonly granted: boolean;
  readonly reason: ControlRefusal | null;
  /** The plugin drives the wall with streamed frames, or is taking it: the effect is (or is about to be) visible. */
  readonly shown: boolean;
  readonly holder: string | null;
  readonly leaseId: string | null;
  readonly effectId: string | null;
  readonly expiresAt: string | null;
}

/** A controller's lock on the wall: who, the effect it shows, and when it lapses unless renewed. */
interface ControlLock {
  readonly holder: string;
  readonly leaseId: string;
  readonly effect: ControlEffect;
  readonly since: number;
  readonly until: number;
}

/** A `takeControl` answer kept under its `requestId`, to give again when the request is repeated. */
interface RememberedAnswer {
  readonly id: string;
  readonly at: number;
  readonly answer: ControlAnswer;
}

/** How many `requestId`s are remembered per holder. */
const REQUEST_MEMORY = 8;

/** Drives one controller for one instance. Create it with `createDirector`, then `start()`; `stop()` hands back. */
export class Director {
  readonly timings: DirectorTimings;
  readonly #o: DirectorOptions;
  readonly #now: () => number;
  readonly #born: number;
  readonly #timers: Timers;
  readonly #host: WallHost;
  readonly #wall: Wall;

  #link: Link = NO_LINK;
  #settings: Settings = DEFAULT_SETTINGS;
  #enabled: boolean | null = null;
  #scene: Scene = OFF_SCENE;
  #render: RenderState | null = null;
  #order: readonly number[] = [];
  #orderKey = "";
  #lastRecompute = -Infinity;
  #yieldedKey: string | null = null;
  #yieldNote: string | null = null;
  /** The controller's yield mark (claims.ts) its own yield belongs to: it ends when an instance takes the wall. */
  #yieldMark: number | null = null;
  /** The last yield mark it has seen, so it adopts each one once. */
  #seenMark: number | null = null;
  /** The running preview: what it shows, when it lapses, and the interface copy holding it (null: nobody's). */
  #lease: { readonly preview: Preview; readonly until: number; readonly owner: string | null } | null = null;
  /** The lock a controller holds (`takeControl`): its effect shows in place of the user's own scene. */
  #control: ControlLock | null = null;
  /** Recent `takeControl` answers per holder, newest first, by `requestId`. */
  readonly #answers = new Map<string, readonly RememberedAnswer[]>();
  /** Makes lease and effect ids: unique within this instance's run, and across runs by its start time. */
  #ids = 0;
  #override: { readonly value: number; readonly until: number } | null = null;
  /** Schedule alerts waiting for the wall to be taken, oldest first: each is dropped once `until` passes. */
  #waiting: readonly { readonly rgb: Rgb; readonly until: number }[] = [];
  #unwantedSince: number | null = null;
  /** Set by `handBack()`: take nothing until the connection changes. */
  #hold = false;
  #output: OutputCore | null = null;
  #tick: unknown = null;
  #started = false;
  #stopped = false;

  constructor(options: DirectorOptions) {
    this.#o = options;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#now = options.now ?? Date.now;
    this.#born = this.#now();
    this.#timers = options.timers ?? GLOBAL_TIMERS;
    this.#host = {
      owner: options.owner,
      storage: options.storage,
      createClient: options.createClient,
      createStream: options.createStream,
      onDeviceError: options.onDeviceError,
      timings: this.timings,
      timers: this.#timers,
      log: options.log,
      now: () => this.#now(),
      targetBrightness: (now) => this.#targetBrightness(now),
      isCurrent: (session) => this.#wall.session === session,
      link: () => this.#link,
      idle: () => this.#settings.idle,
      tookOver: (session, now) => this.#tookOver(session, now),
      settled: () => this.#evaluate(this.#now()),
    };
    this.#wall = new Wall(this.#host);
  }

  /* ---- Read-outs ---- */

  get inControl(): boolean {
    return this.#wall.session !== null;
  }

  /** How it drives the wall now: `stream` (extControl), `static` (fallback), or null when it doesn't. */
  get controlMode(): "stream" | "static" | null {
    return this.#wall.session?.mode ?? null;
  }

  get scene(): Scene {
    return this.#scene;
  }

  get yieldedKey(): string | null {
    return this.#yieldedKey;
  }

  /** The last published output, without `since`. */
  get output(): OutputCore | null {
    return this.#output;
  }

  /** The resolved fill order (panel ids). */
  get order(): readonly number[] {
    return this.#order;
  }

  /* ---- Lifecycle ---- */

  /** Computes the first scene, publishes `output` and starts the tick. Doesn't touch the device. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    const now = this.#now();
    this.#recompute(now);
    this.#evaluate(now);
    this.#tick = this.#timers.setInterval(() => this.#onTick(), this.timings.tickMs);
  }

  /** Stops for good: the tick ends and the wall is handed back (wall.ts `stop`). Never throws. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#tick !== null) this.#timers.clearInterval(this.#tick);
    this.#tick = null;
    await this.#wall.stop();
  }

  /* ---- Inputs ---- */

  /** The connection changed (status, controller, address or token, or the event stream). */
  setLink(link: Link): void {
    const previous = this.#link;
    this.#link = link;
    const moved =
      previous.controllerId !== link.controllerId ||
      previous.status !== link.status ||
      previous.config?.host !== link.config?.host ||
      previous.config?.port !== link.config?.port ||
      previous.config?.token !== link.config?.token;
    if (moved) {
      this.#hold = false;
      this.#wall.linkMoved();
    }
    const session = this.#wall.session;
    if (session && link.controllerId !== session.controllerId) this.#wall.drop();
    // The controller doesn't replay events: after the stream (re)opens, read what the wall shows now.
    else if (session && link.events && !previous.events) this.#verify(session, 0);
    this.update();
  }

  /** Workspace data, settings, order or layout changed: recompute now rather than at the next second. */
  update(): void {
    if (this.#stopped) return;
    const now = this.#now();
    this.#recompute(now);
    this.#evaluate(now);
    const session = this.#wall.session;
    if (session) syncBrightness(this.#host, session, now);
  }

  /** An effect or power change from the controller (event, poll or read): yields when someone else changed the wall. */
  onDeviceEvent(event: DeviceEvent): void {
    const session = this.#wall.session;
    if (!session || this.#stopped) return;
    this.#judge(session, event);
  }

  /**
   * The `preview` request: anything but `none` shows over the scene until `ttlMs` passes (repeat it to renew), held
   * by `owner`, the interface copy that asked; the latest request takes the wall, whoever held it. `none` ends the
   * lease only for its holder: one copy closing its editor doesn't end a preview another copy is showing. The colour
   * is the named activity's, else the scene's. `shown`: it is (or is becoming) in control.
   */
  preview(request: PreviewRequest, owner: string | null = null): { shown: boolean } {
    if (this.#stopped) return { shown: false };
    const now = this.#now();
    if (request.mode === "none") {
      const held = this.#lease?.owner ?? null;
      if (held === null || owner === null || held === owner) this.#endLease(now);
      return { shown: false };
    }
    const rgb = this.#colourOf(request.activityId ?? null);
    const preview: Preview =
      request.mode === "identify"
        ? { mode: "identify", panelIds: (request.panelIds ?? []).filter((id) => Number.isInteger(id)), rgb }
        : request.mode === "fill"
          ? { mode: "fill", fraction: Math.min(1, Math.max(0, request.fraction ?? 0)), rgb }
          : { mode: "order", rgb };
    this.#lease = { preview, until: now + (request.ttlMs ?? this.timings.previewTtlMs), owner };
    this.#render = withPreview(this.#render ?? initialRenderState(this.#scene, now), preview, now);
    this.#evaluate(now);
    return { shown: this.#wants() };
  }

  /**
   * The interface copies open now (`ctx.ui.clients`): a preview whose holder isn't among them ends at once, without
   * waiting for its lease to lapse. The lease stays the backstop, since a closed copy is only reported after a few
   * seconds.
   */
  endPreviewsExcept(open: ReadonlySet<string>): void {
    const owner = this.#lease?.owner ?? null;
    if (this.#stopped || owner === null || open.has(owner)) return;
    this.#endLease(this.#now());
  }

  /**
   * A schedule just fired for this activity: the wall swells twice in its colour (warm white when it has none), over
   * whatever shows, a preview included. When the plugin isn't driving the wall it takes it for the alert, which starts
   * once the wall is its own; an alert that can't start within `alertWaitMs` is dropped, never played late (the wall
   * is yielded, someone else's, disconnected, or driven by static writes, which can't swell). Nothing happens with
   * the `scheduleAlert` setting or driving switched off. `shown`: it plays, or the wall is being taken for it.
   */
  alert(activityId: string | null): { shown: boolean } {
    if (this.#stopped || !this.#started) return { shown: false };
    const now = this.#now();
    this.#recompute(now);
    if (!this.#settings.enabled || !this.#settings.scheduleAlert) return { shown: false };
    const rgb = this.#colourOf(activityId) ?? WARM_WHITE;
    const session = this.#wall.session;
    if (session) {
      if (session.mode !== "stream") return { shown: false };
      this.#render = withAlert(this.#render ?? initialRenderState(this.#scene, now), rgb, now);
      this.#evaluate(now);
      return { shown: true };
    }
    this.#waiting = [...this.#waiting, { rgb, until: now + this.timings.alertWaitMs }];
    this.#evaluate(now);
    return { shown: this.#wants() };
  }

  /**
   * The `takeControl` command: `holder` takes the lock, or changes or renews what it shows under the lock it has.
   * Refused while another holder has it, and when driving or control by others is switched off. A `requestId` seen
   * before answers as it did then and changes nothing, so a caller can repeat a request whose answer it lost. An
   * effect equal to the running one only renews the lease: its clock goes on. A `reveal` ends its own lease when it
   * has played, whatever `ttlMs` says and whether or not the wall showed it.
   */
  takeControl(holder: string, spec: EffectSpec, ttlMs?: number, requestId?: string): ControlAnswer {
    if (this.#stopped) return refusal("paused", null);
    const now = this.#now();
    this.#recompute(now);
    if (requestId !== undefined) {
      const known = this.#answers.get(holder)?.find((entry) => entry.id === requestId);
      if (known && now - known.at < this.timings.requestMemoryMs) return known.answer;
    }
    const answer = this.#grant(holder, spec, ttlMs, now);
    if (requestId !== undefined) {
      const kept = (this.#answers.get(holder) ?? []).filter((entry) => now - entry.at < this.timings.requestMemoryMs);
      this.#answers.set(holder, [{ id: requestId, at: now, answer }, ...kept].slice(0, REQUEST_MEMORY));
    }
    return answer;
  }

  #grant(holder: string, spec: EffectSpec, ttlMs: number | undefined, now: number): ControlAnswer {
    if (!this.#settings.enabled) return refusal("paused", null);
    if (!this.#settings.allowControl) return refusal("not-allowed", null);
    const held = this.#control;
    if (held && held.holder !== holder) return refusal("held", held.holder);
    const renewed = held !== null && sameSpec(held.effect, spec);
    const effect: ControlEffect = renewed ? held.effect : { ...spec, id: this.#newId("e"), startedAt: now };
    const duration = effectDuration(effect.type);
    const until = duration !== null ? effect.startedAt + duration : now + (ttlMs ?? this.timings.controlTtlMs);
    const lock: ControlLock = {
      holder,
      leaseId: held?.leaseId ?? this.#newId("l"),
      effect,
      since: held?.since ?? now,
      until,
    };
    this.#setControl(lock, now);
    const session = this.#wall.session;
    return {
      granted: true,
      reason: null,
      shown: this.#wants() && session?.mode !== "static",
      holder,
      leaseId: lock.leaseId,
      effectId: effect.id,
      expiresAt: new Date(until).toISOString(),
    };
  }

  /**
   * The `releaseControl` command: `holder` lets go of the lock. Nothing happens for anyone else, or when `leaseId`
   * names a hold that is over (a late release must not end the next one).
   */
  releaseControl(holder: string, leaseId?: string): { released: boolean } {
    const held = this.#control;
    if (this.#stopped || !held || held.holder !== holder) return { released: false };
    if (leaseId !== undefined && leaseId !== held.leaseId) return { released: false };
    this.#setControl(null, this.#now());
    return { released: true };
  }

  /** The lock as it stands, for the published `control` state. */
  get control(): ControlInfo | null {
    const held = this.#control;
    if (!held) return null;
    return {
      holder: held.holder,
      leaseId: held.leaseId,
      effect: held.effect,
      since: new Date(held.since).toISOString(),
      expiresAt: new Date(held.until).toISOString(),
    };
  }

  #newId(prefix: string): string {
    this.#ids += 1;
    return `${prefix}${this.#born.toString(36)}-${this.#ids.toString(36)}`;
  }

  /** Sets or clears the lock, publishes it and shows the result at once. */
  #setControl(lock: ControlLock | null, now: number): void {
    this.#control = lock;
    try {
      this.#o.publishControl?.(this.control);
    } catch (error) {
      this.#o.log.error("Couldn't publish the control state", error);
    }
    this.#recompute(now);
    this.#evaluate(now);
  }

  /** Whether the lock should go by itself: its lease lapsed, or the user switched driving or control by others off. */
  #controlOver(now: number): boolean {
    const held = this.#control;
    if (!held) return false;
    return now >= held.until || !this.#settings.enabled || !this.#settings.allowControl;
  }

  /** The `brightness` request: overrides the maximum for `overrideMs`, applied at once when in control. */
  brightness(value: number): { applied: boolean } {
    if (this.#stopped) return { applied: false };
    const now = this.#now();
    this.#override = { value: Math.min(100, Math.max(1, Math.round(value))), until: now + this.timings.overrideMs };
    const session = this.#wall.session;
    if (session) syncBrightness(this.#host, session, now);
    return { applied: session !== null };
  }

  /** The `resume` command: stop yielding and try again straight away. */
  resume(): void {
    if (this.#stopped) return;
    this.#clearYield();
    this.#wall.resetRetry();
    this.update();
  }

  /**
   * Hands the wall back now (forget, or pairing another controller) and takes nothing more until the connection
   * changes. Resolves when done; errors are logged.
   */
  async handBack(): Promise<void> {
    this.#hold = true;
    await this.#wall.settle();
    if (this.#wall.session && !this.#stopped) {
      this.#wall.release();
      await this.#wall.settle();
    }
  }

  /* ---- Scene ---- */

  #endLease(now: number): void {
    if (!this.#lease) return;
    this.#lease = null;
    if (this.#render) this.#render = withPreview(this.#render, null, now);
    this.#evaluate(now);
  }

  /** The brightness to drive at: a running `brightness` override, else the setting. */
  #targetBrightness(now: number): number {
    const override = this.#override;
    return override && now < override.until ? override.value : this.#settings.maxBrightness;
  }

  #recompute(now: number): void {
    const settings = readSettings(this.#o.storage.get(STORAGE_KEYS.settings));
    if (this.#enabled !== null && settings.enabled !== this.#enabled) this.#clearYield();
    this.#enabled = settings.enabled;
    this.#settings = settings;
    this.#refreshOrder(settings);
    if (this.#controlOver(now)) {
      this.#control = null;
      try {
        this.#o.publishControl?.(null);
      } catch (error) {
        this.#o.log.error("Couldn't publish the control state", error);
      }
    }
    const { activities, sessions } = this.#o.data();
    const scene = decideScene({ userId: this.#o.userId, activities, sessions, settings, now, control: this.#control });
    if (this.#yieldedKey !== null && scene.key !== this.#yieldedKey) this.#clearYield();
    this.#scene = scene;
    this.#render = this.#render ? advance(this.#render, scene, now) : initialRenderState(scene, now);
    this.#lastRecompute = now;
  }

  #clearYield(): void {
    this.#yieldedKey = null;
    this.#yieldNote = null;
    this.#yieldMark = null;
  }

  /**
   * Follows the controller's shared yield (claims.ts), since another instance may have yielded it: a new mark makes
   * this scene yielded here too, and the yield ends once any instance takes the wall again (the mark is gone).
   */
  #syncYield(): void {
    const controllerId = this.#link.controllerId;
    if (controllerId === null) return;
    const mark = yieldedMark(controllerId);
    if (this.#yieldMark !== null && this.#yieldMark !== (mark?.id ?? null)) this.#clearYield();
    if (!mark || mark.id === this.#seenMark || this.#wall.session) return;
    this.#seenMark = mark.id;
    this.#yieldMark = mark.id;
    this.#yieldedKey = this.#scene.key;
    this.#yieldNote = mark.reason;
  }

  /** Re-resolves the fill order when the layout, order, view rotation or controller changed. */
  #refreshOrder(settings: Settings): void {
    const layoutRaw = this.#o.storage.get(STORAGE_KEYS.layout);
    const orderRaw = this.#o.storage.get(STORAGE_KEYS.order);
    const controllerId = this.#link.controllerId;
    const key = JSON.stringify([controllerId, settings.viewRotation, layoutRaw ?? null, orderRaw ?? null]);
    if (key === this.#orderKey) return;
    this.#orderKey = key;
    const layout = readLayout(layoutRaw);
    this.#order =
      layout && controllerId !== null && layout.controllerId === controllerId
        ? resolveOrder(readOrder(orderRaw), placeLayout(layout, settings.viewRotation).panels)
        : [];
  }

  #colourOf(activityId: string | null): Rgb | null {
    if (activityId === null) return null;
    const activity = this.#o.data().activities.find((a) => a.id === activityId);
    const rgb = activity ? parseColor(activity.color) : null;
    return rgb ? toLedRgb(rgb) : null;
  }

  /* ---- Decisions ---- */

  #input(): ControlInput {
    const link = this.#link;
    const controllerId = link.controllerId;
    const claim = controllerId !== null ? holder(controllerId) : null;
    return {
      linked: link.status === "connected" && link.config !== null && controllerId !== null,
      panels: this.#order.length,
      enabled: this.#settings.enabled,
      scene: this.#scene,
      previewActive: this.#lease !== null,
      alertActive: this.#waiting.length > 0 || (this.#render !== null && alerting(this.#render, this.#now())),
      yieldedKey: this.#yieldedKey,
      claimedElsewhere: claim !== null && claim.token !== this.#o.owner.token,
      inControl: this.#wall.session !== null,
      note: this.#wall.note,
      yieldNote: this.#yieldNote,
    };
  }

  #wants(): boolean {
    return !this.#hold && !this.#stopped && wantsControl(this.#input());
  }

  /** Expires leases, then starts whatever the moment calls for (takeover, release, leftover hand-back). */
  #evaluate(now: number): void {
    if (!this.#started || this.#stopped) return;
    if (this.#lease && now >= this.#lease.until) {
      this.#lease = null;
      if (this.#render) this.#render = withPreview(this.#render, null, now);
    }
    if (this.#override && now >= this.#override.until) this.#override = null;
    if (this.#waiting.some((alert) => now >= alert.until)) {
      this.#waiting = this.#waiting.filter((alert) => now < alert.until);
    }
    this.#syncYield();

    const wall = this.#wall;
    const wants = this.#wants();
    if (wants || !wall.engaged) this.#unwantedSince = null;
    else this.#unwantedSince ??= now;
    if (!wants && !wall.engaged) wall.clearNote();

    if (!wall.busy) {
      if (wall.session) {
        if (this.#unwantedSince !== null && now - this.#unwantedSince >= this.timings.graceMs) wall.release();
      } else if (wants) {
        if (now >= wall.retryAt) wall.takeOver();
      } else if (!this.#hold) wall.checkOrphan();
    }
    this.#publish(now);
  }

  #publish(now: number): void {
    const core = deriveOutput(this.#input());
    if (sameOutput(this.#output, core)) return;
    this.#output = core;
    try {
      this.#o.publish({ ...core, since: new Date(now).toISOString() });
    } catch (error) {
      this.#o.log.error("Couldn't publish the output state", error);
    }
  }

  /* ---- Frames ---- */

  #onTick(): void {
    try {
      const now = this.#now();
      // A lapsed lease ends on its tick, not at the next second: a reveal's lease is its own length.
      if (now - this.#lastRecompute >= this.timings.recomputeMs || this.#controlOver(now)) this.#recompute(now);
      this.#evaluate(now);
      const session = this.#wall.session;
      if (!session) return;
      this.#frame(now, session);
      syncBrightness(this.#host, session, now);
      this.#poll(now, session);
    } catch (error) {
      this.#o.log.error("The Director's tick failed", error);
    }
  }

  /**
   * The wall is ours: fade in from dark (with any preview), start the schedule alerts that waited for it (static
   * writes can't swell, so they are dropped there) and send the first frame at once. From the tracked render
   * state, not a fresh one: a goal met by the change that caused the takeover still shimmers, and a restart in the
   * middle of a session whose goal was met long ago doesn't replay the shimmer.
   */
  #tookOver(session: Session, now: number): void {
    let render = fromDark(this.#render ?? initialRenderState(this.#scene, now), now);
    if (session.mode === "stream") {
      for (const alert of this.#waiting) if (now < alert.until) render = withAlert(render, alert.rgb, now);
    }
    this.#waiting = [];
    this.#render = render;
    this.#frame(now, session);
  }

  #frame(now: number, session: Session): void {
    if (this.#render && this.#order.length > 0) sendFrame(this.#host, session, this.#render, this.#order, now);
  }

  /* ---- Yield ---- */

  /** Yields on a report of someone else's change; one that may still be the takeover's echo is re-read after it. */
  #judge(session: Session, event: DeviceEvent): void {
    const reason = yieldReason({ staticMode: session.mode === "static", effect: event.effect, on: event.on });
    if (!reason) return;
    const now = this.#now();
    const wait = echoWait(now, session.takenAt, this.timings.ownWriteMs);
    if (wait > 0) this.#verify(session, wait);
    else this.#yield(session, reason, now);
  }

  /** Stops driving, frees the claim and marks the controller yielded, for this instance and every other one. */
  #yield(session: Session, reason: string, now: number): void {
    this.#wall.yield(reason);
    const mark = markYielded(session.controllerId, reason);
    this.#yieldedKey = this.#scene.key;
    this.#yieldNote = reason;
    this.#yieldMark = mark.id;
    this.#seenMark = mark.id;
    this.#unwantedSince = null;
    this.#evaluate(now);
  }

  /**
   * After `delayMs`, reads what the controller shows (effect and power, one `info()`) and judges it like an event.
   * One read at a time; asking during one reads again after it, so nothing reported meanwhile is missed.
   */
  #verify(session: Session, delayMs: number): void {
    if (session.verifying) {
      session.verifyAgain = true;
      return;
    }
    if (session.verifyTimer !== null) return;
    session.verifyTimer = this.#timers.setTimeout(() => {
      session.verifyTimer = null;
      if (this.#wall.session !== session || this.#stopped) return;
      session.verifying = true;
      session.client
        .info({ signal: session.abort.signal })
        .then((info) => {
          if (this.#wall.session === session) this.#judge(session, { effect: info.effects.select, on: info.state.on });
        })
        .catch((error: unknown) => {
          if (session.abort.signal.aborted) return;
          this.#o.log.warn("Couldn't check what the controller shows", error);
          this.#o.onDeviceError?.(error);
        })
        .finally(() => {
          session.verifying = false;
          if (!session.verifyAgain || this.#wall.session !== session) return;
          session.verifyAgain = false;
          this.#verify(session, echoWait(this.#now(), session.takenAt, this.timings.ownWriteMs));
        });
    }, delayMs);
  }

  /** Without the event stream, asks the controller what it shows every `pollMs`. */
  #poll(now: number, session: Session): void {
    if (this.#link.events || session.polling || now - session.polledAt < this.timings.pollMs) return;
    session.polling = true;
    session.polledAt = now;
    session.client
      .select({ signal: session.abort.signal })
      .then((effect) => {
        if (this.#wall.session === session) this.onDeviceEvent({ effect });
      })
      .catch((error: unknown) => {
        if (session.abort.signal.aborted) return;
        this.#o.log.warn("Couldn't check the controller's effect", error);
        this.#o.onDeviceError?.(error);
      })
      .finally(() => {
        session.polling = false;
      });
  }
}

function refusal(reason: ControlRefusal, holder: string | null): ControlAnswer {
  return { granted: false, reason, shown: false, holder, leaseId: null, effectId: null, expiresAt: null };
}

/** A Director with production defaults for anything not given. */
export function createDirector(options: DirectorOptions): Director {
  return new Director(options);
}
