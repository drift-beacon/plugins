/**
 * Edits to the `player` record (shared/storage.ts), as pure functions returning a new record: player.ts composes them
 * inside a queued step and writes the result. Every list keeps its cap (LIMITS) here, so nothing main writes can grow
 * without bound.
 */
import {
  type CartridgeStats,
  type DeviceRecord,
  type HistoryEntry,
  LIMITS,
  type PlayerRecord,
  type TagMappings,
  mappedActivity,
  NO_STATS,
} from "../../shared/storage.ts";
import type { Tag } from "../../shared/tags.ts";

/** A device main hasn't heard from before. */
export function newDevice(id: string): DeviceRecord {
  return { id, name: null, fw: null, boot: null, seq: null, slot: null, lastHeardAt: null, hubHost: null };
}

/** What main knows of a stored device beyond the record, when a new one needs a place. */
export interface Standing {
  /** Heard from lately (or still expected to be): it keeps its place. */
  readonly online: boolean;
  /** When it was last heard from (epoch ms). */
  readonly heardAt: number;
}

/** The record's own word: nobody online, heard when `lastHeardAt` says (to within PRESENCE_WRITE_MS). */
const asStored = (device: DeviceRecord): Standing => ({
  online: false,
  heardAt: device.lastHeardAt === null ? 0 : Date.parse(device.lastHeardAt),
});

/** Whether a device main hasn't stored yet can be: there's a free place, or a stored one isn't online. */
export function hasRoom(record: PlayerRecord, standing: (device: DeviceRecord) => Standing = asStored): boolean {
  const devices = Object.values(record.devices);
  return devices.length < LIMITS.devices || devices.some((device) => !standing(device).online);
}

/**
 * `device` stored under its id. A fifth device replaces one that isn't online: the longest-quiet with nothing in its
 * slot, else the longest-quiet. With every other online there is no place to take: `hasRoom` says no, and the report
 * is refused before it gets here.
 */
export function withDevice(
  record: PlayerRecord,
  device: DeviceRecord,
  standing: (device: DeviceRecord) => Standing = asStored,
): PlayerRecord {
  const devices: Record<string, DeviceRecord> = { ...record.devices, [device.id]: device };
  const others = Object.values(devices).filter((other) => other.id !== device.id);
  if (others.length >= LIMITS.devices) {
    const quiet = others
      .map((other) => ({ other, ...standing(other) }))
      .filter((entry) => !entry.online)
      .sort((a, b) => a.heardAt - b.heardAt);
    const evicted = quiet.find((entry) => entry.other.slot === null) ?? quiet[0];
    delete devices[evicted.other.id];
  }
  const active = record.active !== null && Object.hasOwn(devices, record.active) ? record.active : null;
  return { ...record, devices, active };
}

/** A history entry, newest first, capped at LIMITS.history. */
export function withHistory(record: PlayerRecord, entry: Omit<HistoryEntry, "id">): PlayerRecord {
  const history = [{ id: record.nextId, ...entry }, ...record.history].slice(0, LIMITS.history);
  return { ...record, history, nextId: record.nextId + 1 };
}

/** `tag` listed as unknown, moved to the front (newest first), capped at LIMITS.unknown. */
export function withUnknown(record: PlayerRecord, tag: Tag, at: string): PlayerRecord {
  const previous = record.unknown.find((item) => item.tag === tag);
  const rest = record.unknown.filter((item) => item.tag !== tag);
  const unknown = [{ tag, firstSeenAt: previous?.firstSeenAt ?? at, lastSeenAt: at }, ...rest].slice(0, LIMITS.unknown);
  return { ...record, unknown };
}

export function withoutUnknown(record: PlayerRecord, tag: Tag): PlayerRecord {
  return record.unknown.some((item) => item.tag === tag)
    ? { ...record, unknown: record.unknown.filter((item) => item.tag !== tag) }
    : record;
}

/** A labelled cartridge's stats, changed by `change`. Unlabelled cartridges have none. */
export function withStats(
  record: PlayerRecord,
  tag: Tag,
  change: (stats: CartridgeStats) => CartridgeStats,
): PlayerRecord {
  const stats = Object.hasOwn(record.cartridges, tag) ? record.cartridges[tag] : NO_STATS;
  return { ...record, cartridges: { ...record.cartridges, [tag]: change(stats) } };
}

export function withoutStats(record: PlayerRecord, tag: Tag): PlayerRecord {
  if (!Object.hasOwn(record.cartridges, tag)) return record;
  const cartridges = { ...record.cartridges };
  delete cartridges[tag];
  return { ...record, cartridges };
}

/**
 * The record lined up with the labels: stats only for labelled cartridges (a missing entry reads as none yet), and no
 * labelled cartridge listed as unknown (a label landed while the record write that takes it off the list was refused).
 */
export function alignedWith(record: PlayerRecord, mappings: TagMappings): PlayerRecord {
  const cartridges: Record<Tag, CartridgeStats> = {};
  for (const [tag, stats] of Object.entries(record.cartridges)) {
    if (mappedActivity(mappings, tag) !== null) cartridges[tag] = stats;
  }
  const unknown = record.unknown.filter((item) => mappedActivity(mappings, item.tag) === null);
  return { ...record, cartridges, unknown };
}

/** Whether two JSON values are the same: main writes storage only when something changed. */
export const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
