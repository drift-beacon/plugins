/**
 * The slot state machine's decisions, as pure functions over plain values and the workspace's models: how a report
 * relates to the last one applied, what a cartridge resolves to when it goes in, how long its session ran while it
 * was in, and what the slot and the player look like from outside. player.ts runs them and performs the actions they
 * name. tests/main.test.mjs checks them directly and through the real plugin.
 */
import type { Activity, Session } from "@drift-beacon/plugin";
import type { PlayerReport, ReportReason } from "../../shared/protocol.ts";
import type { InsertedEvent, PresenceState, SlotPhase, SlotState } from "../../shared/state.ts";
import { EMPTY_SLOT } from "../../shared/state.ts";
import type { DeviceRecord, Slot } from "../../shared/storage.ts";
import type { Tag } from "../../shared/tags.ts";

/** The parts of an activity the decisions read, and the two actions a resolution can name. */
export type ActivityView = Pick<
  Activity,
  "id" | "name" | "exists" | "archived" | "isPoint" | "live" | "mark" | "track"
>;
/** The parts of a session the decisions read. */
export type SessionView = Pick<
  Session,
  "id" | "exists" | "isLive" | "isSpan" | "memberIds" | "currentMemberIds" | "startedAt" | "endedAt"
>;

/** The workspace as the decisions see it: `ctx.activities.get` and `ctx.sessions.get`. */
export interface Lookup {
  activity(id: string): ActivityView | undefined;
  session(id: string): SessionView | undefined;
}

/**
 * How a report relates to the last one applied for its device: `stale` (same boot, lower seq: ignored),
 * `repeat` (same boot and seq: a retry or a heartbeat, which changes nothing while it `agrees` with the slot) or
 * `apply` (newer, or the player restarted).
 */
export type ReportOrder = "stale" | "repeat" | "apply";

export function orderReport(device: DeviceRecord | null, report: Pick<PlayerReport, "boot" | "seq">): ReportOrder {
  if (!device || device.boot === null || device.seq === null || device.boot !== report.boot) return "apply";
  if (report.seq < device.seq) return "stale";
  return report.seq === device.seq ? "repeat" : "apply";
}

/**
 * The reasons a report repeating an applied `(boot, seq)` is a retry of the report that changed the slot, whose reply
 * the player never got: it gets that reply again while main still holds it (replies are kept in memory, so not after
 * a restart), so the player plays the cue it missed. A heartbeat or a reconnect with the same seq says nothing new and
 * gets `unchanged`.
 */
const RETRY_REASONS: readonly ReportReason[] = ["change", "boot", "pair"];

export const isRetry = (reason: ReportReason): boolean => RETRY_REASONS.includes(reason);

/**
 * The tag the slot should hold after a report. A reader fault is never "out": the player keeps its last value, and
 * should a report still say empty while the reader is faulty, the slot keeps its cartridge.
 */
export function reportedTag(slot: Slot | null, report: Pick<PlayerReport, "tag" | "reader">): Tag | null {
  return report.tag === null && report.reader === "fault" ? (slot?.tag ?? null) : report.tag;
}

/**
 * Whether a report says what main already holds for its device: the `(boot, seq)` it applied last, and the same slot.
 * One `(boot, seq)` never carries two tags (the player counts every slot change), so a report that repeats them and
 * disagrees about the slot means main fell out of step: a restart between a swap's eject and its insert, a storage
 * write the host rolled back, a reader that was dead when the report was first sent. Such a report is applied like a
 * new one, which is how the next heartbeat heals what the last report couldn't. (player.ts makes one exception: an
 * insert whose write was rolled back is written back as it was resolved, not resolved again.)
 *
 * Only a slot that was read (`reader: "ok"`) is trusted over what main holds. A faulty reader repeats the last value
 * it read, which under an applied `(boot, seq)` says nothing new, and its cartridge may since have been read in
 * another player's slot: taken at its word, the blind player would take the cartridge back at every heartbeat. So a
 * fault report under the applied `(boot, seq)` agrees whatever tag it carries, and what main missed is put right once
 * the reader reads the slot again.
 */
export function agrees(
  device: DeviceRecord | null,
  report: Pick<PlayerReport, "boot" | "seq" | "tag" | "reader">,
): boolean {
  if (device === null || device.boot !== report.boot || device.seq !== report.seq) return false;
  return report.reader === "fault" || report.tag === (device.slot?.tag ?? null);
}

/** What a cartridge going in resolves to, before any action runs. */
export type Resolution =
  | { readonly kind: "unknown" }
  | { readonly kind: "orphan"; readonly activityId: string }
  | { readonly kind: "archived"; readonly activityId: string }
  | { readonly kind: "nobody"; readonly activity: ActivityView }
  | { readonly kind: "mark"; readonly activity: ActivityView; readonly members: readonly string[] }
  | { readonly kind: "adopt"; readonly activity: ActivityView; readonly sessionId: string }
  | { readonly kind: "start"; readonly activity: ActivityView; readonly members: readonly string[] };

/**
 * Not labelled → unknown; activity gone → orphan; archived → archived (nothing starts); nobody to name (`members` is
 * empty: the workspace's members aren't known) → nobody, and nothing is marked, started or taken over; a point
 * activity → mark it for `members`; a span every one of `members` is in → adopt that session (never start a second);
 * otherwise start it for `members`. `members` is the cartridge's, from `actingFor`. A span only some of them are in,
 * or nobody, is never adopted: the cartridge starts one for all of them, and ejecting it later can't end a session
 * they weren't all in.
 */
export function resolveCartridge(activityId: string | null, lookup: Lookup, members: readonly string[]): Resolution {
  if (activityId === null) return { kind: "unknown" };
  const activity = lookup.activity(activityId);
  if (!activity?.exists) return { kind: "orphan", activityId };
  if (activity.archived) return { kind: "archived", activityId };
  if (members.length === 0) return { kind: "nobody", activity };
  if (activity.isPoint) return { kind: "mark", activity, members };
  const live = activity.live().find((s) => members.every((id) => s.currentMemberIds.includes(id)));
  return live ? { kind: "adopt", activity, sessionId: live.id } : { kind: "start", activity, members };
}

/**
 * A session taking the cartridge out may end: live and a span. Callers pass only the slot's own session (the one its
 * cartridge started or adopted, `slotSession`), so whoever is in it now, or nobody, it is the cartridge's to end.
 */
export function isOwnLiveSpan(session: SessionView | undefined): session is SessionView {
  return session !== undefined && session.exists && session.isLive && session.isSpan;
}

/**
 * The codes of a refused action that certainly didn't run: the hub checked it and wrote nothing. Any other refusal may
 * have run: the host gives up waiting for an action after 10 s (`unavailable`), or the plugin was stopping
 * (`stopped`), and the action can still land.
 */
const DIDNT_RUN: readonly unknown[] = [
  "invalid",
  "not-found",
  "unsupported",
  "incompatible",
  "disabled",
  "not-installed",
];

/** Whether the action that rejected with `error` may still have run. */
export function mayHaveRun(error: unknown): boolean {
  const code = error instanceof Error && error.name === "PluginError" ? (error as { code?: unknown }).code : undefined;
  return !DIDNT_RUN.includes(code);
}

/**
 * Whom a refused start may still have started a session for: the members it named, when the refusal may have run
 * (`mayHaveRun`). Null when it can't have run.
 */
export function lateFor(resolution: Resolution, error: unknown): readonly string[] | null {
  return resolution.kind === "start" && resolution.members.length > 0 && mayHaveRun(error) ? resolution.members : null;
}

/**
 * The session a refused start may have left behind: the newest live span of `activity` that started at or after
 * `since`, the moment the cartridge went in, and was started for `members` (`lateFor`), whoever is in it now. A start
 * seats the members it names first, so they fill the first seats of its `memberIds` (in the order added, leavers
 * kept), in any order; anyone who joined later sits after them. Nothing else would end it. A session someone else
 * started meanwhile is never it, even one they all joined. Seats can't tell a start for all of them from a start by
 * some of them that the rest joined before anyone else did: that span is taken too. No members match nothing.
 */
export function lateSession(
  activity: ActivityView | undefined,
  since: string,
  members: readonly string[],
): string | null {
  if (members.length === 0) return null;
  const from = Date.parse(since);
  const founders = (s: SessionView) => s.memberIds.slice(0, members.length);
  const late = activity
    ?.live()
    .find((s) => s.startedAt.getTime() >= from && members.every((id) => founders(s).includes(id)));
  return late?.id ?? null;
}

/**
 * How long `session` tracked while the cartridge was in: from the later of its start and the insert to its end (or
 * `now` while it runs). Null for no session or a point. A session adopted on insert counts only from the insert.
 */
export function playedMs(slot: Slot, session: SessionView | undefined, now: number): number | null {
  if (!session?.exists || !session.isSpan) return null;
  const from = Math.max(session.startedAt.getTime(), Date.parse(slot.since));
  const to = session.endedAt?.getTime() ?? now;
  return Math.max(0, Math.round(to - from));
}

/** The slot's phase, derived from the workspace each time: whether it's playing is never stored. */
export function slotPhase(slot: Slot | null, lookup: Lookup): SlotPhase {
  if (!slot) return "empty";
  switch (slot.outcome) {
    case "unknown":
    case "orphan":
    case "archived":
    case "error":
    case "marked":
      return slot.outcome;
    case "started":
    case "resumed":
    case "idle":
      return slot.sessionId !== null && isOwnLiveSpan(lookup.session(slot.sessionId)) ? "playing" : "ready";
  }
}

/** Published `slot`: the shown device's slot. */
export function slotState(device: DeviceRecord | null, lookup: Lookup): SlotState {
  const slot = device?.slot ?? null;
  if (!device || !slot) return { ...EMPTY_SLOT, deviceId: device?.id ?? null };
  return {
    phase: slotPhase(slot, lookup),
    tag: slot.tag,
    activityId: slot.activityId,
    sessionId: slot.sessionId,
    since: slot.since,
    deviceId: device.id,
  };
}

/**
 * Published `player`. `online` comes from memory: null before any player is heard, and for a stored player main hasn't
 * heard since it started and is still waiting for.
 */
export function presenceState(
  device: DeviceRecord | null,
  heard: { readonly online: boolean | null; readonly reader: "ok" | "fault" | null },
): PresenceState {
  return {
    online: heard.online,
    lastHeardAt: device?.lastHeardAt ?? null,
    deviceId: device?.id ?? null,
    name: device?.name ?? null,
    firmware: device?.fw ?? null,
    reader: heard.reader,
  };
}

/** What an insert came to: the `inserted` event's result, and the slot's outcome of the same name. */
export type InsertResult = InsertedEvent["result"];
