import { PluginError } from "@drift-beacon/plugin/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_PERIOD_MS, REVEAL_MS } from "../../../shared/effects.ts";
import { addressKind, lanProblem } from "../../../shared/lan.ts";
import { decideScene } from "../../../shared/scene.ts";
import { DEFAULT_ORDER, DEFAULT_SETTINGS, readSettings } from "../../../shared/storage.ts";
import type {
  ActivityLike,
  ConnectionInfo,
  ConnectionStatus,
  ControlEffectType,
  ControlLease,
  Layout,
  OutputInfo,
  PanelOrder,
  Scene,
  SessionLike,
  Settings,
  TouchGesture,
} from "../../../shared/types.ts";
import { useNow } from "../hooks/useNow.ts";
import type { ControllerChange, MainStatus, NanoleafModel, PreviewRequest } from "../model.ts";
import {
  activitiesFor,
  CONTROLLERS,
  FOUND,
  GOAL_ACTIVITY,
  type LayoutKey,
  layoutFor,
  liveSpan,
  ME,
  nextSessionId,
  PLAIN_ACTIVITY,
  type SimController,
  sessionsFor,
  sortSessions,
  type StartState,
} from "./fixtures.ts";

/*
 * Stand-in for main and the controller. SimPanel fires the events the app and the wall would (a session starts, the
 * controller drops off, someone picks an effect in the Nanoleaf app); useSimModel keeps every piece of state locally
 * and answers the model's requests with the delays the real ones have, so the production App runs unchanged over it.
 */

export type SimAction =
  | { type: "start"; goal: boolean }
  | { type: "end" }
  | { type: "pin" }
  | { type: "archive" }
  | { type: "progress" }
  | { type: "speed" }
  | { type: "unreachable" }
  | { type: "unauthorized" }
  | { type: "takeover" }
  | { type: "control" }
  | { type: "tap" }
  | { type: "busy" }
  | { type: "main" }
  | { type: "elsewhere" }
  | { type: "old-app" };

const ACTION_EVENT = "nanoleaf-sim";
const STATE_EVENT = "nanoleaf-sim-state";

/** Fire a simulated event at whichever variant is mounted. */
export const sendSim = (action: SimAction) =>
  window.dispatchEvent(new CustomEvent<SimAction>(ACTION_EVENT, { detail: action }));

/** What SimPanel shows of the simulated world. */
export interface SimReadout {
  readonly mode: OutputInfo["mode"] | "main down" | "connecting";
  readonly activity: string | null;
  readonly fraction: number | null;
  readonly speed: number;
  readonly connection: ConnectionStatus;
}

/** Follow the simulated world, for the SimPanel readout. */
export function onSimState(fn: (readout: SimReadout) => void): () => void {
  const listener = (e: Event) => fn((e as CustomEvent<SimReadout>).detail);
  window.addEventListener(STATE_EVENT, listener);
  return () => window.removeEventListener(STATE_EVENT, listener);
}

/** How a variant opens. */
export interface SimOptions {
  readonly start: StartState;
}

interface Lease {
  readonly preview: PreviewRequest;
  readonly until: number;
}

interface SimState {
  readonly activities: readonly ActivityLike[];
  readonly sessions: readonly SessionLike[];
  readonly settings: Settings;
  readonly order: PanelOrder;
  readonly controller: SimController | null;
  readonly layout: Layout | null;
  readonly connection: ConnectionInfo;
  /** The scene key the wall was taken from us during (someone picked an effect in the Nanoleaf app). */
  readonly yieldedKey: string | null;
  readonly busy: boolean;
  /** Another plugin holds the wall (the cube was picked up): its effect shows in place of the scene. */
  readonly control: ControlLease | null;
  readonly mainStatus: MainStatus;
  /** Behave like a Drift Beacon older than SDK 0.2.2: rows without goals, periods or pins. */
  readonly oldApp: boolean;
  readonly lease: Lease | null;
  readonly override: { readonly value: number; readonly until: number } | null;
  /** The simulated clock runs this many times faster than real time. */
  readonly speed: number;
}

const MIN = 60_000;
const RETRY_S = [10, 20, 30, 60];
/** How long the page waits for main's status at open, like the app's placeholder before the hub's first report. */
const CONNECT_MS = 700;
const MAIN_DOWN_REASON = "The plugin stopped after an error. Drift Beacon restarts it automatically.";

function connectionOf(
  controller: SimController | null,
  status: ConnectionStatus,
  extra: Partial<ConnectionInfo> = {},
): ConnectionInfo {
  return {
    status,
    host: controller?.host ?? null,
    port: controller?.port ?? null,
    name: controller?.name ?? null,
    model: controller?.model ?? null,
    firmware: controller ? "9.2.4" : null,
    error: null,
    retryAt: null,
    events: status === "connected",
    since: new Date().toISOString(),
    ...extra,
  };
}

function initialState(layoutKey: LayoutKey | null, options: SimOptions, now: number): SimState {
  const controller = layoutKey ? CONTROLLERS[layoutKey] : null;
  return {
    activities: activitiesFor(options.start),
    sessions: sessionsFor(options.start, now),
    settings: DEFAULT_SETTINGS,
    order: DEFAULT_ORDER,
    controller,
    layout: layoutKey ? layoutFor(layoutKey) : null,
    connection: connectionOf(controller, controller ? "connected" : "unconfigured"),
    yieldedKey: null,
    busy: false,
    control: null,
    mainStatus: "connecting",
    oldApp: false,
    lease: null,
    override: null,
    speed: 1,
  };
}

/** The rows an older app sends: no goal, period or pinnedBy at all. */
function withoutGoals(activities: readonly ActivityLike[]): ActivityLike[] {
  return activities.map(({ goal: _goal, period: _period, pinnedBy: _pinnedBy, ...rest }) => rest);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** A cube's six faces, as the controller's palette. */
const CUBE_COLORS = [
  [255, 64, 64],
  [255, 170, 0],
  [64, 255, 96],
  [0, 200, 255],
  [150, 90, 255],
  [255, 80, 200],
] as const;
const CONTROL_STEPS: readonly ControlEffectType[] = ["pulse", "shuffle", "reveal"];

/** The next step of a cube roll: picked up (pulse), shaken (shuffle), landed (reveal), then let go. */
function nextControl(control: ControlLease | null, now: number): ControlLease | null {
  const step = control ? CONTROL_STEPS.indexOf(control.effect.type) + 1 : 0;
  const type = CONTROL_STEPS[step];
  if (!type) return null;
  return {
    holder: "magic-cube",
    leaseId: control?.leaseId ?? `sim-${now}`,
    effect: {
      id: `sim-${type}-${now}`,
      type,
      colors: CUBE_COLORS,
      periodMs: DEFAULT_PERIOD_MS[type],
      color: type === "reveal" ? CUBE_COLORS[3] : null,
      startedAt: now,
    },
  };
}

/** Main runs (the page may not have heard so yet, but requests reach it). */
const mainRuns = (status: MainStatus) => status === "running" || status === "connecting";

/** What main would publish as `output`, without `since`; null while main isn't running or the page hasn't heard. */
function outputOf(s: SimState, scene: Scene, now: number): Omit<OutputInfo, "since"> | null {
  if (s.mainStatus !== "running") return null;
  const quiet = { activityId: null, fraction: null, inControl: false, detail: null };
  if (!s.controller || s.connection.status !== "connected") return { ...quiet, mode: "disconnected" };
  if (!s.settings.enabled) return { ...quiet, mode: "paused" };
  if (s.busy) return { ...quiet, mode: "busy", detail: "Another Drift Beacon user is driving this wall" };
  const fraction = scene.progress ? round3(Math.min(Math.max(scene.progress.fraction, 0), 1.5)) : null;
  const lease = s.lease && s.lease.until > now && s.lease.preview.mode !== "none" ? s.lease : null;
  if (lease) {
    const activityId = lease.preview.activityId ?? scene.activityId;
    return { mode: "preview", activityId, fraction, inControl: true, detail: "Showing a preview from this page" };
  }
  if (s.yieldedKey !== null && s.yieldedKey === scene.key) {
    return { ...quiet, mode: "yielded", activityId: scene.activityId, fraction, detail: "Changed in the Nanoleaf app" };
  }
  if (scene.kind === "off") {
    return { ...quiet, mode: "idle", detail: s.settings.idle === "off" ? "Turned off" : "Showing its own scene" };
  }
  const detail = s.override && s.override.until > now ? `Trying ${s.override.value}% brightness` : null;
  return { mode: scene.kind, activityId: scene.activityId, fraction, inControl: true, detail };
}

const sameOutput = (a: Omit<OutputInfo, "since"> | null, b: Omit<OutputInfo, "since"> | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.mode === b.mode &&
    a.activityId === b.activityId &&
    a.fraction === b.fraction &&
    a.inControl === b.inControl &&
    a.detail === b.detail);

function lightPanelIds(layout: Layout | null): number[] {
  return layout
    ? layout.panels.filter((p) => p.shapeType === 7 || p.shapeType === 8 || p.shapeType === 9).map((p) => p.id)
    : [];
}

/**
 * Resolves after `ms`, unless the sim unmounts first (then it never settles) or `signal` aborts (then it rejects with
 * the signal's reason, as a request the interface gave up does).
 */
type Wait = (ms: number, signal?: AbortSignal) => Promise<void>;

/** How long the simulated pairing takes to reach the controller, and to read its layout once it has a token. */
const PAIR_REACH_MS = 500;
const PAIR_CONNECT_MS = 500;

/**
 * A full NanoleafModel over local state: a simulated clock (SimPanel's `T` runs it ×60), a simulated controller
 * (discovery answers after 1.2 s, pairing after about 4 s, telling its steps) and the published state main would
 * derive.
 */
export function useSimModel(layoutKey: LayoutKey | null, options: SimOptions): NanoleafModel {
  const [state, setState] = useState<SimState>(() => initialState(layoutKey, options, Date.now()));
  const now = useNow(1000);
  const ref = useRef(state);
  ref.current = state;
  const timers = useRef<number[]>([]);
  const listeners = useRef(new Set<(panelId: number, gesture: TouchGesture) => void>());
  const changeListeners = useRef(new Set<(change: ControllerChange) => void>());
  const resyncListeners = useRef(new Set<() => void>());
  const pairAttempts = useRef(new Map<string, number>());
  const retries = useRef(0);

  const update = useCallback((fn: (s: SimState) => SimState) => setState((s) => fn(s)), []);
  const wait: Wait = useCallback(
    (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = () => {
          window.clearTimeout(id);
          reject(signal?.reason);
        };
        const id = window.setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        timers.current.push(id);
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    [],
  );
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  // Opening: the app reports main's status a moment after the page connects.
  useEffect(() => {
    const id = window.setTimeout(
      () => update((s) => (s.mainStatus === "connecting" ? { ...s, mainStatus: "running" } : s)),
      CONNECT_MS,
    );
    return () => window.clearTimeout(id);
  }, [update]);

  const activities = useMemo(
    () => (state.oldApp ? withoutGoals(state.activities) : state.activities),
    [state.activities, state.oldApp],
  );
  const scene = useMemo(
    () =>
      decideScene({
        userId: ME,
        activities,
        sessions: state.sessions,
        settings: state.settings,
        now: new Date(now),
        control: state.control,
      }),
    [activities, state.sessions, state.settings, now, state.control],
  );
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  // A reveal ends its own hold once it has played, as main's lease does.
  useEffect(() => {
    const control = state.control;
    if (control?.effect.type !== "reveal") return;
    const id = window.setTimeout(
      () => update((s) => (s.control?.effect.id === control.effect.id ? { ...s, control: null } : s)),
      Math.max(0, control.effect.startedAt + REVEAL_MS - Date.now()),
    );
    return () => window.clearTimeout(id);
  }, [state.control, update]);

  // Yielding lasts until something different should show.
  useEffect(() => {
    if (state.yieldedKey !== null && state.yieldedKey !== scene.key) update((s) => ({ ...s, yieldedKey: null }));
  }, [scene.key, state.yieldedKey, update]);

  // The simulated clock: running faster than real time moves every session into the past.
  useEffect(() => {
    if (state.speed <= 1) return;
    const step = 250;
    const shift = (state.speed - 1) * step;
    const id = window.setInterval(() => {
      update((s) => ({
        ...s,
        sessions: s.sessions.map((x) => ({
          ...x,
          startedAt: new Date(x.startedAt.getTime() - shift),
          endedAt: x.endedAt ? new Date(x.endedAt.getTime() - shift) : null,
        })),
      }));
    }, step);
    return () => window.clearInterval(id);
  }, [state.speed, update]);

  // Unreachable: main retries on a backoff and publishes when it will next try.
  useEffect(() => {
    if (state.connection.status !== "unreachable" || !state.connection.retryAt) return;
    const at = Date.parse(state.connection.retryAt);
    const id = window.setTimeout(
      () => {
        update((s) =>
          s.connection.status === "unreachable" ? { ...s, connection: { ...s.connection, status: "connecting" } } : s,
        );
        timers.current.push(
          window.setTimeout(() => {
            retries.current += 1;
            const delay = RETRY_S[Math.min(retries.current, RETRY_S.length - 1)];
            update((s) =>
              s.connection.status === "connecting" && s.controller
                ? { ...s, connection: unreachable(s.controller, delay) }
                : s,
            );
          }, 900),
        );
      },
      Math.max(0, at - Date.now()),
    );
    return () => window.clearTimeout(id);
  }, [state.connection, update]);

  // Published output, with `since` kept while nothing but time changes.
  const lastOutput = useRef<{ value: Omit<OutputInfo, "since"> | null; since: string } | null>(null);
  const output = useMemo<OutputInfo | null>(() => {
    const value = outputOf(state, scene, now);
    if (!lastOutput.current || !sameOutput(lastOutput.current.value, value)) {
      lastOutput.current = { value, since: new Date().toISOString() };
    }
    return value ? { ...value, since: lastOutput.current.since } : null;
  }, [state, scene, now]);
  const stableOutput = useStable(output, (a, b) => a === b || (!!a && !!b && sameOutput(a, b) && a.since === b.since));

  useEffect(() => {
    const activity = activities.find((a) => a.id === scene.activityId)?.name ?? null;
    const readout: SimReadout = {
      mode:
        state.mainStatus === "connecting"
          ? "connecting"
          : state.mainStatus !== "running"
            ? "main down"
            : (stableOutput?.mode ?? "disconnected"),
      activity,
      fraction: scene.progress?.fraction ?? null,
      speed: state.speed,
      connection: state.connection.status,
    };
    window.dispatchEvent(new CustomEvent<SimReadout>(STATE_EVENT, { detail: readout }));
  }, [stableOutput, scene, activities, state.speed, state.mainStatus, state.connection.status]);

  const requireMain = useCallback(() => {
    if (!mainRuns(ref.current.mainStatus)) {
      throw new PluginError("unavailable", "The Nanoleaf plugin isn't running here right now");
    }
  }, []);

  /** The controller was paired or forgotten: every listener hears, whoever did it (model.ts `onControllerChanged`). */
  const changed = useCallback((change: ControllerChange) => {
    for (const listener of [...changeListeners.current]) listener(change);
  }, []);

  const actions = useMemo<NanoleafModel["actions"]>(
    () => ({
      async saveSettings(patch) {
        update((s) => {
          const settings = readSettings({ ...s.settings, ...patch });
          const yieldedKey = patch.enabled !== undefined && patch.enabled !== s.settings.enabled ? null : s.yieldedKey;
          return { ...s, settings, yieldedKey };
        });
      },
      async saveOrder(order) {
        update((s) => ({ ...s, order }));
      },
      async discover(_timeoutMs, signal) {
        requireMain();
        await wait(1200, signal);
        return FOUND;
      },
      async pair(host, port = 16021, { signal, onStep } = {}) {
        requireMain();
        // As main does: only a private address on the local network (an installed build refuses loopback too).
        const kind = addressKind(host);
        if (kind !== null && kind !== "lan") throw new PluginError("invalid", lanProblem(host, kind));
        const known = Object.values(CONTROLLERS).find((c) => c.host === host);
        if (!known && host.startsWith("10.")) {
          await wait(2200, signal);
          throw new PluginError(
            "unavailable",
            `Nothing answered at ${host}:${port}. Check the address, and that the controller is on the same network.`,
          );
        }
        const attempts = (pairAttempts.current.get(host) ?? 0) + 1;
        pairAttempts.current.set(host, attempts);
        await wait(PAIR_REACH_MS, signal);
        onStep?.("waiting");
        // The second controller plays the forgetful user: its first attempt times out without the button hold.
        if (known?.key === "wings" && attempts === 1) {
          await wait(6000 - PAIR_REACH_MS, signal);
          throw new PluginError(
            "failed",
            "The controller didn't open its pairing window. Hold its power button for 5–7 seconds until the lights " +
              "flash, then try again.",
          );
        }
        await wait(4000 - PAIR_REACH_MS - PAIR_CONNECT_MS, signal);
        // A token was handed out: from here main finishes whatever the interface does.
        onStep?.("connecting");
        await wait(PAIR_CONNECT_MS);
        const controller: SimController = known ?? { ...CONTROLLERS.hexagons, host, port };
        const layout = layoutFor(controller.key);
        retries.current = 0;
        update((s) => ({
          ...s,
          controller,
          layout,
          connection: connectionOf(controller, "connected"),
          yieldedKey: null,
        }));
        // As main does: every copy hears it, the one that asked included, before the answer.
        changed("paired");
        return { name: controller.name, model: controller.model, panels: lightPanelIds(layout).length };
      },
      async forget() {
        requireMain();
        await wait(700);
        update((s) => ({ ...s, controller: null, layout: null, connection: connectionOf(null, "unconfigured") }));
        changed("forgotten");
      },
      async refresh() {
        requireMain();
        update((s) => ({ ...s, connection: connectionOf(s.controller, "connecting") }));
        await wait(900);
        retries.current = 0;
        update((s) => ({ ...s, connection: connectionOf(s.controller, s.controller ? "connected" : "unconfigured") }));
      },
      async resume() {
        requireMain();
        update((s) => ({ ...s, yieldedKey: null }));
      },
      async preview(request) {
        if (!mainRuns(ref.current.mainStatus)) return;
        const until = Date.now() + (request.ttlMs ?? 4000);
        update((s) => ({ ...s, lease: request.mode === "none" ? null : { preview: request, until } }));
      },
      async brightness(value) {
        requireMain();
        update((s) => ({ ...s, override: { value: Math.round(value), until: Date.now() + 3000 } }));
      },
    }),
    [requireMain, update, wait, changed],
  );

  const onTouch = useCallback((listener: (panelId: number, gesture: TouchGesture) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const onControllerChanged = useCallback((listener: (change: ControllerChange) => void) => {
    changeListeners.current.add(listener);
    return () => {
      changeListeners.current.delete(listener);
    };
  }, []);
  const onResync = useCallback((listener: () => void) => {
    resyncListeners.current.add(listener);
    return () => {
      resyncListeners.current.delete(listener);
    };
  }, []);

  // SimPanel's events.
  useEffect(() => {
    const handle = (action: SimAction) => {
      const s = ref.current;
      const t = Date.now();
      switch (action.type) {
        case "start": {
          const activityId = action.goal ? GOAL_ACTIVITY : PLAIN_ACTIVITY;
          update((x) => ({ ...x, sessions: sortSessions([...endLive(x.sessions, t), liveSpan(activityId, t, 0)]) }));
          break;
        }
        case "end":
          update((x) => ({ ...x, sessions: sortSessions(endLive(x.sessions, t)) }));
          break;
        case "pin":
          // Pins on archived activities stay as they are: the wall ignores them anyway.
          update((x) => {
            const pinned = x.activities.some((a) => !a.archived && a.pinnedBy?.includes(ME));
            return {
              ...x,
              activities: x.activities.map((a) => {
                if (a.archived) return a;
                const others = (a.pinnedBy ?? []).filter((id) => id !== ME);
                return { ...a, pinnedBy: !pinned && a.id === "guitar" ? [...others, ME] : others };
              }),
            };
          });
          break;
        case "archive": {
          // Someone archives (or restores) the activity the user is live on: its session keeps the wall lit.
          const live = s.sessions.find((x) => x.status === "live" && x.memberIds.includes(ME));
          const id = live?.activityId ?? GOAL_ACTIVITY;
          update((x) => ({
            ...x,
            activities: x.activities.map((a) => (a.id === id ? { ...a, archived: !a.archived } : a)),
          }));
          break;
        }
        case "progress":
          update((x) => ({ ...x, sessions: sortSessions(addProgress(x, sceneRef.current, t)) }));
          break;
        case "speed":
          update((x) => ({ ...x, speed: x.speed > 1 ? 1 : 60 }));
          break;
        case "unreachable":
          if (!s.controller) break;
          retries.current = 0;
          update((x) =>
            x.connection.status === "unreachable" || x.connection.status === "connecting"
              ? { ...x, connection: connectionOf(x.controller, "connected") }
              : { ...x, connection: unreachable(x.controller!, RETRY_S[0]) },
          );
          break;
        case "unauthorized":
          if (!s.controller) break;
          update((x) =>
            x.connection.status === "unauthorized"
              ? { ...x, connection: connectionOf(x.controller, "connected") }
              : {
                  ...x,
                  connection: connectionOf(x.controller, "unauthorized", {
                    error: "The controller turned down this plugin's access token. It may have been reset.",
                  }),
                },
          );
          break;
        case "takeover":
          if (sceneRef.current.kind !== "off") update((x) => ({ ...x, yieldedKey: sceneRef.current.key }));
          break;
        case "control":
          // On the drawing's clock (real time), whatever the simulated one does.
          update((x) => ({ ...x, control: nextControl(x.control, Date.now()) }));
          break;
        case "tap": {
          const ids = lightPanelIds(s.layout);
          if (!ids.length || s.connection.status !== "connected") break;
          const id = ids[Math.floor(Math.random() * ids.length)];
          for (const listener of listeners.current) listener(id, "tap");
          break;
        }
        case "busy":
          update((x) => ({ ...x, busy: !x.busy }));
          break;
        case "main":
          update((x) => ({
            ...x,
            mainStatus: x.mainStatus === "running" ? "unavailable" : "running",
            lease: null,
          }));
          // Main started again: it holds no preview of this page's any more, so the page asks again.
          if (s.mainStatus !== "running") for (const listener of [...resyncListeners.current]) listener();
          break;
        case "elsewhere": {
          // Another copy of the interface (a second tab, a phone) pairs the first controller, or forgets this one.
          if (!mainRuns(s.mainStatus)) break;
          const controller = s.controller ? null : CONTROLLERS.theduck;
          retries.current = 0;
          update((x) => ({
            ...x,
            controller,
            layout: controller ? layoutFor(controller.key) : null,
            connection: connectionOf(controller, controller ? "connected" : "unconfigured"),
            yieldedKey: null,
          }));
          changed(controller ? "paired" : "forgotten");
          break;
        }
        case "old-app":
          update((x) => ({ ...x, oldApp: !x.oldApp }));
          break;
      }
    };
    const onAction = (e: Event) => handle((e as CustomEvent<SimAction>).detail);
    window.addEventListener(ACTION_EVENT, onAction);
    return () => window.removeEventListener(ACTION_EVENT, onAction);
  }, [update, changed]);

  const running = state.mainStatus === "running";
  const down = !mainRuns(state.mainStatus);
  const controller = useMemo(
    () =>
      state.controller
        ? {
            host: state.controller.host,
            port: state.controller.port,
            name: state.controller.name,
            model: state.controller.model,
          }
        : null,
    [state.controller],
  );

  return useMemo<NanoleafModel>(
    () => ({
      userId: ME,
      activities,
      sessions: state.sessions,
      settings: state.settings,
      order: state.order,
      layout: state.layout,
      controller,
      // State lasts only while main runs.
      connection: running ? state.connection : null,
      output: stableOutput,
      control: running ? state.control : null,
      mainStatus: state.mainStatus,
      mainStatusReason: down ? MAIN_DOWN_REASON : null,
      supportsGoals: !state.oldApp,
      actions,
      onTouch,
      onControllerChanged,
      onResync,
    }),
    [activities, state, controller, running, down, stableOutput, actions, onTouch, onControllerChanged, onResync],
  );
}

/** Keep the previous value while `same` says nothing changed, so the model doesn't churn every tick. */
function useStable<T>(value: T, same: (a: T, b: T) => boolean): T {
  const ref = useRef(value);
  if (!same(ref.current, value)) ref.current = value;
  return ref.current;
}

function unreachable(controller: SimController, retryInS: number): ConnectionInfo {
  return connectionOf(controller, "unreachable", {
    error: `No answer from ${controller.host}:${controller.port}`,
    retryAt: new Date(Date.now() + retryInS * 1000).toISOString(),
  });
}

/** The user's live spans, ended now. */
function endLive(sessions: readonly SessionLike[], now: number): SessionLike[] {
  return sessions.map((x) =>
    x.status === "live" && x.memberIds.includes(ME) ? { ...x, status: "completed", endedAt: new Date(now) } : x,
  );
}

/** +10% on whatever the wall shows (or the goal activity when it shows nothing with a goal). */
function addProgress(s: SimState, scene: Scene, now: number): SessionLike[] {
  const id = scene.progress && scene.activityId ? scene.activityId : GOAL_ACTIVITY;
  const activity = s.activities.find((a) => a.id === id);
  const goal = activity?.goal;
  if (!activity || !goal) return [...s.sessions];
  if (goal.type === "duration") {
    const ms = goal.seconds * 100;
    const live = s.sessions.find((x) => x.activityId === id && x.status === "live" && x.memberIds.includes(ME));
    if (live) {
      return s.sessions.map((x) => (x === live ? { ...x, startedAt: new Date(x.startedAt.getTime() - ms) } : x));
    }
    return [
      ...s.sessions,
      {
        id: nextSessionId(),
        activityId: id,
        type: "span",
        status: "completed",
        memberIds: [ME],
        startedAt: new Date(now - ms - MIN),
        endedAt: new Date(now - MIN),
      },
    ];
  }
  const count = Math.max(1, Math.round(goal.count / 10));
  const added: SessionLike[] = Array.from({ length: count }, (_, i) => ({
    id: nextSessionId(),
    activityId: id,
    type: activity.trackingType,
    status: "completed",
    memberIds: [ME],
    startedAt: new Date(now - (i + 1) * 20 * MIN),
    endedAt: activity.trackingType === "span" ? new Date(now - (i + 1) * 20 * MIN + 15 * MIN) : null,
  }));
  return [...s.sessions, ...added];
}
