// Prototype-only: a PlayerModel over local state that behaves like main (DESIGN.md "The slot state machine") with
// realistic delays, so the harness renders the production App. It answers the private channel's requests as main
// would, refusals included, and the SimPanel drives the "hardware" and the workspace through window events. It is a
// second implementation of main's rules, kept in step by hand: each function below names the one in main/src
// (player.ts, policy.ts, record.ts) it stands in for.
import { PluginError } from "@drift-beacon/plugin/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PresenceState } from "../../../shared/state.ts";
import { type CartridgeStats, LIMITS, type HistoryEntry, NO_STATS, type PlayerRecord, type Slot } from "../../../shared/storage.ts";
import { type LabelResult, SAVE_REFUSED, type StartResult } from "../../../shared/ui-channel.ts";
import type { PlayerModel } from "../model.ts";
import type { MainStatus } from "../view/main-status.ts";
import { beatResolved, type ReadingBeat } from "../view/phase.ts";
import { type ActivityView, byId, type LiveSession } from "../view/types.ts";
import { ACTIVITIES, API_PATH, BLANK_TAGS, CATEGORIES, DEVICE, KNOWN_TAGS, simStart, type StartState } from "./sim-fixtures.ts";

/** How long main takes to resolve a cartridge after posting `reading`. */
const RESOLVE_MS = 450;
/** A request's round trip. */
const REQUEST_MS = 350;
/** Eject, then insert: a hand swapping cartridges. */
const SWAP_GAP_MS = 700;
/**
 * How long a freshly started main waits to hear from a stored player: its next heartbeat when it's on, and main's
 * OFFLINE_AFTER_MS when it isn't. Both shortened to one wait here, long enough to read the pill.
 */
const HEARD_AFTER_MS = 6000;

export type SimEvent =
  | { readonly type: "insert"; readonly tag?: string }
  | { readonly type: "blank" }
  | { readonly type: "eject" }
  | { readonly type: "swap" }
  | { readonly type: "report" }
  | { readonly type: "end-elsewhere" }
  | { readonly type: "start-elsewhere" }
  | { readonly type: "delete-activity" }
  | { readonly type: "archive-activity" }
  | { readonly type: "offline" }
  | { readonly type: "main" }
  | { readonly type: "fail-next" }
  | { readonly type: "fail-save" }
  | { readonly type: "fail-start" }
  | { readonly type: "late-beat" }
  | { readonly type: "reset" };

const EVENT = "cartridge-sim";
const STATE_EVENT = "cartridge-sim-state";

/** Sends an event to the mounted simulator. */
export function sendSim(event: SimEvent): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: event }));
}

/** What the panel shows about the simulator. */
export interface SimReadout {
  readonly slot: string | null;
  readonly online: boolean;
  readonly waiting: boolean;
  readonly mainRunning: boolean;
  readonly failNext: boolean;
  readonly failSave: boolean;
  readonly failStart: boolean;
  readonly lateBeat: boolean;
}

/** Listens for the simulator's readout. */
export function onSimState(listener: (readout: SimReadout) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<SimReadout>).detail);
  window.addEventListener(STATE_EVENT, handler);
  return () => window.removeEventListener(STATE_EVENT, handler);
}

/** A span session that is over: main still counts the time it ran while its cartridge was in. */
interface EndedSession {
  readonly startedAt: number;
  readonly endedAt: number;
}

interface Sim {
  readonly activities: ActivityView[];
  readonly mappings: Record<string, string>;
  readonly record: PlayerRecord;
  readonly live: LiveSession[];
  readonly ended: Readonly<Record<string, EndedSession>>;
  readonly online: boolean;
  /**
   * Main has started and hasn't heard the player yet (main/src/presence.ts `expect`): published `online` is null
   * until the player reports or main's wait runs out.
   */
  readonly waiting: boolean;
  readonly mainStatus: MainStatus;
  readonly reading: ReadingBeat | null;
  /** The next request to main times out (the platform's failure: main never answers). */
  readonly failNext: boolean;
  /** Storage refuses the next label, forget or dismiss (main's `confirmed`): it rejects, and nothing is saved. */
  readonly failSave: boolean;
  /** The next session action rejects (main's failure: it writes the slot as `error` with the action's message). */
  readonly failStart: boolean;
  /** The `reading` message arrives after the outcome it announces, as it can when the two race. */
  readonly lateBeat: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();
let sessionCounter = 100;

/** What the app says when it refuses an action, as main records it on the slot and rethrows it. */
const ACTION_ERROR = new PluginError("unavailable", "Drift Beacon is restarting");
/** main/src/player.ts `STARTED`. */
const STARTED: readonly Slot["outcome"][] = ["started", "resumed", "marked"];

function initial(start: StartState): Sim {
  const s = simStart(start);
  return {
    activities: ACTIVITIES,
    mappings: s.mappings,
    record: s.record,
    live: s.live,
    ended: {},
    online: true,
    waiting: false,
    mainStatus: "running",
    reading: null,
    failNext: false,
    failSave: false,
    failStart: false,
    lateBeat: false,
  };
}

/** main/src/presence.ts `online`: null for a player main is still waiting to hear from. */
const onlineOf = (sim: Sim): boolean | null => (sim.waiting ? null : sim.online);
const slotOf = (sim: Sim): Slot | null => sim.record.devices[DEVICE.id]?.slot ?? null;

function withDevice(sim: Sim, patch: { slot?: Slot | null }, now: number): PlayerRecord {
  const { id } = DEVICE;
  const current = sim.record.devices[id];
  const device = {
    id,
    name: DEVICE.name,
    fw: DEVICE.fw,
    boot: current?.boot ?? 1234,
    seq: (current?.seq ?? 0) + 1,
    slot: current?.slot ?? null,
    hubHost: DEVICE.hubHost,
    ...patch,
    lastHeardAt: iso(now),
  };
  return { ...sim.record, devices: { ...sim.record.devices, [id]: device }, active: id };
}

function withHistory(record: PlayerRecord, entry: Omit<HistoryEntry, "id" | "at">, now: number): PlayerRecord {
  const full: HistoryEntry = { ...entry, id: record.nextId, at: iso(now) };
  return { ...record, history: [full, ...record.history].slice(0, LIMITS.history), nextId: record.nextId + 1 };
}

/** main/src/record.ts `withStats`: a labelled cartridge's stats, created the first time they change. */
function withStats(record: PlayerRecord, tag: string, change: (stats: CartridgeStats) => CartridgeStats): PlayerRecord {
  const stats = Object.hasOwn(record.cartridges, tag) ? record.cartridges[tag] : NO_STATS;
  return { ...record, cartridges: { ...record.cartridges, [tag]: change(stats) } };
}

const labelOf = (sim: Sim, tag: string): string | null => (Object.hasOwn(sim.mappings, tag) ? sim.mappings[tag] : null);
const isLive = (sim: Sim, sessionId: string | null) => sessionId !== null && sim.live.some((live) => live.id === sessionId);

/**
 * main/src/policy.ts `playedMs`: how long the slot's session ran while the cartridge was in, from the later of its
 * start and the insert to its end (or now). Null for no session or a point.
 */
function playedMs(sim: Sim, slot: Slot, now: number): number | null {
  if (slot.sessionId === null) return null;
  const running = sim.live.find((live) => live.id === slot.sessionId);
  const over = Object.hasOwn(sim.ended, slot.sessionId) ? sim.ended[slot.sessionId] : null;
  const startedAt = running?.startedAt ?? over?.startedAt;
  if (startedAt === undefined) return null;
  return Math.max(0, Math.round((over?.endedAt ?? now) - Math.max(startedAt, Date.parse(slot.since))));
}

/** main's `settle`: the time of a slot's session that ended elsewhere, counted before the slot moves on. */
function settle(sim: Sim, record: PlayerRecord, slot: Slot, now: number): PlayerRecord {
  const ms = playedMs(sim, slot, now);
  if (!ms || labelOf(sim, slot.tag) === null) return record;
  return withStats(record, slot.tag, (stats) => ({ ...stats, playedMs: stats.playedMs + ms }));
}

/** A live session ends at `now`: it leaves `live` and is remembered with its end. */
function endSession(sim: Sim, sessionId: string | null, now: number): Sim {
  const session = sim.live.find((live) => live.id === sessionId);
  if (!session) return sim;
  return {
    ...sim,
    live: sim.live.filter((live) => live !== session),
    ended: { ...sim.ended, [session.id]: { startedAt: session.startedAt, endedAt: now } },
  };
}

/** Main's eject: end the session the cartridge started, if live; count its time; history. */
function eject(before: Sim, now: number): Sim {
  let slot = slotOf(before);
  if (!slot) return before;
  if (slot.outcome === "error" && slot.sessionId === null && slot.activityId !== null) {
    // A start that was rejected may still have run: the activity's live session is this cartridge's to end.
    const { activityId } = slot;
    const ran = before.live.find((live) => live.activityId === activityId);
    if (ran) slot = { ...slot, sessionId: ran.id };
  }
  const sim = endSession(before, slot.sessionId, now);
  const durationMs = playedMs(sim, slot, now);
  let record = withDevice(sim, { slot: null }, now);
  record = withHistory(record, { kind: "eject", tag: slot.tag, activityId: slot.activityId, deviceId: DEVICE.id, sessionId: slot.sessionId, durationMs }, now);
  if (labelOf(sim, slot.tag) !== null) {
    record = withStats(record, slot.tag, (stats) => ({ ...stats, seenAt: iso(now), playedMs: stats.playedMs + (durationMs ?? 0) }));
  }
  return { ...sim, record };
}

interface Tracked {
  readonly sim: Sim;
  readonly sessionId: string | null;
  readonly result: StartResult["result"] | "error";
  readonly error: string | null;
}

/** Main's `perform`: mark a point, adopt a live session of the activity, or start one; a rejected action is `error`. */
function track(sim: Sim, activity: ActivityView, now: number): Tracked {
  const adopted = activity.point ? undefined : sim.live.find((live) => live.activityId === activity.id);
  if (adopted) return { sim, sessionId: adopted.id, result: "resumed", error: null };
  if (sim.failStart) return { sim: { ...sim, failStart: false }, sessionId: null, result: "error", error: ACTION_ERROR.message };
  if (activity.point) return { sim, sessionId: `s-${++sessionCounter}`, result: "marked", error: null };
  const session = { id: `s-${++sessionCounter}`, activityId: activity.id, startedAt: now };
  return { sim: { ...sim, live: [...sim.live, session] }, sessionId: session.id, result: "started", error: null };
}

/** Main resolving the cartridge that just went in. */
function resolve(sim: Sim, tag: string, now: number): Sim {
  const deviceId = DEVICE.id;
  const activityId = labelOf(sim, tag);
  const activity = activityId ? sim.activities.find((a) => a.id === activityId) : undefined;
  const slot = (outcome: Slot["outcome"], sessionId: string | null = null, error: string | null = null): Slot => ({
    tag,
    since: iso(now),
    activityId,
    sessionId,
    outcome,
    error,
  });
  if (!activityId) {
    const seen = sim.record.unknown.find((item) => item.tag === tag);
    const unknown = [
      { tag, firstSeenAt: seen?.firstSeenAt ?? iso(now), lastSeenAt: iso(now) },
      ...sim.record.unknown.filter((item) => item.tag !== tag),
    ].slice(0, LIMITS.unknown);
    let record: PlayerRecord = { ...withDevice(sim, { slot: slot("unknown") }, now), unknown };
    record = withHistory(record, { kind: "new", tag, activityId: null, deviceId, sessionId: null, durationMs: null }, now);
    return { ...sim, record };
  }
  const stamp = (record: PlayerRecord, sessionId: string | null, played: boolean) =>
    withStats(
      withHistory(record, { kind: "insert", tag, activityId, deviceId, sessionId, durationMs: null }, now),
      tag,
      (stats) => ({ ...stats, seenAt: iso(now), plays: stats.plays + (played ? 1 : 0) }),
    );
  if (!activity || activity.archived) {
    return { ...sim, record: stamp(withDevice(sim, { slot: slot(activity ? "archived" : "orphan") }, now), null, false) };
  }
  const done = track(sim, activity, now);
  const record = stamp(withDevice(done.sim, { slot: slot(done.result, done.sessionId, done.error) }, now), done.sessionId, STARTED.includes(done.result));
  return { ...done.sim, record };
}

/**
 * The simulated model. `start` picks the fixtures; the SimPanel drives it with `sendSim`. Requests take REQUEST_MS and
 * refuse like main does. "Fail next" makes one request time out (nothing changes); "Fail save" makes storage refuse
 * one label, forget or dismiss (main answers `failed`, and the same request works again); "Fail start" makes one
 * session action reject, on an insert or a Start (main writes the slot as `error`). Stopping and starting main leaves
 * a player "waiting" (published `online: null`) until it's heard again.
 */
export function useSimModel(start: StartState): PlayerModel {
  const [sim, setSim] = useState<Sim>(() => initial(start));
  const simRef = useRef(sim);
  simRef.current = sim;
  const timers = useRef<number[]>([]);
  const later = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);

  const reachable = (s: Sim) => s.online && s.mainStatus === "running";

  /** A cartridge going in: the reading beat at once, the outcome a moment later. */
  const insert = useCallback(
    (tag: string, direct = false) => {
      setSim((s) => {
        if (!reachable(s)) return s;
        const now = Date.now();
        const current = slotOf(s);
        if (current?.tag === tag) return s;
        if (current && !direct) return s;
        const emptied = eject(s, now);
        // As main names it: the history id the insert's entry will get.
        const beat: ReadingBeat = { tag, deviceId: DEVICE.id, at: now, entry: emptied.record.nextId };
        later(RESOLVE_MS, () => setSim((latest) => resolve(latest, tag, Date.now())));
        if (!s.lateBeat) return { ...emptied, waiting: false, reading: beat };
        // The message lost the race: it arrives once the outcome is already in storage, where the channel drops it
        // (main-channel.ts), so the stage never goes back to "reading" after showing what the cartridge is.
        later(RESOLVE_MS + 150, () =>
          setSim((latest) => (beatResolved(beat, latest.record.history) ? latest : { ...latest, reading: { ...beat, at: Date.now() } })),
        );
        return { ...emptied, waiting: false };
      });
    },
    [later],
  );

  const insertSoon = useCallback(
    (tag: string) => {
      if (slotOf(simRef.current)) {
        setSim((s) => (reachable(s) ? { ...eject(s, Date.now()), waiting: false } : s));
        later(SWAP_GAP_MS, () => insert(tag));
      } else insert(tag);
    },
    [insert, later],
  );

  const cursor = useRef({ known: 1, blank: 0 });
  useEffect(() => {
    const onEvent = (event: Event) => {
      const e = (event as CustomEvent<SimEvent>).detail;
      const now = Date.now();
      const s = simRef.current;
      const slot = slotOf(s);
      switch (e.type) {
        case "insert": {
          const tag = e.tag ?? KNOWN_TAGS[cursor.current.known++ % KNOWN_TAGS.length];
          insertSoon(tag);
          break;
        }
        case "blank":
          insertSoon(BLANK_TAGS[cursor.current.blank++ % BLANK_TAGS.length]);
          break;
        case "eject":
          setSim((latest) => (reachable(latest) ? { ...eject(latest, now), waiting: false } : latest));
          break;
        case "report":
          // A report that changes nothing in the slot: what a player sends when it has just been set up.
          setSim((latest) => (reachable(latest) ? { ...latest, record: withDevice(latest, {}, now), waiting: false } : latest));
          break;
        case "swap": {
          const next = KNOWN_TAGS.find((tag) => tag !== slot?.tag && s.mappings[tag] && s.activities.some((a) => a.id === s.mappings[tag] && !a.archived));
          if (next) insert(next, true);
          break;
        }
        case "end-elsewhere":
          setSim((latest) => endSession(latest, slotOf(latest)?.sessionId ?? null, now));
          break;
        case "start-elsewhere":
          setSim((latest) => ({ ...latest, live: [...latest.live, { id: `s-${++sessionCounter}`, activityId: "cook", startedAt: now }] }));
          break;
        case "delete-activity": {
          const target = (slot && labelOf(s, slot.tag)) ?? slot?.activityId ?? "deep-work";
          setSim((latest) => ({ ...latest, activities: latest.activities.filter((a) => a.id !== target) }));
          break;
        }
        case "archive-activity": {
          const target = (slot && labelOf(s, slot.tag)) ?? slot?.activityId ?? "deep-work";
          setSim((latest) => ({
            ...latest,
            activities: latest.activities.map((a) => (a.id === target ? { ...a, archived: !a.archived } : a)),
          }));
          break;
        }
        case "offline":
          setSim((latest) => ({ ...latest, online: !latest.online, record: latest.online ? latest.record : withDevice(latest, {}, now) }));
          break;
        case "main":
          // Main starting again knows its players from storage only: one is neither online nor offline until
          // its heartbeat arrives (or, for one that's off, until main stops waiting).
          setSim((latest) => {
            const starting = latest.mainStatus !== "running";
            return { ...latest, mainStatus: starting ? "running" : "unavailable", waiting: starting };
          });
          if (s.mainStatus !== "running") later(HEARD_AFTER_MS, () => setSim((latest) => ({ ...latest, waiting: false })));
          break;
        case "fail-next":
          setSim((latest) => ({ ...latest, failNext: !latest.failNext }));
          break;
        case "fail-save":
          setSim((latest) => ({ ...latest, failSave: !latest.failSave }));
          break;
        case "fail-start":
          setSim((latest) => ({ ...latest, failStart: !latest.failStart }));
          break;
        case "late-beat":
          setSim((latest) => ({ ...latest, lateBeat: !latest.lateBeat }));
          break;
        case "reset":
          timers.current.forEach((id) => window.clearTimeout(id));
          setSim(initial(start));
          break;
      }
    };
    window.addEventListener(EVENT, onEvent);
    return () => window.removeEventListener(EVENT, onEvent);
  }, [insert, insertSoon, start]);

  useEffect(() => {
    const readout: SimReadout = {
      slot: slotOf(sim)?.tag ?? null,
      online: sim.online,
      waiting: sim.waiting,
      mainRunning: sim.mainStatus === "running",
      failNext: sim.failNext,
      failSave: sim.failSave,
      failStart: sim.failStart,
      lateBeat: sim.lateBeat,
    };
    window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: readout }));
  }, [sim]);

  /** Main writing storage outside a request's answer (a failed start is written before the request rejects). */
  const commit = useCallback((next: Sim) => {
    simRef.current = next;
    setSim(next);
  }, []);

  /**
   * A request to "main": refused while it isn't running, failed once when asked to, else answered after a beat.
   * `saves` marks the ones main answers only once their storage writes landed (label, forget, dismiss).
   */
  const request = useCallback(<T,>(apply: (s: Sim, now: number) => { sim: Sim; result: T }, saves = false): Promise<T> => {
    const s = simRef.current;
    if (s.mainStatus !== "running") return Promise.reject(new PluginError("unavailable", "Cartridge Player isn't running"));
    if (s.failNext) {
      setSim((latest) => ({ ...latest, failNext: false }));
      return new Promise((_, reject) => setTimeout(() => reject(new PluginError("timeout", "Timed out")), REQUEST_MS));
    }
    if (saves && s.failSave) {
      // main's `confirmed`: the host rolled the write back, so nothing changed and the same request can be sent again.
      setSim((latest) => ({ ...latest, failSave: false }));
      return new Promise((_, reject) => setTimeout(() => reject(new PluginError("failed", SAVE_REFUSED)), REQUEST_MS));
    }
    return new Promise((resolvePromise, reject) => {
      setTimeout(() => {
        try {
          const { sim: next, result } = apply(simRef.current, Date.now());
          commit(next);
          resolvePromise(result);
        } catch (error) {
          reject(error);
        }
      }, REQUEST_MS);
    });
  }, [commit]);

  const actions = useMemo<PlayerModel["actions"]>(
    () => ({
      // main's `label`.
      label: (tag, activityId) =>
        request<LabelResult>((s, now) => {
          const activity = s.activities.find((a) => a.id === activityId);
          if (!activity) throw new PluginError("invalid", "That activity no longer exists");
          if (activity.archived) throw new PluginError("invalid", `${activity.name} is archived: pick another activity`);
          const previous = labelOf(s, tag);
          const slot = slotOf(s);
          const holder = slot?.tag === tag ? slot : null;
          let record = s.record;
          if (previous !== activityId) {
            record = withHistory(record, { kind: previous === null ? "label" : "relabel", tag, activityId, deviceId: holder ? DEVICE.id : null, sessionId: null, durationMs: null }, now);
          }
          const seen = record.unknown.find((item) => item.tag === tag)?.lastSeenAt ?? null;
          record = { ...record, unknown: record.unknown.filter((item) => item.tag !== tag) };
          record = withStats(record, tag, (stats) => (stats.seenAt === null ? { ...stats, seenAt: seen } : stats));
          const labelled: Sim = { ...s, mappings: { ...s.mappings, [tag]: activityId } };
          // A playing cartridge keeps its session; the new label applies next time it goes in.
          if (holder && !isLive(s, holder.sessionId) && (holder.activityId !== activityId || !STARTED.includes(holder.outcome))) {
            record = settle(labelled, record, holder, now);
            const idle: Slot = { ...holder, activityId, sessionId: null, outcome: "idle", error: null };
            record = { ...record, devices: { ...record.devices, [DEVICE.id]: { ...record.devices[DEVICE.id], slot: idle } } };
          }
          return { sim: { ...labelled, record }, result: { tag, activityId, previous, inSlot: holder !== null } };
        }, true),
      // main's `forget`: refused only while the cartridge is tracking or its player is online. A slot that holds it
      // on the word of a player that isn't is emptied in the same write.
      forget: (tag) =>
        request<void>((s, now) => {
          const held = slotOf(s)?.tag === tag ? slotOf(s) : null;
          if (held && (isLive(s, held.sessionId) || onlineOf(s) === true)) throw new PluginError("invalid", "Take it out of the player first");
          const previous = labelOf(s, tag);
          if (previous === null) return { sim: s, result: undefined };
          const mappings = { ...s.mappings };
          delete mappings[tag];
          const cartridges = { ...s.record.cartridges };
          delete cartridges[tag];
          const { id } = DEVICE;
          const devices = held ? { ...s.record.devices, [id]: { ...s.record.devices[id], slot: null } } : s.record.devices;
          const record = withHistory({ ...s.record, devices, cartridges }, { kind: "forget", tag, activityId: previous, deviceId: null, sessionId: null, durationMs: null }, now);
          return { sim: { ...s, mappings, record }, result: undefined };
        }, true),
      // main's `dismiss`.
      dismiss: (tag) =>
        request<void>((s, now) => {
          if (!s.record.unknown.some((item) => item.tag === tag)) return { sim: s, result: undefined };
          const record = withHistory(
            { ...s.record, unknown: s.record.unknown.filter((item) => item.tag !== tag) },
            { kind: "dismiss", tag, activityId: null, deviceId: null, sessionId: null, durationMs: null },
            now,
          );
          return { sim: { ...s, record }, result: undefined };
        }, true),
      // main's `start`: what starts is today's label, not what the cartridge went in as.
      start: () =>
        request<StartResult>((s, now) => {
          const slot = slotOf(s);
          if (!slot) throw new PluginError("not-found", "There's no cartridge in the player");
          // Already playing its own session: nothing to start and nothing written, whatever it's labelled now.
          if (isLive(s, slot.sessionId)) {
            return { sim: s, result: { activityId: slot.activityId as string, sessionId: slot.sessionId, result: "resumed" } };
          }
          const activityId = labelOf(s, slot.tag);
          if (activityId === null) throw new PluginError("not-found", "Label this cartridge first");
          const activity = s.activities.find((a) => a.id === activityId);
          if (!activity) throw new PluginError("not-found", "Its activity no longer exists: label it again");
          if (activity.archived) throw new PluginError("invalid", "Its activity is archived: label it again");
          const done = track(s, activity, now);
          const next: Slot = { ...slot, activityId, sessionId: done.sessionId, outcome: done.result, error: done.error };
          // The slot alone: a request isn't a report from the player, so "last heard" and its `seq` stay as they were.
          const { id } = DEVICE;
          const settled = settle(s, s.record, slot, now);
          let record: PlayerRecord = { ...settled, devices: { ...settled.devices, [id]: { ...settled.devices[id], slot: next } } };
          if (done.result === "error") {
            // Main commits the failed slot, then rejects with the action's own error.
            commit({ ...done.sim, record });
            throw ACTION_ERROR;
          }
          record = withStats(record, slot.tag, (stats) => ({ ...stats, plays: stats.plays + 1 }));
          record = withHistory(record, { kind: "start", tag: slot.tag, activityId, deviceId: DEVICE.id, sessionId: done.sessionId, durationMs: null }, now);
          return { sim: { ...done.sim, record }, result: { activityId, sessionId: done.sessionId, result: done.result } };
        }),
    }),
    [request, commit],
  );

  const lookup = useMemo(() => byId(sim.activities), [sim.activities]);
  const presence = useMemo<PresenceState | null>(() => {
    if (sim.mainStatus !== "running") return null;
    const device = sim.record.devices[DEVICE.id];
    if (!device) return { online: null, lastHeardAt: null, deviceId: null, name: null, firmware: null, reader: null };
    return {
      online: onlineOf(sim),
      lastHeardAt: device.lastHeardAt,
      deviceId: device.id,
      name: device.name,
      firmware: device.fw,
      reader: "ok",
    };
  }, [sim]);

  return useMemo<PlayerModel>(
    () => ({
      activities: sim.activities,
      lookup,
      categories: CATEGORIES,
      live: sim.live,
      mappings: sim.mappings,
      record: sim.record,
      presence,
      mainStatus: sim.mainStatus,
      mainStatusReason: null,
      reading: sim.reading,
      apiPath: API_PATH,
      pageHost: window.location.hostname,
      actions,
    }),
    [sim, lookup, presence, actions],
  );
}
