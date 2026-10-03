import { useEffect, useRef, useState } from "react";
import { activityById, categoryById, type FxActivity } from "./fixtures";
import { drawPool, type Face, FACES, type FaceSlot, faceSlots, type Workspace } from "./model";

/*
 * Stand-in for the physical cube. The harness fires hardware events (the Zigbee2MQTT actions the plugin's main
 * code listens to); useCubeSim runs the same state machine as main/src/index.ts and records rolls the same way.
 */

export type SimAction =
  | { type: "hold" }
  | { type: "shake" }
  | { type: "setDown"; side?: Face }
  | { type: "timeout" }
  | { type: "nextPreset" }
  | { type: "fullRoll" };

const ACTION_EVENT = "magic-cube-sim";
const STATE_EVENT = "magic-cube-sim-state";

export const fireSim = (action: SimAction) => window.dispatchEvent(new CustomEvent<SimAction>(ACTION_EVENT, { detail: action }));

export type CubeState = "idle" | "held" | "activated";
export type LiveView = "idle" | "held" | "activated" | "result";

export interface Roll {
  id: number;
  face: Face;
  slot: FaceSlot;
  activity: FxActivity | null;
  /** The category the activity was drawn from, when the face held a category. */
  fromCategory: string | null;
  /** What that category face could draw, for the slot-machine reveal. */
  poolIds: string[];
  at: number;
  /** Being tracked: a running span (since `at`), or a point marked at `at`. */
  tracked: { kind: "span" | "point"; at: number } | null;
  /** Tracked by the Track setting, rather than by pressing Start / Mark. */
  auto: boolean;
  discarded: boolean;
}

export interface Notice {
  id: number;
  kind: "cancelled" | "timeout" | "disarmed" | "preset" | "started" | "marked" | "discarded";
  title: string;
  detail?: string;
}

let rollSeq = 0;
let noticeSeq = 0;

export function useCubeSim(ws: Workspace) {
  const [cube, setCube] = useState<CubeState>("idle");
  const [view, setView] = useState<LiveView>("idle");
  const [roll, setRoll] = useState<Roll | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const ref = useRef({ cube, view, ws });
  ref.current = { cube, view, ws };
  const timers = useRef<number[]>([]);

  const notify = (kind: Notice["kind"], title: string, detail?: string) => setNotice({ id: ++noticeSeq, kind, title, detail });

  const go = (next: CubeState, nextView: LiveView) => {
    setCube(next);
    setView(nextView);
    ref.current = { ...ref.current, cube: next, view: nextView };
    window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: next }));
  };

  const record = (side: Face) => {
    const { ws } = ref.current;
    const slot = faceSlots(ws.setup)[side];
    let activity: FxActivity | null = null;
    let fromCategory: string | null = null;
    let poolIds: string[] = [];
    if (slot.mapping?.type === "activity") activity = activityById(slot.mapping.id);
    else if (slot.mapping?.type === "category") {
      const pool = drawPool(ws.setup, slot.mapping.id);
      activity = pool[Math.floor(Math.random() * pool.length)] ?? null;
      fromCategory = categoryById(slot.mapping.id)?.name ?? null;
      poolIds = pool.map((x) => x.id);
    }
    // Track: start the span / mark the point the moment it lands. Pin: leave it waiting for the user.
    const auto = ws.autoStart && !!activity;
    const now = Date.now();
    setRoll({
      id: ++rollSeq,
      face: side,
      slot,
      activity,
      fromCategory,
      poolIds,
      at: now,
      tracked: auto && activity ? { kind: activity.trackingType, at: now } : null,
      auto,
      discarded: false,
    });
  };

  const handle = (a: SimAction) => {
    const { cube: state, view: currentView, ws } = ref.current;

    if (a.type === "nextPreset") {
      const others = ws.presets.filter((p) => p.id !== ws.activeId);
      const next = others[Math.floor(Math.random() * others.length)];
      if (next) {
        ws.select(next.id);
        notify("preset", `Preset loaded`, next.name);
      }
      return;
    }
    if (a.type === "fullRoll") {
      for (const t of timers.current) window.clearTimeout(t);
      const at = (ms: number, action: SimAction) => timers.current.push(window.setTimeout(() => handle(action), ms));
      if (state !== "idle") go("idle", "idle");
      at(0, { type: "hold" });
      at(1300, { type: "shake" });
      at(3300, { type: "setDown" });
      return;
    }
    // The same transitions as main: inactivity resets from anywhere.
    if (a.type === "timeout") {
      if (state !== "idle") {
        go("idle", currentView === "result" ? "result" : "idle");
        notify("timeout", "Timed out", "No roll after a minute — the cube went back to sleep.");
      }
      return;
    }
    switch (state) {
      case "idle":
        if (a.type === "hold") go("held", "held");
        break;
      case "held":
        if (a.type === "shake") go("activated", "activated");
        else {
          go("idle", "idle");
          notify("cancelled", "Put down without a shake", "Nothing rolled. Pick it up and shake to arm it.");
        }
        break;
      case "activated":
        if (a.type === "shake") {
          go("held", "held");
          notify("disarmed", "Shaken again — disarmed", "Shake once more to arm it.");
        } else if (a.type === "setDown") {
          const side = a.side ?? FACES[Math.floor(Math.random() * 6)];
          record(side);
          go("idle", "result");
        }
        break;
    }
  };

  useEffect(() => {
    const onAction = (e: Event) => handle((e as CustomEvent<SimAction>).detail);
    window.addEventListener(ACTION_EVENT, onAction);
    return () => window.removeEventListener(ACTION_EVENT, onAction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  return {
    cube,
    view,
    roll,
    notice,
    clearNotice: () => setNotice(null),
    dismiss: () => go(ref.current.cube, "idle"),
    /** Start for a span, Mark for a point. */
    track: () => {
      setRoll((r) => (r?.activity ? { ...r, tracked: { kind: r.activity.trackingType, at: Date.now() }, auto: false } : r));
    },
    discard: () => {
      setRoll((r) => (r ? { ...r, tracked: null, discarded: true } : r));
      notify("discarded", "Discarded");
    },
  };
}

export type CubeSim = ReturnType<typeof useCubeSim>;

/** For the harness readout: the simulated hardware state. */
export function onSimState(fn: (state: CubeState) => void) {
  const l = (e: Event) => fn((e as CustomEvent<CubeState>).detail);
  window.addEventListener(STATE_EVENT, l);
  return () => window.removeEventListener(STATE_EVENT, l);
}
