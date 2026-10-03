/**
 * The slot state machine's decisions, as pure functions over plain values and the workspace's models: how a report
 * relates to the last one applied, what a cartridge resolves to when it goes in, how long its session ran while it
 * was in, and what the slot and the player look like from outside. player.ts runs them and performs the actions they
 * name; the tests reach them through the real plugin.
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
export type SessionView = Pick<Session, "id" | "exists" | "isLive" | "isMine" | "isSpan" | "startedAt" | "endedAt">;

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
  | { readonly kind: "mark"; readonly activity: ActivityView }
  | { readonly kind: "adopt"; readonly activity: ActivityView; readonly sessionId: string }
  | { readonly kind: "start"; readonly activity: ActivityView };

/**
 * Not labelled → unknown; activity gone → orphan; archived → archived (nothing starts); a point activity → mark it; a
 * span already live for this user → adopt that session (never start a second); otherwise start it.
 */
export function resolveCartridge(activityId: string | null, lookup: Lookup): Resolution {
  if (activityId === null) return { kind: "unknown" };
  const activity = lookup.activity(activityId);
  if (!activity?.exists) return { kind: "orphan", activityId };
  if (activity.archived) return { kind: "archived", activityId };
  if (activity.isPoint) return { kind: "mark", activity };
  const live = activity.live({ mine: true })[0];
  return live ? { kind: "adopt", activity, sessionId: live.id } : { kind: "start", activity };
}

/** A session taking the cartridge out may end: this user's, live, and a span. */
export function isOwnLiveSpan(session: SessionView | undefined): session is SessionView {
  return session !== undefined && session.exists && session.isLive && session.isMine && session.isSpan;
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
