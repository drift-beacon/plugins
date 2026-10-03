/**
 * The shelf: every labelled cartridge with its stats, the ones the player has seen that nobody labelled yet, and the
 * activities offered as one-tap labels. Stats are per cartridge (main counts plays and tracked time in `cartridges`),
 * so two cartridges on one activity keep their own numbers.
 */
import type { PresenceState } from "../../../shared/state.ts";
import { activeDevice, slotHolding, type PlayerRecord, type TagMappings } from "../../../shared/storage.ts";
import type { Tag } from "../../../shared/tags.ts";
import { epoch } from "./format.ts";
import type { ActivityLookup, ActivityView, LiveSession } from "./types.ts";

export interface LibraryItem {
  readonly tag: Tag;
  readonly activityId: string;
  /** Null when the activity was deleted: the cartridge needs a new label. */
  readonly activity: ActivityView | null;
  readonly plays: number;
  readonly playedMs: number;
  /** When it last went in or came out (epoch ms), or null if never since it was labelled. */
  readonly seenAt: number | null;
  /** It's in a player now. */
  readonly inSlot: boolean;
  /** It's in a player and the session it started is live. */
  readonly live: boolean;
  /**
   * The activity that live session tracks, when the app knows it. It is `activity` unless the cartridge was relabelled
   * while playing: the session it started carries on under the old activity until the cartridge comes out.
   */
  readonly tracking: ActivityView | null;
}

export interface UnknownItem {
  readonly tag: Tag;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export type SortKey = "recent" | "played" | "name";

export const SORTS: readonly { readonly value: SortKey; readonly label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "played", label: "Most played" },
  { value: "name", label: "A–Z" },
];

/** Every labelled cartridge, unsorted. */
export function buildLibrary(
  mappings: TagMappings,
  record: PlayerRecord,
  activities: ActivityLookup,
  live: readonly LiveSession[],
): LibraryItem[] {
  return Object.entries(mappings).map(([tag, activityId]) => {
    const stats = Object.hasOwn(record.cartridges, tag) ? record.cartridges[tag] : null;
    const held = slotHolding(record, tag);
    const sessionId = held?.slot.sessionId;
    const session = sessionId ? live.find((item) => item.id === sessionId) : undefined;
    return {
      tag,
      activityId,
      activity: activities.get(activityId) ?? null,
      plays: stats?.plays ?? 0,
      playedMs: stats?.playedMs ?? 0,
      seenAt: epoch(stats?.seenAt),
      inSlot: held !== null,
      live: session !== undefined,
      tracking: session ? (activities.get(session.activityId) ?? null) : null,
    };
  });
}

const nameOf = (item: LibraryItem) => item.activity?.name ?? "";

function byName(a: LibraryItem, b: LibraryItem): number {
  // A cartridge whose activity is gone has no name: it sorts last, where it reads as the odd one out.
  if (!a.activity !== !b.activity) return a.activity ? -1 : 1;
  return nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" }) || a.tag.localeCompare(b.tag);
}

function byRecent(a: LibraryItem, b: LibraryItem): number {
  if (a.inSlot !== b.inSlot) return a.inSlot ? -1 : 1;
  return (b.seenAt ?? -Infinity) - (a.seenAt ?? -Infinity) || byName(a, b);
}

/** Sorted for the shelf. Recent puts the cartridge in the player first; Most played orders by plays, then time. */
export function sortLibrary(items: readonly LibraryItem[], key: SortKey): LibraryItem[] {
  const sorted = [...items];
  if (key === "recent") return sorted.sort(byRecent);
  if (key === "played") return sorted.sort((a, b) => b.plays - a.plays || b.playedMs - a.playedMs || byName(a, b));
  return sorted.sort(byName);
}

/**
 * Cartridges seen but not labelled, newest first: not the one on the stage (it has its own prompt) and not one
 * labelled since (main drops it from the list, but a copy can be a push behind).
 */
export function unknownItems(record: PlayerRecord, mappings: TagMappings, stageTag: Tag | null): UnknownItem[] {
  return record.unknown
    .filter((item) => item.tag !== stageTag && !Object.hasOwn(mappings, item.tag))
    .map((item) => ({
      tag: item.tag,
      firstSeenAt: epoch(item.firstSeenAt) ?? 0,
      lastSeenAt: epoch(item.lastSeenAt) ?? 0,
    }));
}

/** One-tap labels for a new cartridge: activities without a cartridge yet, in the app's order. */
export function suggestions(activities: readonly ActivityView[], mappings: TagMappings, max = 6): ActivityView[] {
  const labelled = new Set(Object.values(mappings));
  return activities.filter((activity) => !activity.archived && !labelled.has(activity.id)).slice(0, max);
}

/** The shelf card's accessible name: what it is, where it is, and its numbers. */
export function itemLabel(item: LibraryItem, lastSeen: string | null, played: string): string {
  const parts = [item.activity ? item.activity.name : "Cartridge whose activity was deleted"];
  if (item.activity?.archived) parts.push("archived");
  if (!item.inSlot) parts.push(lastSeen === null ? "never played" : `last played ${lastSeen}`);
  // Relabelled while playing: the session is the old activity's, so the name alone would say the new one tracks.
  else if (item.tracking && item.tracking !== item.activity) parts.push(`in the player, tracking ${item.tracking.name}`);
  else parts.push(item.live ? "in the player, tracking" : "in the player");
  if (item.playedMs > 0) parts.push(`${played} tracked`);
  return parts.join(", ");
}

/**
 * What relabelling a cartridge does while its session runs, for its details: the session carries on until the
 * cartridge comes out, and the label applies from the next time it goes in. Null when nothing is tracking.
 */
export function trackingNote(item: LibraryItem): string | null {
  if (!item.live) return null;
  const { activity, tracking } = item;
  // Already relabelled: two activities are in play, so each is named with what happens to it.
  if (tracking && activity && tracking !== activity) {
    return `${tracking.name} keeps tracking until you take it out; ${activity.name} starts next time it goes in.`;
  }
  const name = tracking?.name ?? activity?.name;
  if (!name) return "It's in the player and tracking. A new label applies next time it goes in.";
  return `It's in the player and tracking. A new label applies next time it goes in; ${name} keeps tracking until you take it out.`;
}

/**
 * What stands between a labelled cartridge and Forget, by main's rule (main/src/player.ts `forget`): it refuses only
 * while the session the cartridge's slot started is live, or while the player holding it is online.
 * - free: no slot holds it
 * - in-player: its player is online, so taking it out is all it takes
 * - tracking: its session is live but its player isn't known to be online
 * - held: a slot holds it on the word of a player that isn't online; forgetting it empties that slot too
 */
export type ForgetState = "free" | "in-player" | "tracking" | "held";

/**
 * Whether Forget is offered for cartridge `tag`. Only the shown player's status is published, so "online" here is
 * that player's `online: true`. One that is offline, still waited for after main started, or a stored player that
 * isn't the shown one gives `held`: the record may be all that keeps the cartridge "in" it, and main clears the slot
 * when it forgets the cartridge. Main still has the last word: it knows whether a player that isn't shown is online,
 * and refuses then. While main isn't running (`presence` is null) nothing is known to be online; nothing can change
 * then anyway.
 */
export function forgetState(
  record: PlayerRecord,
  tag: Tag,
  live: readonly LiveSession[],
  presence: PresenceState | null,
): ForgetState {
  const holders = Object.values(record.devices).filter((device) => device.slot?.tag === tag);
  if (holders.length === 0) return "free";
  const shown = presence?.deviceId ?? activeDevice(record)?.id ?? null;
  if (presence?.online === true && holders.some((device) => device.id === shown)) return "in-player";
  if (holders.some((device) => live.some((session) => session.id === device.slot?.sessionId))) return "tracking";
  return "held";
}

/**
 * Under a Forget that is off ("Take it out of the player to forget it"): what else turns it on. Null when the
 * button's own words say it all: a player that is online reports the cartridge leaving. One that isn't may never do,
 * and then ending the session is what main waits for.
 */
export function forgetBlockedNote(state: ForgetState): string | null {
  return state === "tracking"
    ? "If it's already out and its player hasn't said so, end the session in Drift Beacon; then it can be forgotten."
    : null;
}

/** In the confirmation for a `held` cartridge: what forgetting it means for the player that last had it. */
export const FORGET_CLEARS_SLOT = "The player last reported this cartridge in its slot. Forgetting it also clears that.";

/**
 * Main refusing a forget this copy offered for a `held` cartridge: its player turned out to be online (one that
 * isn't the shown one, whose status this copy can't see, or one that came back a moment ago). Main's own sentence
 * ("Take it out of the player first") would read as contradicting the confirmation above it, so this says why.
 */
export const FORGET_HOLDER_ONLINE = "Its player is online after all, so the cartridge counts as in it. Take it out of the player first.";

/** The sentence for a forget main refused (`cause`) when this copy had offered it in `state`, or null for the usual one. */
export function forgetRefusal(cause: unknown, state: ForgetState): string | null {
  const code = (cause as { code?: unknown } | null)?.code;
  return state === "held" && code === "invalid" ? FORGET_HOLDER_ONLINE : null;
}

/** Whether two builds of an item draw the same: the shelf memoises its cards on this, not on the item's identity. */
export function sameItem(a: LibraryItem, b: LibraryItem): boolean {
  return (
    a.tag === b.tag &&
    a.activityId === b.activityId &&
    a.activity === b.activity &&
    a.plays === b.plays &&
    a.playedMs === b.playedMs &&
    a.seenAt === b.seenAt &&
    a.inSlot === b.inSlot &&
    a.live === b.live &&
    a.tracking === b.tracking
  );
}
