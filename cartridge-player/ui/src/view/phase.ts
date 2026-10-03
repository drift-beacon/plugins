/**
 * What the stage shows: one phase, derived from what main wrote (the active device's slot, history), the workspace
 * (live sessions, activities) and three things only this open copy knows (the reading beat, "Later", and that it just
 * labelled the cartridge). Each phase carries exactly what it needs, so the view never asserts a field exists.
 *
 * The rules mirror main's (DESIGN.md "The slot state machine"): a slot is playing only while the session it started
 * or adopted is live, and then its activity is that session's, so relabelling a playing cartridge doesn't rename the
 * session on screen. A cartridge that isn't playing shows today's label, because that is what `start` starts: the
 * slot's own `activityId` only stands in while a copy is a push behind on the mapping.
 */
import { activeDevice, mappedActivity, type DeviceRecord, type HistoryEntry, type PlayerRecord, type Slot, type TagMappings } from "../../../shared/storage.ts";
import type { Tag } from "../../../shared/tags.ts";
import { durationPhrase, epoch } from "./format.ts";
import type { ActivityLookup, ActivityView, LiveSession } from "./types.ts";

/** The reading beat lasts at least this long, so the insert reads as "it's thinking" even when main is instant. */
export const READING_MIN_MS = 750;
/**
 * A beat whose outcome never arrives (main failed to write) gives up after this. It outlasts the 10 s the host gives
 * a session action, plus the storage write that follows: main posts `reading`, awaits the action and only then writes
 * the outcome, so a start that is slow or times out must not drop back to the slot as it was before the insert.
 */
export const READING_MAX_MS = 12_000;
/**
 * How long the stage keeps showing `playing` once the slot's session has ended. An eject reaches an open copy as two
 * pushes (main ends the session, then writes the emptied slot), and between them the slot looks like one whose
 * session was ended elsewhere. Main holds its published `slot` across the same gap.
 */
export const ENDING_HOLD_MS = 400;
/** The "Saved: 52m of Deep work" moment after an eject. */
export const SAVED_MS = 90_000;

/** main's `reading` message, as this copy received it. */
export interface ReadingBeat {
  readonly tag: Tag;
  readonly deviceId: string;
  /** When this copy heard it (this browser's clock). */
  readonly at: number;
  /**
   * The history id this insert's entry gets (main says it; a main that doesn't is read as the record's `nextId` when
   * the message arrived). The beat ends once that entry is in storage. It isn't tied to the slot's contents: an empty
   * slot looks the same before the cartridge went in and after it came out again.
   */
  readonly entry: number;
}

export interface SavedMoment {
  readonly activity: ActivityView;
  readonly durationMs: number;
  readonly at: number;
}

/** Why a labelled cartridge sits in the slot with nothing tracking. */
export type ReadyReason = "labelled" | "ended" | "idle";

export type StagePhase =
  | { readonly kind: "empty"; readonly saved: SavedMoment | null }
  | { readonly kind: "reading"; readonly tag: Tag }
  | { readonly kind: "playing"; readonly tag: Tag; readonly activity: ActivityView; readonly startedAt: number }
  | { readonly kind: "marked"; readonly tag: Tag; readonly activity: ActivityView; readonly at: number }
  | { readonly kind: "unknown"; readonly tag: Tag }
  | { readonly kind: "ready"; readonly tag: Tag; readonly activity: ActivityView; readonly reason: ReadyReason }
  | {
      readonly kind: "parked";
      readonly tag: Tag;
      readonly activity: ActivityView;
      /** Main's reason when the start it parked had failed: a retry that fails the same way is told apart by it. */
      readonly error: string | null;
    }
  | { readonly kind: "orphan"; readonly tag: Tag }
  | { readonly kind: "archived"; readonly tag: Tag; readonly activity: ActivityView }
  | { readonly kind: "error"; readonly tag: Tag; readonly activity: ActivityView | null; readonly message: string };

export type PhaseKind = StagePhase["kind"];

export interface StageInput {
  readonly record: PlayerRecord;
  readonly mappings: TagMappings;
  readonly activities: ActivityLookup;
  readonly live: readonly LiveSession[];
  readonly reading: ReadingBeat | null;
  /** The slot (`slotKey`) this copy said "Later" to. */
  readonly parked: string | null;
  /** The slot (`slotKey`) this copy just labelled. */
  readonly labelled: string | null;
  readonly now: number;
}

export interface Stage {
  readonly phase: StagePhase;
  /** The device the stage shows, for `start`. */
  readonly device: DeviceRecord | null;
  /** The slot behind the phase (`slotKey`), for "Later" and "just labelled". */
  readonly slotKey: string | null;
}

/** One stay of one cartridge in a slot: the same tag put in again is a new key. */
export function slotKey(slot: Slot | null | undefined): string | null {
  return slot ? `${slot.tag}@${slot.since}` : null;
}

/** Whether main has written what became of the beat's cartridge: its `insert` (labelled) or `new` (blank) entry. */
export function beatResolved(beat: ReadingBeat, history: readonly HistoryEntry[]): boolean {
  // Newest first, ids increasing: nothing older than the beat's own entry can be its outcome.
  for (const entry of history) {
    if (entry.id < beat.entry) return false;
    if ((entry.kind === "insert" || entry.kind === "new") && entry.tag === beat.tag && entry.deviceId === beat.deviceId) return true;
  }
  return false;
}

/**
 * Whether the reading beat still shows: for its minimum, then until main has written the insert's outcome, never past
 * its maximum. Once the outcome is written the beat is over for good, whatever happens to the slot afterwards, so a
 * cartridge pulled straight out again doesn't bring it back.
 */
export function readingShows(beat: ReadingBeat | null, record: PlayerRecord, now: number): boolean {
  if (!beat) return false;
  const age = now - beat.at;
  if (age >= READING_MAX_MS) return false;
  if (age < READING_MIN_MS) return true;
  return !beatResolved(beat, record.history);
}

/** The latest eject on `deviceId`, if it saved time within SAVED_MS and nothing went in since. */
export function savedMoment(
  history: readonly HistoryEntry[],
  deviceId: string | null,
  activities: ActivityLookup,
  now: number,
): SavedMoment | null {
  const last = history.find(
    (entry) => (entry.kind === "eject" || entry.kind === "insert") && (deviceId === null || entry.deviceId === deviceId),
  );
  if (!last || last.kind !== "eject" || !last.durationMs || !last.activityId) return null;
  const at = epoch(last.at);
  const activity = activities.get(last.activityId);
  if (at === null || !activity || now - at > SAVED_MS) return null;
  return { activity, durationMs: last.durationMs, at };
}

/** What the stage shows now. */
export function deriveStage(input: StageInput): Stage {
  const { record, now } = input;
  const device = activeDevice(record);
  const slot = device?.slot ?? null;
  const key = slotKey(slot);

  if (input.reading && readingShows(input.reading, record, now)) {
    const beatDevice = Object.hasOwn(record.devices, input.reading.deviceId) ? record.devices[input.reading.deviceId] : device;
    return { phase: { kind: "reading", tag: input.reading.tag }, device: beatDevice, slotKey: null };
  }
  if (!slot) {
    return { phase: { kind: "empty", saved: savedMoment(record.history, device?.id ?? null, input.activities, now) }, device, slotKey: null };
  }
  return { phase: slotPhase(slot, input, key), device, slotKey: key };
}

function slotPhase(slot: Slot, input: StageInput, key: string | null): StagePhase {
  const { tag } = slot;
  const session = slot.sessionId ? input.live.find((live) => live.id === slot.sessionId) : undefined;
  if (session) {
    const activity = input.activities.get(session.activityId) ?? input.activities.get(slot.activityId ?? "");
    if (activity) return { kind: "playing", tag, activity, startedAt: session.startedAt };
  }
  // Not playing: what Start would start is today's label (main's `start` resolves the mapping), so that is what the
  // stage offers. The two differ after a relabel while playing, which leaves the slot as it was.
  const mapped = mappedActivity(input.mappings, tag);
  const activityId = mapped ?? slot.activityId;
  if (!activityId) return { kind: "unknown", tag };
  const activity = input.activities.get(activityId);
  if (!activity) return { kind: "orphan", tag };
  // The slot's outcome is about the activity it went in as; a different label since has had no start, mark or end.
  const relabelled = mapped !== null && mapped !== slot.activityId;
  const parked = input.parked !== null && input.parked === key;
  if (slot.outcome === "error" && !relabelled) {
    return parked
      ? { kind: "parked", tag, activity, error: slot.error }
      : { kind: "error", tag, activity, message: slot.error ?? "Starting it failed." };
  }
  if (activity.archived) return { kind: "archived", tag, activity };
  if (slot.outcome === "marked" && !relabelled) {
    return { kind: "marked", tag, activity, at: markedAt(slot, input.record.history) ?? input.now };
  }
  if (parked) return { kind: "parked", tag, activity, error: null };
  const reason: ReadyReason =
    input.labelled !== null && input.labelled === key
      ? "labelled"
      : !relabelled && (slot.outcome === "started" || slot.outcome === "resumed")
        ? "ended"
        : "idle";
  return { kind: "ready", tag, activity, reason };
}

/**
 * When the slot's point was marked: the history entry that carries its session (the insert that marked it, or a
 * later Start from the interface). `slot.since` is when the cartridge went in, which is only the same moment when
 * the insert did the marking; it stands in once the entry has been trimmed from history.
 */
function markedAt(slot: Slot, history: readonly HistoryEntry[]): number | null {
  const entry = slot.sessionId
    ? history.find((item) => item.sessionId === slot.sessionId && item.tag === slot.tag && (item.kind === "start" || item.kind === "insert"))
    : undefined;
  return epoch(entry?.at) ?? epoch(slot.since);
}

/**
 * Whether `next` is `shown`'s session having just stopped with its cartridge still in the slot: what an eject looks
 * like between main's two pushes, and what a session ended in the app looks like for good. Usually `next` is `ready`
 * with reason `ended`; a cartridge relabelled while it played, or whose activity was archived or deleted meanwhile,
 * reads `ready` (idle), `archived` or `orphan` in the same gap, so any phase of the same stay counts.
 */
export function endingOf(shown: Stage, next: Stage): boolean {
  return shown.phase.kind === "playing" && next.phase.kind !== "playing" && shown.slotKey !== null && shown.slotKey === next.slotKey;
}

/** The stage on screen: `stage`, and since when it has been held past what the data says (null: it is the data's). */
export interface ShownStage {
  readonly stage: Stage;
  readonly heldSince: number | null;
}

/**
 * What the stage shows given what it showed and what the data says now. A playing stage whose session just stopped is
 * held for ENDING_HOLD_MS, so an eject goes from playing straight to the empty slot and "Session ended" is said only
 * if the cartridge is still there after the hold. Anything else shows at once. Returns `shown` itself when nothing
 * changes.
 */
export function holdStage(shown: ShownStage, derived: Stage, now: number): ShownStage {
  if (endingOf(shown.stage, derived)) {
    const heldSince = shown.heldSince ?? now;
    if (now - heldSince < ENDING_HOLD_MS) return shown.heldSince === heldSince ? shown : { stage: shown.stage, heldSince };
  }
  return shown.stage === derived && shown.heldSince === null ? shown : { stage: derived, heldSince: null };
}

/** The tag the stage's cartridge shows, or null for an empty slot. */
export function phaseTag(phase: StagePhase): Tag | null {
  return phase.kind === "empty" ? null : phase.tag;
}

/** What the cartridge's label shows: an activity's sticker, a blank label, or a deleted activity. */
export type CartridgeLook =
  | { readonly kind: "blank" }
  | { readonly kind: "orphan" }
  | { readonly kind: "activity"; readonly activity: ActivityView };

/**
 * The label on cartridge `tag`. While the phase is about it, the phase decides (a playing cartridge shows the
 * activity it started, even if relabelled since; one that isn't playing shows its label, as the shelf does);
 * otherwise, as while it's being read, its mapping does.
 */
export function cartridgeLook(tag: Tag, phase: StagePhase, mappings: TagMappings, activities: ActivityLookup): CartridgeLook {
  if (phase.kind !== "empty" && phase.kind !== "reading" && phase.tag === tag) {
    if (phase.kind === "unknown") return { kind: "blank" };
    if (phase.kind === "orphan") return { kind: "orphan" };
    if (phase.activity) return { kind: "activity", activity: phase.activity };
  }
  const activityId = mappedActivity(mappings, tag);
  if (!activityId) return { kind: "blank" };
  const activity = activities.get(activityId);
  return activity ? { kind: "activity", activity } : { kind: "orphan" };
}

/** Changes when what the status panel says changes: its key for swapping one body for the next. */
export function phaseKey(phase: StagePhase): string {
  if (phase.kind === "empty") return phase.saved ? `empty-saved-${phase.saved.at}` : "empty";
  return `${phase.kind}-${phase.tag}`;
}

/** The phase in one sentence, for the live region: said once per change, never with the ticking clock. */
export function phaseSentence(phase: StagePhase): string {
  switch (phase.kind) {
    case "empty":
      return phase.saved
        ? `Saved ${durationPhrase(phase.saved.durationMs).toLowerCase()} of ${phase.saved.activity.name}. The slot is empty.`
        : "The slot is empty.";
    case "reading":
      return "Reading a cartridge.";
    case "playing":
      return `${phase.activity.name} is tracking.`;
    case "marked":
      return `Marked ${phase.activity.name}.`;
    case "unknown":
      return "A new cartridge is in the player. It needs a label.";
    case "ready":
      return phase.reason === "labelled"
        ? `Labelled ${phase.activity.name}. It's still in the player and isn't tracking yet.`
        : `${phase.activity.name} is in the player, not tracking.`;
    case "parked":
      return `${phase.activity.name} is in the player, not tracking.`;
    case "orphan":
      return "This cartridge's activity was deleted. Relabel it to use it.";
    case "archived":
      return `${phase.activity.name} is archived, so nothing started. Relabel the cartridge or restore the activity.`;
    case "error":
      return `Couldn't start ${phase.activity?.name ?? "the activity"}: ${phase.message}`;
  }
}

/** The next time the stage changes by the clock alone (the beat ending, the Saved moment fading), or null. */
export function nextChange(input: StageInput, stage: Stage): number | null {
  const times: number[] = [];
  if (input.reading) {
    const { at } = input.reading;
    times.push(at + READING_MIN_MS, at + READING_MAX_MS);
  }
  if (stage.phase.kind === "empty" && stage.phase.saved) times.push(stage.phase.saved.at + SAVED_MS + 1);
  const future = times.filter((t) => t > input.now);
  return future.length ? Math.min(...future) : null;
}
