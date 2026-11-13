/**
 * The Director turns what should show (scene.ts) into light on the wall: it wants the controller when there is
 * something to show, streams frames from render.ts at 10 Hz, lets go after a short grace, yields to anyone else who
 * changes the wall, and publishes `output`. The wall is drawn zone by zone (zones.ts, zone-render.ts): each zone shows
 * its own member's scene with its own render state, merged into one frame; an unsplit wall is one zone. Decisions are
 * in policy.ts, the takeover and hand-back in wall.ts, and the per-tick I/O in session.ts; this class holds the
 * inputs. Clock, timers, client and stream are injected.
 */
import { speaksTo } from "../../shared/acting-for.ts";
import { parseColor, toLedRgb, WARM_WHITE } from "../../shared/color.ts";
import { effectDuration, type EffectSpec, sameSpec } from "../../shared/effects.ts";
import { placeLayout } from "../../shared/geometry.ts";
import { alerting, DRAFT_BRIGHTNESS, fromDark, withAlert, withPreview } from "../../shared/render.ts";
import { decideZoneScenes, OFF_SCENE, outputScene, wallSceneKey, type ZoneScene } from "../../shared/scene.ts";
import { DEFAULT_SETTINGS, readLayout, readOrder, readSettings, readZones } from "../../shared/storage.ts";
import {
  type ControlEffect,
  type ControlInfo,
  type ControllerConfig,
  type MemberLike,
  type OutputInfo,
  type PanelLight,
  type Preview,
  type ResolvedZone,
  type Rgb,
  type Scene,
  type Settings,
  STORAGE_KEYS,
} from "../../shared/types.ts";
import {
  advanceZones,
  renderZones,
  updateZones,
  type WallBrightness,
  zoneScales,
  zonesBrightness,
  type ZoneStates,
} from "../../shared/zone-render.ts";
import {
  combinedOrder,
  drawnZones,
  resolveZones,
  type ZoneFill,
  zoneFills,
  zoneTagLights,
} from "../../shared/zones.ts";
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

/**
 * An interface preview's lease. `preview` is null for the zone-editing preview (`zones`), which draws every zone in its
 * tag colour rather than going through the render states. `zoneId` is the zone a fill, Play order or tap to order was
 * asked for (null: the first zone); it is resolved against the zones each time, since they can change under it.
 */
interface Lease {
  readonly preview: Preview | null;
  readonly zoneId: string | null;
  readonly until: number;
  /** The interface copy holding it (null: nobody's). */
  readonly owner: string | null;
}

/** A schedule alert waiting for the wall to be taken: its colour, when it is dropped, and the zones it plays in. */
interface WaitingAlert {
  readonly rgb: Rgb;
  readonly until: number;
  readonly zones: ReadonlySet<string>;
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
  /** The zones as they stand on this wall now (zones.ts `resolveZones`), in stored order. */
  #zones: readonly ResolvedZone[] = [];
  /** Each zone's fill order and line spans over its own panels, and where it sits in `#order`. */
  #fills: readonly ZoneFill[] = [];
  /** The wall's one order: each zone's, one zone after another (`combinedOrder`). One zone: the wall's fill order. */
  #order: readonly number[] = [];
  #zonesKey = "";
  /** Each zone's scene, in the zones' order. */
  #scenes: readonly ZoneScene[] = [];
  /** The scene `output` speaks for (`outputScene`). */
  #scene: Scene = OFF_SCENE;
  /** The drawn zones' scene keys joined (`wallSceneKey`; every zone's while none has panels): what a yield holds for. */
  #wallKey: string = OFF_SCENE.key;
  /** Each zone's render state, by zone id. */
  #states: ZoneStates | null = null;
  #lastRecompute = -Infinity;
  #yieldedKey: string | null = null;
  #yieldNote: string | null = null;
  /** The controller's yield mark (claims.ts) its own yield belongs to: it ends when an instance takes the wall. */
  #yieldMark: number | null = null;
  /** The last yield mark it has seen, so it adopts each one once. */
  #seenMark: number | null = null;
  /** The running preview: what it shows, where, when it lapses, and the interface copy holding it. */
  #lease: Lease | null = null;
  /** The lock a controller holds (`takeControl`): its effect shows in place of the workspace's own scene. */
  #control: ControlLock | null = null;
  /** Recent `takeControl` answers per holder, newest first, by `requestId`. */
  readonly #answers = new Map<string, readonly RememberedAnswer[]>();
  /** Makes lease and effect ids: unique within this instance's run, and across runs by its start time. */
  #ids = 0;
  #override: { readonly value: number; readonly until: number } | null = null;
  /** Schedule alerts waiting for the wall to be taken, oldest first: each is dropped once `until` passes. */
  #waiting: readonly WaitingAlert[] = [];
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

  /** Tap to order holds the wall: its taps number panels, so gestures on the wall leave everything else alone. */
  get drafting(): boolean {
    return this.#drafting;
  }

  /** The zone-editing preview stands: every zone in its tag colour, and taps on the wall are the editor's. */
  get editingZones(): boolean {
    return this.#lease !== null && this.#lease.preview === null;
  }

  /** The scene `output` speaks for: on an unsplit wall, the wall's scene. */
  get scene(): Scene {
    return this.#scene;
  }

  /** Each zone's scene, in the zones' order. */
  get scenes(): readonly ZoneScene[] {
    return this.#scenes;
  }

  /** The zones as they stand on this wall now; their panels are the wall's light panels. */
  get zones(): readonly ResolvedZone[] {
    return this.#zones;
  }

  get yieldedKey(): string | null {
    return this.#yieldedKey;
  }

  /** The last published output, without `since`. */
  get output(): OutputCore | null {
    return this.#output;
  }

  /** The wall's order (panel ids): each zone's fill order, one zone after another. One zone: its fill order. */
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
   * is the named activity's, else the scene's. A `draft` (tap to order) holds the wall in its own colours at
   * `DRAFT_BRIGHTNESS`, takes it even from a yield, and keeps schedule alerts off it. `shown`: it is (or is becoming)
   * in control.
   *
   * Zones: `identify` shows in every zone (it names panels). `fill` and `order` show in the zone `zoneId` names (the
   * first zone when it is left out), and the other zones keep their scenes. `draft` holds the whole wall: the named
   * zone shows the draft and the others are dark. A `zoneId` that names no zone standing now is taken as `none`, and a
   * lease whose zone stops standing ends (a draft's numbered panels belong to that zone). `zones` shows every zone in
   * its tag colour; schedule alerts waiting for the wall are dropped, since they wouldn't be seen.
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
    const panelIds = (request.panelIds ?? []).filter((id) => Number.isInteger(id));
    const preview: Preview | null =
      request.mode === "zones"
        ? null
        : request.mode === "identify"
          ? { mode: "identify", panelIds, rgb }
          : request.mode === "draft"
            ? { mode: "draft", panelIds, rgb: null }
            : request.mode === "fill"
              ? { mode: "fill", fraction: Math.min(1, Math.max(0, request.fraction ?? 0)), rgb }
              : { mode: "order", rgb };
    const zoneId = preview !== null && preview.mode !== "identify" ? (request.zoneId ?? null) : null;
    if (zoneId !== null && !this.#zones.some((zone) => zone.id === zoneId)) {
      const held = this.#lease?.owner ?? null;
      if (held === null || owner === null || held === owner) this.#endLease(now);
      return { shown: false };
    }
    this.#lease = { preview, zoneId, until: now + (request.ttlMs ?? this.timings.previewTtlMs), owner };
    if (preview === null) this.#waiting = [];
    this.#applyLease(now);
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
   * whatever shows, a preview included, but not tap to order or the zone-editing preview, whose alerts are dropped. It
   * swells in the zones whose member the schedule speaks to (`members`, the schedule's; left out, every zone), each as
   * that zone's own alert, among the zones that are drawn (every zone while none has panels, as before the layout is
   * known); when it speaks to none of them, nothing happens. When the plugin isn't driving the
   * wall it takes it for the alert, which starts
   * once the wall is its own; an alert that can't start within `alertWaitMs` is dropped, never played late (the wall
   * is yielded, someone else's, disconnected, or driven by static writes, which can't swell). Nothing happens with
   * the `scheduleAlert` setting or driving switched off. `shown`: it plays, or the wall is being taken for it.
   */
  alert(activityId: string | null, members?: readonly string[]): { shown: boolean } {
    if (this.#stopped || !this.#started) return { shown: false };
    const now = this.#now();
    this.#recompute(now);
    if (!this.#settings.enabled || !this.#settings.scheduleAlert) return { shown: false };
    if (this.#drafting || this.editingZones) return { shown: false };
    const zones = new Set(
      this.#shownZones()
        .filter((zone) => members === undefined || speaksTo(members, zone.following))
        .map((zone) => zone.id),
    );
    if (zones.size === 0) return { shown: false };
    const rgb = this.#colourOf(activityId) ?? WARM_WHITE;
    const session = this.#wall.session;
    if (session) {
      if (session.mode !== "stream" || !this.#states) return { shown: false };
      this.#states = updateZones(this.#states, (state, id) => (zones.has(id) ? withAlert(state, rgb, now) : state));
      this.#evaluate(now);
      return { shown: true };
    }
    this.#waiting = [...this.#waiting, { rgb, until: now + this.timings.alertWaitMs, zones }];
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

  /** The `brightness` request: overrides Session brightness for `overrideMs`, applied at once when in control. */
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

  /** Tap to order holds the wall (the running lease is a `draft`). */
  get #drafting(): boolean {
    return this.#lease?.preview?.mode === "draft";
  }

  #endLease(now: number): void {
    if (!this.#lease) return;
    this.#lease = null;
    this.#applyLease(now);
    this.#evaluate(now);
  }

  /**
   * The zone a lease's fill, Play order or draft shows in: the one it names, the first when it names none; null when
   * that zone no longer stands (the lease is then ended at the next recompute).
   */
  #leaseZone(lease: Lease): string | null {
    if (lease.zoneId === null) return this.#zones[0]?.id ?? null;
    return this.#zones.some((zone) => zone.id === lease.zoneId) ? lease.zoneId : null;
  }

  /** Whether the lease shows in this zone (the zone-editing preview counts, drawn in place of the render states). */
  #leaseShowsIn(lease: Lease | null, zoneId: string): boolean {
    if (!lease) return false;
    if (lease.preview === null || lease.preview.mode === "identify") return true;
    return this.#leaseZone(lease) === zoneId;
  }

  /**
   * Puts the lease into each zone's render state (`withPreview`), and takes it out of the zones it doesn't show in:
   * after a new lease, when it ends, and after each recompute, so a zone that just appeared gets it too. The zone-
   * editing preview leaves the render states without a preview.
   */
  #applyLease(now: number): void {
    const states = this.#states;
    if (!states) return;
    const lease = this.#lease;
    const preview = lease?.preview ?? null;
    this.#states = updateZones(states, (state, id) =>
      withPreview(state, preview !== null && this.#leaseShowsIn(lease, id) ? preview : null, now),
    );
  }

  /** The zones that are drawn (have panels), or every zone when none is: what showing and brightness are about. */
  #shownZones(): readonly ResolvedZone[] {
    return drawnZones(this.#zones);
  }

  #sceneOf(zoneId: string): Scene {
    return this.#scenes.find((zone) => zone.id === zoneId)?.scene ?? OFF_SCENE;
  }

  /** What the wall needs (zone-render.ts `zonesBrightness`): the highest any shown zone needs, and each one's need. */
  #wallBrightness(now: number): WallBrightness {
    const lease = this.#lease;
    const states = this.#states;
    return zonesBrightness(
      this.#settings,
      this.#shownZones().map((zone) => {
        const state = states?.get(zone.id);
        return {
          id: zone.id,
          scene: this.#sceneOf(zone.id),
          preview: this.#leaseShowsIn(lease, zone.id),
          alert:
            (state !== undefined && alerting(state, now)) ||
            this.#waiting.some((alert) => alert.zones.has(zone.id)),
        };
      }),
    );
  }

  /**
   * The brightness to drive at: tap to order's own while it holds the wall, else a running `brightness` override (a
   * slider being dragged), else the highest any zone needs: Session brightness for a session, a preview or another
   * plugin's effect, a pin's own brightness. A preview over a pin shows at Session brightness, so it's seen however
   * dim the pin is. On an unsplit wall that is the wall's own need.
   */
  #targetBrightness(now: number): number {
    if (this.#drafting) return DRAFT_BRIGHTNESS;
    const override = this.#override;
    if (override && now < override.until) return override.value;
    return this.#wallBrightness(now).brightness;
  }

  /**
   * Each zone's level scale for a frame at `now`, or null to draw every zone at 1: against the brightness the
   * controller is at (`applied`, which lags a change of target), so a zone that needs less than another (a pin beside
   * a session) keeps its look while the write is on its way. Null on a wall with one drawn zone (it is the target, as
   * before zones), under tap to order, a slider's override and the zone-editing preview.
   */
  #scales(now: number, applied: number | null): ReadonlyMap<string, number> | null {
    if (this.#drafting || this.editingZones) return null;
    const override = this.#override;
    if (override && now < override.until) return null;
    if (this.#zones.filter((zone) => zone.panels.length > 0).length < 2) return null;
    const { brightness, needs } = this.#wallBrightness(now);
    return zoneScales(needs, applied ?? brightness);
  }

  #recompute(now: number): void {
    const settings = readSettings(this.#o.storage.get(STORAGE_KEYS.settings));
    if (this.#enabled !== null && settings.enabled !== this.#enabled) this.#clearYield();
    this.#enabled = settings.enabled;
    this.#settings = settings;
    if (this.#controlOver(now)) {
      this.#control = null;
      try {
        this.#o.publishControl?.(null);
      } catch (error) {
        this.#o.log.error("Couldn't publish the control state", error);
      }
    }
    const { activities, sessions, members } = this.#o.data();
    this.#refreshZones(settings, members);
    // A fill, Play order or draft for a zone that is gone ends, rather than moving to another zone.
    const lease = this.#lease;
    if (lease !== null && lease.zoneId !== null && this.#leaseZone(lease) === null) this.#lease = null;
    const scenes = decideZoneScenes({ activities, sessions, settings, now, control: this.#control }, this.#zones);
    const shown = new Set(this.#shownZones().map((zone) => zone.id));
    const drawn = scenes.filter((zone) => shown.has(zone.id));
    // The yield holds for what the wall draws: a zone with no panels changing doesn't take the wall back.
    const key = wallSceneKey(drawn);
    if (this.#yieldedKey !== null && key !== this.#yieldedKey) this.#clearYield();
    this.#scenes = scenes;
    this.#wallKey = key;
    this.#scene = outputScene(drawn, sessions);
    this.#states = advanceZones(this.#states, scenes, now);
    this.#applyLease(now);
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
    this.#yieldedKey = this.#wallKey;
    this.#yieldNote = mark.reason;
  }

  /**
   * Re-resolves the zones and their fills when the zones, the layout, an order, the view rotation, the controller or
   * the roster changed: `resolveZones` over the layout's light panels (none without a layout for this controller),
   * then each zone's fill order over its own panels as they hang (`zoneFills`). Not per frame.
   */
  #refreshZones(settings: Settings, members: readonly MemberLike[]): void {
    const layoutRaw = this.#o.storage.get(STORAGE_KEYS.layout);
    const orderRaw = this.#o.storage.get(STORAGE_KEYS.order);
    const zonesRaw = this.#o.storage.get(STORAGE_KEYS.zones);
    const controllerId = this.#link.controllerId;
    const roster = members.map((member) => [member.id, member.role]);
    const key = JSON.stringify([
      controllerId,
      settings.viewRotation,
      layoutRaw ?? null,
      orderRaw ?? null,
      zonesRaw ?? null,
      roster,
    ]);
    if (key === this.#zonesKey) return;
    this.#zonesKey = key;
    const layout = readLayout(layoutRaw);
    const placed =
      layout && controllerId !== null && layout.controllerId === controllerId
        ? placeLayout(layout, settings.viewRotation).panels
        : [];
    const zones = resolveZones(
      readZones(zonesRaw),
      placed.map((panel) => panel.id),
      members,
      readOrder(orderRaw),
    );
    this.#zones = zones;
    this.#fills = zoneFills(zones, placed);
    this.#order = combinedOrder(this.#fills);
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
      showing: this.#shownZones().some((zone) => this.#sceneOf(zone.id).kind !== "off"),
      sceneKey: this.#wallKey,
      previewActive: this.#lease !== null,
      draftActive: this.#drafting,
      alertActive: this.#waiting.length > 0 || this.#alerting(this.#now()),
      yieldedKey: this.#yieldedKey,
      claimedElsewhere: claim !== null && claim.token !== this.#o.owner.token,
      inControl: this.#wall.session !== null,
      note: this.#wall.note,
      yieldNote: this.#yieldNote,
    };
  }

  /** A schedule alert plays in some zone. */
  #alerting(now: number): boolean {
    const states = this.#states;
    if (!states) return false;
    for (const state of states.values()) if (alerting(state, now)) return true;
    return false;
  }

  #wants(): boolean {
    return !this.#hold && !this.#stopped && wantsControl(this.#input());
  }

  /** Expires leases, then starts whatever the moment calls for (takeover, release, leftover hand-back). */
  #evaluate(now: number): void {
    if (!this.#started || this.#stopped) return;
    if (this.#lease && now >= this.#lease.until) {
      this.#lease = null;
      this.#applyLease(now);
    }
    if (this.#override && now >= this.#override.until) this.#override = null;
    if (this.#waiting.length > 0) {
      // Dropped once too late, or once none of its zones is drawn any more (it would take the wall to play nothing).
      const shown = this.#shownZones();
      const stays = (alert: WaitingAlert) => now < alert.until && shown.some((zone) => alert.zones.has(zone.id));
      if (!this.#waiting.every(stays)) this.#waiting = this.#waiting.filter(stays);
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
   * The wall is ours: every zone fades in from dark (with any preview), the schedule alerts that waited for it start in
   * their zones (static writes can't swell, so they are dropped there) and the first frame goes at once. From the
   * tracked render states, not fresh ones: a goal met by the change that caused the takeover still shimmers, and a
   * restart in the middle of a session whose goal was met long ago doesn't replay the shimmer.
   */
  #tookOver(session: Session, now: number): void {
    if (this.#states) {
      let states = updateZones(this.#states, (state) => fromDark(state, now));
      if (session.mode === "stream") {
        for (const alert of this.#waiting) {
          if (now >= alert.until) continue;
          states = updateZones(states, (state, id) => (alert.zones.has(id) ? withAlert(state, alert.rgb, now) : state));
        }
      }
      this.#states = states;
    }
    this.#waiting = [];
    this.#frame(now, session);
  }

  /**
   * The wall's lights at `now`: every zone in its tag colour while the zone-editing preview stands, else each zone's
   * render state drawn over its own fill and merged (only tap to order's zone while it holds the wall).
   */
  #lights(now: number, session: Session): Map<number, PanelLight> {
    const lease = this.#lease;
    if (lease !== null && lease.preview === null) return zoneTagLights(this.#zones);
    if (!this.#states) return new Map();
    return renderZones(this.#states, this.#fills, now, {
      scales: this.#scales(now, session.applied),
      only: this.#drafting && lease ? this.#leaseZone(lease) : null,
    });
  }

  #frame(now: number, session: Session): void {
    if (this.#states && this.#order.length > 0) sendFrame(this.#host, session, this.#lights(now, session), this.#order, now);
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
    this.#yieldedKey = this.#wallKey;
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
