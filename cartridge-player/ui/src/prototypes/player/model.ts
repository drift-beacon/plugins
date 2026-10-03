import { useCallback, useEffect, useReducer, useRef } from "react";
import { ACTIVITIES, activityById, BLANK_TAGS, INITIAL_SLOT, LIBRARY, type FxActivity } from "./fixtures";

/**
 * What the slot holds, as the UI can know it from storage and sessions:
 * - reading: a tag's `lastSeen` just changed and nothing else has yet (the player beeped, the report is in flight)
 * - playing: a labelled cartridge is in and its session is live
 * - unknown: an unlabelled cartridge is in (`unmatchedTags`)
 * - ready: it was labelled while still in the player; main won't start it until the next insert, so the UI offers to
 * - parked: labelled and in the player, but not tracking (the user said "later")
 * - orphan: a labelled cartridge whose activity no longer exists (main answers 404, nothing starts)
 */
export type Phase = "empty" | "reading" | "playing" | "unknown" | "ready" | "parked" | "orphan";

export type LogKind = "insert" | "eject" | "new" | "label" | "relabel" | "forget" | "start";

export interface LogEntry {
  id: number;
  at: number;
  kind: LogKind;
  tag: string;
  activityId?: string | null;
  minutes?: number;
}

export interface PlayerState {
  mappings: Record<string, string>;
  unmatched: string[];
  lastSeen: Record<string, number>;
  stats: Record<string, { plays: number; minutes: number }>;
  slot: { tag: string; at: number } | null;
  phase: Phase;
  session: { tag: string; activityId: string; startedAt: number } | null;
  log: LogEntry[];
  /** The cartridge that was just labelled, for the one-off "sticker applied" moment. */
  fresh: string | null;
  lastEject: { tag: string; activityId: string | null; minutes: number; at: number } | null;
}

let logId = 0;
const entry = (kind: LogKind, tag: string, at: number, extra: Partial<LogEntry> = {}): LogEntry => ({
  id: ++logId,
  kind,
  tag,
  at,
  ...extra,
});

export function initialState(now = Date.now()): PlayerState {
  const mappings: Record<string, string> = {};
  const lastSeen: Record<string, number> = {};
  const stats: Record<string, { plays: number; minutes: number }> = {};
  for (const c of LIBRARY) {
    mappings[c.tag] = c.activityId;
    if (c.lastSeenAgo != null) lastSeen[c.tag] = now - c.lastSeenAgo;
    stats[c.tag] = { plays: c.plays, minutes: c.minutes };
  }
  const startedAt = now - INITIAL_SLOT.startedAgo;
  const H = 3_600_000;
  return {
    mappings,
    unmatched: [],
    lastSeen,
    stats,
    slot: { tag: INITIAL_SLOT.tag, at: startedAt },
    phase: "playing",
    session: { tag: INITIAL_SLOT.tag, activityId: mappings[INITIAL_SLOT.tag], startedAt },
    log: [
      entry("insert", INITIAL_SLOT.tag, startedAt, { activityId: "deep-work" }),
      entry("eject", "04:C4:58:2E:61:0B:80", now - 5.1 * H, { activityId: "gym", minutes: 54 }),
      entry("insert", "04:C4:58:2E:61:0B:80", now - 6 * H, { activityId: "gym" }),
      entry("eject", "04:19:E6:52:33:71:80", now - 26 * H, { activityId: "guitar", minutes: 38 }),
      entry("label", "04:3D:91:A7:15:E8:80", now - 16 * 24 * H, { activityId: "spanish" }),
    ],
    fresh: null,
    lastEject: null,
  };
}

type Action =
  | { type: "insert"; tag: string; now: number }
  | { type: "resolve"; now: number }
  | { type: "eject"; now: number }
  | { type: "label"; tag: string; activityId: string; now: number }
  | { type: "relabel"; tag: string; activityId: string; now: number }
  | { type: "forget"; tag: string; now: number }
  | { type: "start"; now: number }
  | { type: "park" }
  | { type: "clear-fresh" }
  | { type: "reset"; now: number };

const push = (log: LogEntry[], e: LogEntry) => [e, ...log].slice(0, 30);

function reducer(s: PlayerState, a: Action): PlayerState {
  switch (a.type) {
    case "insert": {
      if (s.slot) return s;
      const known = a.tag in s.mappings;
      return {
        ...s,
        slot: { tag: a.tag, at: a.now },
        phase: "reading",
        lastSeen: { ...s.lastSeen, [a.tag]: a.now },
        log: push(s.log, entry(known ? "insert" : "new", a.tag, a.now, { activityId: s.mappings[a.tag] ?? null })),
        lastEject: null,
      };
    }
    case "resolve": {
      if (!s.slot || s.phase !== "reading") return s;
      const { tag } = s.slot;
      const activityId = s.mappings[tag];
      if (!activityId) {
        return { ...s, phase: "unknown", unmatched: s.unmatched.includes(tag) ? s.unmatched : [...s.unmatched, tag] };
      }
      if (!activityById(activityId)) return { ...s, phase: "orphan" };
      const stat = s.stats[tag] ?? { plays: 0, minutes: 0 };
      return {
        ...s,
        phase: "playing",
        session: { tag, activityId, startedAt: a.now },
        stats: { ...s.stats, [tag]: { ...stat, plays: stat.plays + 1 } },
      };
    }
    case "eject": {
      if (!s.slot) return s;
      const { tag } = s.slot;
      const minutes = s.session ? Math.max(1, Math.round((a.now - s.session.startedAt) / 60_000)) : 0;
      const stat = s.stats[tag] ?? { plays: 0, minutes: 0 };
      return {
        ...s,
        slot: null,
        phase: "empty",
        session: null,
        // Main drops an unlabelled tag from `unmatchedTags` when it's removed.
        unmatched: s.unmatched.filter((t) => t !== tag),
        lastSeen: { ...s.lastSeen, [tag]: a.now },
        stats: s.session ? { ...s.stats, [tag]: { ...stat, minutes: stat.minutes + minutes } } : s.stats,
        log: push(s.log, entry("eject", tag, a.now, { activityId: s.session?.activityId ?? s.mappings[tag] ?? null, minutes })),
        lastEject: s.session ? { tag, activityId: s.session.activityId, minutes, at: a.now } : null,
      };
    }
    case "label": {
      const inSlot = s.slot?.tag === a.tag;
      return {
        ...s,
        mappings: { ...s.mappings, [a.tag]: a.activityId },
        unmatched: s.unmatched.filter((t) => t !== a.tag),
        stats: { ...s.stats, [a.tag]: s.stats[a.tag] ?? { plays: 0, minutes: 0 } },
        phase: inSlot ? "ready" : s.phase,
        log: push(s.log, entry("label", a.tag, a.now, { activityId: a.activityId })),
        fresh: a.tag,
      };
    }
    case "relabel": {
      const inSlot = s.slot?.tag === a.tag;
      return {
        ...s,
        mappings: { ...s.mappings, [a.tag]: a.activityId },
        phase: inSlot && s.phase === "orphan" ? "ready" : s.phase,
        log: push(s.log, entry("relabel", a.tag, a.now, { activityId: a.activityId })),
        fresh: a.tag,
      };
    }
    case "forget": {
      if (s.slot?.tag === a.tag) return s;
      const mappings = { ...s.mappings };
      delete mappings[a.tag];
      return { ...s, mappings, log: push(s.log, entry("forget", a.tag, a.now, { activityId: s.mappings[a.tag] })) };
    }
    case "start": {
      if (!s.slot) return s;
      const activityId = s.mappings[s.slot.tag];
      if (!activityId || !activityById(activityId)) return s;
      const stat = s.stats[s.slot.tag] ?? { plays: 0, minutes: 0 };
      return {
        ...s,
        phase: "playing",
        session: { tag: s.slot.tag, activityId, startedAt: a.now },
        stats: { ...s.stats, [s.slot.tag]: { ...stat, plays: stat.plays + 1 } },
        log: push(s.log, entry("start", s.slot.tag, a.now, { activityId })),
      };
    }
    case "park":
      return s.phase === "ready" ? { ...s, phase: "parked" } : s;
    case "clear-fresh":
      return { ...s, fresh: null };
    case "reset":
      return initialState(a.now);
  }
}

/** How long the UI waits between a tag's `lastSeen` changing and the session (or unmatched tag) arriving. */
export const READ_DELAY = 750;

export type SimEvent = { action: "insert"; tag: string } | { action: "eject" } | { action: "reset" };

export const SIM_EVENT = "player-sim";

export function sendSim(event: SimEvent) {
  window.dispatchEvent(new CustomEvent<SimEvent>(SIM_EVENT, { detail: event }));
}

/** The player and the plugin, simulated: views render from this exactly as they would from storage and sessions. */
export function usePlayer() {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState());
  const timers = useRef<number[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const insert = useCallback((tag: string) => {
    const go = () => {
      dispatch({ type: "insert", tag, now: Date.now() });
      later(() => dispatch({ type: "resolve", now: Date.now() }), READ_DELAY);
    };
    // One slot: swapping cartridges is an eject followed by an insert.
    if (stateRef.current.slot) {
      dispatch({ type: "eject", now: Date.now() });
      later(go, 700);
    } else go();
  }, []);

  const eject = useCallback(() => dispatch({ type: "eject", now: Date.now() }), []);

  useEffect(() => {
    const onSim = (e: Event) => {
      const detail = (e as CustomEvent<SimEvent>).detail;
      if (detail.action === "insert") insert(detail.tag);
      else if (detail.action === "eject") eject();
      else if (detail.action === "reset") {
        timers.current.forEach(clearTimeout);
        timers.current = [];
        dispatch({ type: "reset", now: Date.now() });
      }
    };
    window.addEventListener(SIM_EVENT, onSim);
    return () => {
      window.removeEventListener(SIM_EVENT, onSim);
      timers.current.forEach(clearTimeout);
    };
  }, [insert, eject]);

  // The "sticker applied" moment plays once.
  useEffect(() => {
    if (!state.fresh) return;
    const t = window.setTimeout(() => dispatch({ type: "clear-fresh" }), 2200);
    return () => clearTimeout(t);
  }, [state.fresh]);

  return {
    state,
    insert,
    eject,
    label: (tag: string, activityId: string) => dispatch({ type: "label", tag, activityId, now: Date.now() }),
    relabel: (tag: string, activityId: string) => dispatch({ type: "relabel", tag, activityId, now: Date.now() }),
    forget: (tag: string) => dispatch({ type: "forget", tag, now: Date.now() }),
    start: () => dispatch({ type: "start", now: Date.now() }),
    park: () => dispatch({ type: "park" }),
  };
}

export type Player = ReturnType<typeof usePlayer>;

export interface LibraryItem {
  tag: string;
  activity: FxActivity | null;
  /** Mapped to an activity that no longer exists. */
  missing: boolean;
  lastSeen: number | null;
  plays: number;
  minutes: number;
  inSlot: boolean;
  live: boolean;
}

export type SortKey = "recent" | "played" | "name";

export function library(s: PlayerState, sort: SortKey = "recent"): LibraryItem[] {
  const items = Object.entries(s.mappings).map(([tag, activityId]): LibraryItem => {
    const activity = activityById(activityId);
    return {
      tag,
      activity,
      missing: !activity,
      lastSeen: s.lastSeen[tag] ?? null,
      plays: s.stats[tag]?.plays ?? 0,
      minutes: s.stats[tag]?.minutes ?? 0,
      inSlot: s.slot?.tag === tag,
      live: s.session?.tag === tag,
    };
  });
  const byRecent = (a: LibraryItem, b: LibraryItem) => (b.lastSeen ?? -1) - (a.lastSeen ?? -1);
  if (sort === "played") return items.sort((a, b) => b.minutes - a.minutes || byRecent(a, b));
  if (sort === "name")
    return items.sort((a, b) => (a.activity?.name ?? "~").localeCompare(b.activity?.name ?? "~"));
  return items.sort(byRecent);
}

/** The player has no heartbeat; the last tag event is the best signal that it's alive. */
export function lastHeard(s: PlayerState): number | null {
  const times = Object.values(s.lastSeen);
  return times.length ? Math.max(...times) : null;
}

/** Activities that don't have a cartridge yet: good suggestions for a blank one. */
export function unlabelledActivities(s: PlayerState): FxActivity[] {
  const used = new Set(Object.values(s.mappings));
  return ACTIVITIES.filter((a) => !used.has(a.id));
}

export const isBlank = (tag: string) => BLANK_TAGS.includes(tag);
