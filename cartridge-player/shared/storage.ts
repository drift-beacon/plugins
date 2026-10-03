/**
 * The plugin's storage, per user and workspace. Main is its only writer: the interface changes it through the
 * private channel (shared/ui-channel.ts), so a device event and a label can never overwrite each other. Every read
 * goes through a reader here, because storage can hold anything (an older version, another device, a JSON editor): a
 * bad field falls back to its default and callers never see a half-valid value.
 *
 * - `tagMappings`: tag → activity id, the user's labelled cartridges.
 * - `player`: everything else main knows (`PlayerRecord`), one record so an event updates it in one write.
 */
import { normalizeTag, type Tag } from "./tags.ts";

export const STORAGE_KEYS = { mappings: "tagMappings", player: "player" } as const;

/** Tag → activity id. Several cartridges may carry the same activity. */
export type TagMappings = Readonly<Record<Tag, string>>;

/**
 * What became of the cartridge in a slot when it went in, or since:
 * - started / marked / resumed: as the report results of the same name (shared/protocol.ts)
 * - idle: labelled and in the slot, but nothing was started for it: it was labelled or relabelled while in and not
 *   playing (which also clears a failed start): the interface offers to start it
 * - unknown: not labelled; orphan / archived: its activity was deleted / is archived, so nothing started
 * - error: starting failed; `error` says why
 * Whether a started session is still live is read from the workspace (`sessionId`), never stored.
 */
export type SlotOutcome = "started" | "marked" | "resumed" | "idle" | "unknown" | "orphan" | "archived" | "error";
const OUTCOMES: readonly SlotOutcome[] = [
  "started",
  "marked",
  "resumed",
  "idle",
  "unknown",
  "orphan",
  "archived",
  "error",
];

export interface Slot {
  readonly tag: Tag;
  /** When main saw it go in (ISO). */
  readonly since: string;
  /** The activity it went in as, or was labelled as since. Null while it's unlabelled. */
  readonly activityId: string | null;
  /** The session this cartridge started or adopted: taking it out ends this one, if it's still live, and no other. */
  readonly sessionId: string | null;
  readonly outcome: SlotOutcome;
  readonly error: string | null;
}

export interface DeviceRecord {
  /** `DeviceInfo.id`. */
  readonly id: string;
  readonly name: string | null;
  readonly fw: string | null;
  /** The last applied report's `boot` and `seq`, which order the next ones. */
  readonly boot: number | null;
  readonly seq: number | null;
  readonly slot: Slot | null;
  /** When it was last heard from (ISO). Written with other changes, and on its own at most every PRESENCE_WRITE_MS. */
  readonly lastHeardAt: string | null;
  /** The Host header its requests carry: the address it reaches the hub at, offered when setting up another. */
  readonly hubHost: string | null;
}

/** A cartridge the player has seen that isn't labelled yet. */
export interface UnknownTag {
  readonly tag: Tag;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/**
 * Per labelled cartridge: kept while it's labelled, dropped when it's forgotten. An entry appears the first time the
 * cartridge is labelled, goes in or comes out; a labelled cartridge without one has no stats yet (`NO_STATS`).
 */
export interface CartridgeStats {
  /** When it last went in or came out (ISO), or null if never since it was labelled. */
  readonly seenAt: string | null;
  /** Sessions it started or adopted. */
  readonly plays: number;
  /** Time tracked by those sessions while it was in (ms). */
  readonly playedMs: number;
}

export type HistoryKind = "insert" | "eject" | "new" | "label" | "relabel" | "forget" | "dismiss" | "start";
const HISTORY_KINDS: readonly HistoryKind[] = [
  "insert",
  "eject",
  "new",
  "label",
  "relabel",
  "forget",
  "dismiss",
  "start",
];

export interface HistoryEntry {
  /** Increasing; unique within the record. */
  readonly id: number;
  readonly at: string;
  readonly kind: HistoryKind;
  readonly tag: Tag;
  readonly activityId: string | null;
  readonly deviceId: string | null;
  readonly sessionId: string | null;
  /** eject: how long its session ran while it was in. */
  readonly durationMs: number | null;
}

export interface PlayerRecord {
  readonly v: 1;
  /** At most LIMITS.devices, keyed by id. */
  readonly devices: Readonly<Record<string, DeviceRecord>>;
  /**
   * The device the interface shows: the one whose slot changed last, or one heard for the first time or set up
   * again since (unless that would take the stage from a player that is online and playing).
   */
  readonly active: string | null;
  /** Newest first. */
  readonly unknown: readonly UnknownTag[];
  readonly cartridges: Readonly<Record<Tag, CartridgeStats>>;
  /** Newest first. */
  readonly history: readonly HistoryEntry[];
  /** The id the next history entry gets. */
  readonly nextId: number;
}

/** The stats of a labelled cartridge that has none recorded yet. */
export const NO_STATS: CartridgeStats = Object.freeze({ seenAt: null, plays: 0, playedMs: 0 });

export const LIMITS = Object.freeze({ devices: 4, unknown: 20, history: 50 });
/** A heartbeat on its own writes `lastHeardAt` at most this often; presence itself is published state. */
export const PRESENCE_WRITE_MS = 15 * 60_000;

export function emptyPlayerRecord(): PlayerRecord {
  return { v: 1, devices: {}, active: null, unknown: [], cartridges: {}, history: [], nextId: 1 };
}

type Fields = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const iso = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const text = (value: unknown, max = 200): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
const u32 = (value: unknown): number | null =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff ? (value as number) : null;

/** `tagMappings`, with every key in canonical form and only string activity ids. */
export function readMappings(value: unknown): TagMappings {
  const mappings: Record<Tag, string> = {};
  if (!isRecord(value)) return mappings;
  for (const [key, activityId] of Object.entries(value)) {
    const tag = normalizeTag(key);
    if (tag && typeof activityId === "string" && activityId) mappings[tag] = activityId;
  }
  return mappings;
}

/** The activity a tag is labelled with. Safe for any string: tags never collide with Object.prototype. */
export function mappedActivity(mappings: TagMappings, tag: Tag): string | null {
  return Object.hasOwn(mappings, tag) ? mappings[tag] : null;
}

function readSlot(value: unknown): Slot | null {
  if (!isRecord(value)) return null;
  const tag = normalizeTag(value.tag);
  const since = iso(value.since);
  if (!tag || !since) return null;
  const outcome = OUTCOMES.includes(value.outcome as SlotOutcome) ? (value.outcome as SlotOutcome) : "idle";
  return {
    tag,
    since,
    activityId: text(value.activityId),
    sessionId: text(value.sessionId),
    outcome,
    error: text(value.error, 300),
  };
}

function readDevice(id: string, value: unknown): DeviceRecord | null {
  if (!isRecord(value)) return null;
  return {
    id,
    name: text(value.name, 32),
    fw: text(value.fw, 32),
    boot: u32(value.boot),
    seq: u32(value.seq),
    slot: readSlot(value.slot),
    lastHeardAt: iso(value.lastHeardAt),
    hubHost: text(value.hubHost, 255),
  };
}

function readHistory(value: unknown): HistoryEntry | null {
  if (!isRecord(value)) return null;
  const tag = normalizeTag(value.tag);
  const at = iso(value.at);
  const id = count(value.id);
  if (!tag || !at || !id || !HISTORY_KINDS.includes(value.kind as HistoryKind)) return null;
  return {
    id,
    at,
    kind: value.kind as HistoryKind,
    tag,
    activityId: text(value.activityId),
    deviceId: text(value.deviceId, 32),
    sessionId: text(value.sessionId),
    durationMs: typeof value.durationMs === "number" && value.durationMs >= 0 ? Math.round(value.durationMs) : null,
  };
}

/** The `player` record, repaired: unknown fields dropped, lists capped, `active` pointing at a known device. */
export function readPlayerRecord(value: unknown): PlayerRecord {
  if (!isRecord(value) || value.v !== 1) return emptyPlayerRecord();
  const devices: Record<string, DeviceRecord> = {};
  if (isRecord(value.devices)) {
    for (const [id, raw] of Object.entries(value.devices)) {
      const device = /^[a-z0-9][a-z0-9-]{0,31}$/.test(id) ? readDevice(id, raw) : null;
      if (device && Object.keys(devices).length < LIMITS.devices) devices[id] = device;
    }
  }
  const seen = new Set<Tag>();
  const unknown: UnknownTag[] = [];
  for (const raw of Array.isArray(value.unknown) ? value.unknown : []) {
    const tag = isRecord(raw) ? normalizeTag(raw.tag) : null;
    const lastSeenAt = isRecord(raw) ? iso(raw.lastSeenAt) : null;
    if (!tag || !lastSeenAt || seen.has(tag) || unknown.length >= LIMITS.unknown) continue;
    seen.add(tag);
    unknown.push({ tag, firstSeenAt: iso((raw as Fields).firstSeenAt) ?? lastSeenAt, lastSeenAt });
  }
  const cartridges: Record<Tag, CartridgeStats> = {};
  if (isRecord(value.cartridges)) {
    for (const [key, raw] of Object.entries(value.cartridges)) {
      const tag = normalizeTag(key);
      if (tag && isRecord(raw))
        cartridges[tag] = { seenAt: iso(raw.seenAt), plays: count(raw.plays), playedMs: count(raw.playedMs) };
    }
  }
  const history = (Array.isArray(value.history) ? value.history : [])
    .map(readHistory)
    .filter((entry): entry is HistoryEntry => entry !== null)
    .slice(0, LIMITS.history);
  const maxId = history.reduce((max, entry) => Math.max(max, entry.id), 0);
  const active = typeof value.active === "string" && Object.hasOwn(devices, value.active) ? value.active : null;
  return { v: 1, devices, active, unknown, cartridges, history, nextId: Math.max(count(value.nextId), maxId + 1) };
}

/** The device the interface shows: the active one, else the one heard from last. */
export function activeDevice(record: PlayerRecord): DeviceRecord | null {
  if (record.active && Object.hasOwn(record.devices, record.active)) return record.devices[record.active];
  let latest: DeviceRecord | null = null;
  for (const device of Object.values(record.devices)) {
    if (!latest || (device.lastHeardAt ?? "") > (latest.lastHeardAt ?? "")) latest = device;
  }
  return latest;
}

/**
 * The slot holding `tag`, with its device: where the cartridge is, as far as the user is concerned. A cartridge is in
 * one slot at most (main empties any other when it goes in). Whether a cartridge still in the record of a player that
 * went quiet may be forgotten is main's to say, by a rule that also asks what main has heard since
 * (shared/ui-channel.ts, `forget`).
 */
export function slotHolding(record: PlayerRecord, tag: Tag): { device: DeviceRecord; slot: Slot } | null {
  for (const device of Object.values(record.devices)) {
    if (device.slot?.tag === tag) return { device, slot: device.slot };
  }
  return null;
}
