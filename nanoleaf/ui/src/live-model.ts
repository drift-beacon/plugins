import type { MainApi, PluginPeer, PluginStatus, UiContext } from "@drift-beacon/plugin/ui";
import { useEffect, useMemo, useState } from "react";
import { readController, readLayout, readOrder, readSettings, sameLayout } from "../../shared/storage.ts";
import {
  type ActivityLike,
  type ConnectionInfo,
  type OutputInfo,
  type PanelOrder,
  type SessionLike,
  STORAGE_KEYS,
  type TouchGesture,
} from "../../shared/types.ts";
import type { ControllerChange, PreviewRequest } from "../../shared/ui-channel.ts";
import { useDriftBeacon } from "./drift-beacon.ts";
import { clockOffset, controlOnPageClock } from "./lib/control.ts";
import type { MainStatus, NanoleafModel } from "./model.ts";

/** Request budgets: pairing waits for a button hold, discovery for answers, forgetting and refreshing for the device. */
export const PAIR_TIMEOUT_MS = 30_000;
const DISCOVER_MS = 2500;
const SLOW_TIMEOUT_MS = 15_000;
/**
 * Previews and brightness must feel instant, and a slider sends one every 120 ms: a short budget keeps the ones still
 * waiting (while main starts) under the 16 a copy may have in flight, so they never crowd out a pairing.
 */
const QUICK_TIMEOUT_MS = 1500;
const RESUME_TIMEOUT_MS = 3000;

/**
 * How long an `unavailable` the page connected with stays unconfirmed: before the hub's first report the app says
 * "Waiting for Drift Beacon" (contract P19), which normally clears well within this; a real failure shows this late.
 */
export const STATUS_WAIT_MS = 3000;

const GESTURES: readonly TouchGesture[] = ["tap", "double-tap", "swipe-up", "swipe-down", "swipe-left", "swipe-right"];

/** An integer within the bounds main checks a request's input against (shared/ui-channel.ts). */
const clampInt = (value: number, min: number, max: number) => Math.min(Math.max(Math.round(value), min), max);

/** Storage values and published state are JSON, so serialising says whether two are the same. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A reader that keeps its last result while the value is unchanged by value. The SDK gives every stored object and
 * every published state value a fresh identity on each push (the echo of this page's own writes included), so
 * identity can't tell a change: without this, rotating the drawing re-laid the wall out and cut its turn short.
 */
export function stableReader<T>(
  read: (raw: unknown) => T,
  same: (a: T, b: T) => boolean = jsonEqual,
): (raw: unknown) => T {
  let last: { readonly raw: unknown; readonly value: T } | null = null;
  return (raw) => {
    if (last && last.raw === raw) return last.value;
    const next = read(raw);
    const value = last && same(last.value, next) ? last.value : next;
    last = { raw, value };
    return value;
  };
}

/**
 * A storage write that can't become an unhandled rejection: a refusal (the SDK has rolled the value back) is logged
 * here, and the same promise still rejects for a caller that shows it. Returned as is, not re-wrapped, so a caller that
 * drops it drops a handled promise.
 */
export function loggedWrite(write: Promise<void>, what: string, log: (...data: unknown[]) => void = console.warn) {
  write.catch((error: unknown) => log(`Nanoleaf: couldn't save the ${what}`, error));
  return write;
}

/** The paired controller without its token: the token stays out of the view. */
function controllerView(raw: unknown): NanoleafModel["controller"] {
  const config = readController(raw);
  return config ? { host: config.host, port: config.port, name: config.name, model: config.model } : null;
}

/**
 * What the page can say about main. An `unavailable` it connected with is `connecting` until it's confirmed (the
 * status changed since, or `STATUS_WAIT_MS` passed): it may be the app's placeholder, not main's real state.
 */
export function mainStatusOf(
  status: PluginStatus | undefined,
  confirmed: boolean,
): { readonly state: MainStatus; readonly reason: string | null } {
  if (!status) return { state: "unavailable", reason: null };
  if (status.state === "unavailable" && !confirmed) return { state: "connecting", reason: null };
  return { state: status.state, reason: status.reason?.trim() || null };
}

/** A status as a comparable string: the SDK keeps its identity while unchanged, but value is what counts. */
const statusKey = (status: PluginStatus | undefined) => (status ? `${status.state}\n${status.reason ?? ""}` : "");

/** Its own peer, or null when this Drift Beacon doesn't share plugins with UIs (then `resume` can't run). */
function selfOf(ctx: UiContext): PluginPeer | null {
  try {
    return ctx.plugins.self;
  } catch {
    return null;
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(
    Object.assign(new Error("This Drift Beacon can't run the plugin's command"), { code: "unavailable" }),
  );
}

/** The part of `ctx.main` the interface uses. */
export type MainPort = Pick<MainApi, "request" | "onMessage" | "onResync">;

/** What the interface asks of main and hears from it, over the private channel. */
export type MainChannel = Pick<
  NanoleafModel["actions"],
  "discover" | "pair" | "forget" | "refresh" | "preview" | "brightness"
> &
  Pick<NanoleafModel, "onControllerChanged" | "onResync"> & {
    /** How far main's clock is ahead of this page's (ms), measured with one request. */
    clockOffset(): Promise<number>;
  };

/** Calls each listener; one that throws is logged and the rest still hear. */
function tellAll<A extends unknown[]>(listeners: ReadonlySet<(...args: A) => void>, ...args: A): void {
  for (const listener of [...listeners]) {
    try {
      listener(...args);
    } catch (error) {
      console.error("Nanoleaf: a listener failed", error);
    }
  }
}

/**
 * The interface's side of the private channel (`ctx.main`): requests main answers in main/src/index.ts, the pairing
 * progress main posts to the copy that asked, and the two things every copy hears (its own changes of controller
 * included). Listening makes this page one of
 * main's open copies, so it is created once per page (`channelOf`).
 */
export function createMainChannel(main: MainPort): MainChannel {
  const changed = new Set<(change: ControllerChange) => void>();
  const resynced = new Set<() => void>();
  // Every change is passed on, this copy's own included (main tells every copy before it answers the one that
  // asked). Guessing which news is "ours" from a request in flight dropped another copy's change made meanwhile, for
  // good when our request then failed. Listeners are idempotent instead (model.ts `onControllerChanged`).
  main.onMessage("controllerChanged", ({ change }) => tellAll(changed, change));
  main.onResync(() => tellAll(resynced));

  return {
    async discover(timeoutMs = DISCOVER_MS, signal) {
      const listen = clampInt(timeoutMs, 500, 8000);
      const { controllers } = await main.request(
        "discover",
        { timeoutMs: listen },
        { timeoutMs: listen + 2000, signal },
      );
      return controllers;
    },
    pair(host, port, { signal, onStep } = {}) {
      const stop = onStep ? main.onMessage("pairing", ({ step }) => onStep(step)) : null;
      const input = port === undefined ? { host } : { host, port };
      return main.request("pair", input, { timeoutMs: PAIR_TIMEOUT_MS, signal }).finally(() => stop?.());
    },
    async forget() {
      await main.request("forget", undefined, { timeoutMs: SLOW_TIMEOUT_MS });
    },
    async refresh() {
      await main.request("refresh", undefined, { timeoutMs: SLOW_TIMEOUT_MS });
    },
    async preview(request) {
      const input: { -readonly [K in keyof PreviewRequest]: PreviewRequest[K] } = { mode: request.mode };
      if (request.panelIds) input.panelIds = [...request.panelIds];
      if (request.fraction !== undefined) input.fraction = Math.min(Math.max(request.fraction, 0), 1);
      if (request.activityId !== undefined) input.activityId = request.activityId;
      if (request.ttlMs !== undefined) input.ttlMs = clampInt(request.ttlMs, 500, 15_000);
      // A preview is a nicety: a missed one isn't worth an error.
      await main.request("preview", input, { timeoutMs: QUICK_TIMEOUT_MS }).catch(() => undefined);
    },
    async brightness(value) {
      await main.request("brightness", { value: clampInt(value, 1, 100) }, { timeoutMs: QUICK_TIMEOUT_MS });
    },
    async clockOffset() {
      const sentAt = Date.now();
      const { now } = await main.request("clock", undefined, { timeoutMs: QUICK_TIMEOUT_MS });
      return clockOffset(sentAt, Date.now(), now);
    },
    onControllerChanged(listener) {
      changed.add(listener);
      return () => void changed.delete(listener);
    },
    onResync(listener) {
      resynced.add(listener);
      return () => void resynced.delete(listener);
    },
  };
}

const channels = new WeakMap<UiContext, MainChannel>();

/** The page's one channel to main: created on first use, kept for the life of its `ctx`. */
function channelOf(ctx: UiContext): MainChannel {
  let channel = channels.get(ctx);
  if (!channel) {
    channel = createMainChannel(ctx.main);
    channels.set(ctx, channel);
  }
  return channel;
}

/**
 * The live model: workspace data and storage from `ctx`, main's published state, the `touch` event and the declared
 * `resume` command through `ctx.plugins.self`, and everything else it asks of main through the private channel
 * (`ctx.main`). It re-renders on `onDataChange` (useDriftBeacon), which the SDK also fires after main's status or
 * state change.
 */
export function useLiveModel(): NanoleafModel {
  const ctx = useDriftBeacon();
  const self = selfOf(ctx);
  const channel = channelOf(ctx);

  // Lists keep their identity until the data changes, so everything below memoises on them.
  const activityList = ctx.activities.list({ includeArchived: true });
  const sessionList = ctx.sessions.list();
  const activities = useMemo(() => activityList.map((a) => a.data as ActivityLike), [activityList]);
  const sessions = useMemo(() => sessionList.map((s): SessionLike => s.data), [sessionList]);
  // An app on SDK 0.2.2 sends `pinnedBy` on every row; with no activities yet there is nothing to tell, so no notice.
  const supportsGoals = useMemo(
    () => activityList.length === 0 || activityList.some((a) => Array.isArray((a.data as ActivityLike).pinnedBy)),
    [activityList],
  );

  // One reader per value, kept for the page's life: each returns its previous object until the value really changes.
  const [read] = useState(() => ({
    settings: stableReader(readSettings),
    order: stableReader(readOrder),
    layout: stableReader(readLayout, sameLayout),
    controller: stableReader(controllerView),
    connection: stableReader((raw) => (raw ?? null) as ConnectionInfo | null),
    output: stableReader((raw) => (raw ?? null) as OutputInfo | null),
    control: stableReader((raw: unknown) => raw ?? null),
  }));
  const settings = read.settings(ctx.storage.get(STORAGE_KEYS.settings));
  const order = read.order(ctx.storage.get(STORAGE_KEYS.order));
  const layout = read.layout(ctx.storage.get(STORAGE_KEYS.layout));
  const controller = read.controller(ctx.storage.get(STORAGE_KEYS.controller));
  const connection = read.connection(self?.state.get("connection"));
  const output = read.output(self?.state.get("output"));

  // A controller's effect runs on main's clock: measure how far this page's is off when it opens and whenever the
  // channel was re-made. Until an answer comes the two clocks count as the same.
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    let current = true;
    const measure = () => {
      channel.clockOffset().then(
        (measured) => {
          if (current) setOffset(measured);
        },
        () => {},
      );
    };
    measure();
    const stop = channel.onResync(measure);
    return () => {
      current = false;
      stop();
    };
  }, [channel]);
  const rawControl = read.control(self?.state.get("control"));
  const control = useMemo(() => controlOnPageClock(rawControl, offset), [rawControl, offset]);

  // Main's status: an `unavailable` the page opened with is confirmed by a change, or by waiting STATUS_WAIT_MS.
  const [opened] = useState(() => statusKey(self?.status));
  const [heard, setHeard] = useState(false);
  const [waited, setWaited] = useState(false);
  if (!heard && statusKey(self?.status) !== opened) setHeard(true);
  useEffect(() => {
    const id = window.setTimeout(() => setWaited(true), STATUS_WAIT_MS);
    return () => window.clearTimeout(id);
  }, []);
  const { state: mainStatus, reason: mainStatusReason } = mainStatusOf(self?.status, heard || waited);

  const actions = useMemo<NanoleafModel["actions"]>(
    () => ({
      // Not async: an async wrapper would be a second, unhandled promise for callers that fire and forget.
      saveSettings(patch) {
        // Read at call time: slider patches can land faster than renders.
        const next = readSettings({ ...readSettings(ctx.storage.get(STORAGE_KEYS.settings)), ...patch });
        return loggedWrite(ctx.storage.set(STORAGE_KEYS.settings, next), "settings");
      },
      saveOrder(next: PanelOrder) {
        return loggedWrite(ctx.storage.set(STORAGE_KEYS.order, { ...next, ids: [...next.ids] }), "panel order");
      },
      discover: channel.discover,
      pair: channel.pair,
      forget: channel.forget,
      refresh: channel.refresh,
      // The one declared command (manifest.json): Home Assistant can run it too.
      async resume() {
        await (self ? self.command("resume", {}, { timeoutMs: RESUME_TIMEOUT_MS }) : unavailable());
      },
      preview: channel.preview,
      brightness: channel.brightness,
    }),
    [ctx, self, channel],
  );

  const onTouch = useMemo<NanoleafModel["onTouch"]>(
    () => (listener) => {
      if (!self) return () => {};
      try {
        return self.onEvent("touch", (payload) => {
          const { panelId, gesture } = (payload ?? {}) as { panelId?: unknown; gesture?: unknown };
          if (typeof panelId === "number" && GESTURES.includes(gesture as TouchGesture)) {
            listener(panelId, gesture as TouchGesture);
          }
        });
      } catch {
        // An app that can't deliver events: touches just never arrive.
        return () => {};
      }
    },
    [self],
  );

  return useMemo<NanoleafModel>(
    () => ({
      userId: ctx.user.id,
      activities,
      sessions,
      settings,
      order,
      layout,
      controller,
      connection,
      output,
      control,
      mainStatus,
      mainStatusReason,
      supportsGoals,
      actions,
      onTouch,
      onControllerChanged: channel.onControllerChanged,
      onResync: channel.onResync,
    }),
    [
      ctx.user.id,
      activities,
      sessions,
      settings,
      order,
      layout,
      controller,
      connection,
      output,
      control,
      mainStatus,
      mainStatusReason,
      supportsGoals,
      actions,
      onTouch,
      channel,
    ],
  );
}
