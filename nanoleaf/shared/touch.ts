/**
 * The controller's UDP touch stream (nanoleaf-api.md §6): packets the controller sends while an events request for
 * touch (id 4) carries `TouchEventsPort: <port>`. A packet is a 2-byte panel count, then 5 bytes per panel: the
 * panel id (2), touch type and strength packed into one byte (1), and the id of the panel a swipe came from (2), all
 * big-endian.
 *
 * The doc reads two ways on two points: how byte 2 splits into type and strength, and what the from-id holds when
 * the touch is not a swipe (0xFFFF or 0x00FF). The one wall it has been tried on (Shapes, with tools/touch-probe.mjs)
 * sent type in bits 6–4 and strength in bits 3–0, and 0xFFFF (nanoleaf-api.md §6); other models and firmware are
 * untried (§11). So the decoder keeps byte 2 raw and the from-id as a number, and `swipePanel` places a swipe from
 * panel ids and arrival times alone: ids that aren't panels on the wall are ignored. That covers either fill value
 * unless the wall has a panel whose id is the fill (255 for 0x00FF, 65535 for 0xFFFF): then a touch that isn't a
 * swipe reads as a swipe's origin, and without trusting byte 2 the two can't be told apart. That is a known limit
 * (nanoleaf-api.md §11). The two readings of byte 2 are for logs and the probe.
 */

/**
 * Touch types, by number: 0 hover, 1 down, 2 hold, 3 up, 4 swipe. A Shapes wall also sends a type 5 the doc doesn't
 * list, on a tapped panel after its up; it has no name here and nothing reads it.
 */
export const TOUCH_TYPES = ["hover", "down", "hold", "up", "swipe"] as const;
export type TouchType = (typeof TOUCH_TYPES)[number];

/** The touch type numbers, by name. */
export const TOUCH_HOVER = 0;
export const TOUCH_DOWN = 1;
export const TOUCH_HOLD = 2;
export const TOUCH_UP = 3;
export const TOUCH_SWIPE = 4;

/**
 * How long before a swipe event the stream's records still count towards placing it. At a Shapes wall the event came
 * 0.1 to 0.9 s after the swipe's first record, where the two could be paired for certain (nanoleaf-api.md §6).
 */
export const SWIPE_WINDOW_MS = 1500;
/**
 * How long after a swipe event its touch data may still arrive: the controller sends the UDP packets before the SSE
 * event, but the receiver can be handed the SSE data first. A reader that finds nothing waits this long and looks
 * again (main/src/nanoleaf/touch-stream.ts `placeSwipe`).
 */
export const SWIPE_GRACE_MS = 120;
/** The most distinct (panel, from-id) pairs a `TouchBuffer` keeps; past it, new pairs are dropped. */
export const TOUCH_BUFFER_LIMIT = 256;
/** Panel ids that collide with a possible fill value (0x00FF, 0xFFFF): see the limit above. */
export const FILL_LIKE_PANEL_IDS: readonly number[] = [0x00ff, 0xffff];

const HEADER_BYTES = 2;
const RECORD_BYTES = 5;

/** One panel's record as it arrived: byte 2 untouched, the from-id as a number (meaningful only for a swipe). */
export interface TouchRecord {
  readonly panelId: number;
  readonly raw: number;
  readonly fromId: number;
}

/** A decoded packet: the whole records that fit, and whether the length disagreed with the count (or was short). */
export interface TouchPacket {
  readonly records: readonly TouchRecord[];
  /** The panel count the packet declares (0 for a packet shorter than its header). */
  readonly count: number;
  readonly malformed: boolean;
}

/**
 * Where byte 2 keeps type and strength. "table": bit 7 reserved, type in bits 6–3, strength in bits 2–0 (the doc's
 * table). "text": type in bits 6–4, strength in bits 3–0 (the doc's prose), which is what a Shapes wall sends
 * (nanoleaf-api.md §6).
 */
export type TouchByteLayout = "table" | "text";

/** One reading of byte 2. */
export interface TouchReading {
  readonly type: number;
  readonly strength: number;
}

/** Reads a packet. Never throws: a short or odd-length packet gives the whole records that fit and `malformed`. */
export function decodeTouchPacket(bytes: Uint8Array): TouchPacket {
  if (bytes.length < HEADER_BYTES) return { records: [], count: 0, malformed: true };
  const count = (bytes[0]! << 8) | bytes[1]!;
  const fit = Math.floor((bytes.length - HEADER_BYTES) / RECORD_BYTES);
  const records: TouchRecord[] = [];
  for (let i = 0; i < Math.min(count, fit); i++) {
    const at = HEADER_BYTES + i * RECORD_BYTES;
    records.push({
      panelId: (bytes[at]! << 8) | bytes[at + 1]!,
      raw: bytes[at + 2]!,
      fromId: (bytes[at + 3]! << 8) | bytes[at + 4]!,
    });
  }
  return { records, count, malformed: bytes.length !== HEADER_BYTES + count * RECORD_BYTES };
}

/** Byte 2 read the given way. */
export function readTouchByte(raw: number, layout: TouchByteLayout): TouchReading {
  return layout === "table"
    ? { type: (raw >> 3) & 0x0f, strength: raw & 0x07 }
    : { type: (raw >> 4) & 0x07, strength: raw & 0x0f };
}

/** Both readings of byte 2, for logs and the probe. Nothing else should depend on them. */
export function touchByteReadings(raw: number): { readonly table: TouchReading; readonly text: TouchReading } {
  return { table: readTouchByte(raw, "table"), text: readTouchByte(raw, "text") };
}

/** A touch type number's name, or null for one the doc doesn't list. */
export function touchTypeName(type: number): TouchType | null {
  return TOUCH_TYPES[type] ?? null;
}

/** A record to encode: a type number (0–4 by the doc) and strength; `fromId` defaults to the fill value. */
export interface TouchRecordInput {
  readonly panelId: number;
  readonly type: number;
  readonly strength?: number;
  readonly fromId?: number;
}

/** How to write records: byte 2's layout and the from-id of a record that doesn't give one. */
export interface TouchEncodeOptions {
  /** Default "text", as a Shapes wall sends it. */
  readonly layout?: TouchByteLayout;
  /** Default 0xFFFF; 0x00FF is the other reading of the doc. */
  readonly fill?: number;
}

/** Writes a packet (for the emulator and tests). Throws a RangeError for a value that doesn't fit its field. */
export function encodeTouchPacket(records: readonly TouchRecordInput[], options: TouchEncodeOptions = {}): Uint8Array {
  const { layout = "text", fill = 0xffff } = options;
  if (records.length > 0xffff) throw new RangeError(`${records.length} records don't fit a touch packet`);
  const bytes = new Uint8Array(HEADER_BYTES + records.length * RECORD_BYTES);
  bytes[0] = records.length >> 8;
  bytes[1] = records.length & 0xff;
  records.forEach((record, i) => {
    const { panelId, type, strength = 0, fromId = fill } = record;
    const [typeMax, strengthMax] = layout === "table" ? [0x0f, 0x07] : [0x07, 0x0f];
    uint(panelId, 0xffff, "panel id");
    uint(fromId, 0xffff, "from-id");
    uint(type, typeMax, "touch type");
    uint(strength, strengthMax, "strength");
    const at = HEADER_BYTES + i * RECORD_BYTES;
    bytes[at] = panelId >> 8;
    bytes[at + 1] = panelId & 0xff;
    bytes[at + 2] = layout === "table" ? (type << 3) | strength : (type << 4) | strength;
    bytes[at + 3] = fromId >> 8;
    bytes[at + 4] = fromId & 0xff;
  });
  return bytes;
}

function uint(value: number, max: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError(`${what} ${value} isn't 0–${max}`);
}

/** A record with the time it arrived (ms, the caller's clock). */
export interface TimedTouch {
  readonly record: TouchRecord;
  readonly at: number;
}

/**
 * The panel a swipe started on, from the records that arrived within `SWIPE_WINDOW_MS` before (and at) `swipeAt`: the
 * from-id of the earliest record whose from-id is a panel on the wall (if each swipe record names the panel before it,
 * later from-ids are the middle of the swipe), else the earliest record's panel that is on the wall, else null. Ids
 * not in `panelIds` are ignored, and so are records after `swipeAt`. A fill value that is also a panel's id (255 or
 * 65535) is not ignored and can win: the documented limit. Pass light panels only: the controller's own id (0 in the
 * fixtures) would otherwise count. `graceMs` also counts records that arrived up to that long after `swipeAt`
 * (default 0: none after it); the window still counts back from `swipeAt`. It doesn't change `recent`.
 */
export function swipePanel(
  recent: Iterable<TimedTouch>,
  swipeAt: number,
  panelIds: Iterable<number>,
  windowMs: number = SWIPE_WINDOW_MS,
  graceMs: number = 0,
): number | null {
  const wall = panelIds instanceof Set ? (panelIds as ReadonlySet<number>) : new Set(panelIds);
  let from: TimedTouch | null = null;
  let earliest: TimedTouch | null = null;
  for (const touch of recent) {
    if (touch.at > swipeAt + graceMs || swipeAt - touch.at > windowMs) continue;
    if (wall.has(touch.record.fromId) && (from === null || touch.at < from.at)) from = touch;
    if (wall.has(touch.record.panelId) && (earliest === null || touch.at < earliest.at)) earliest = touch;
  }
  if (from) return from.record.fromId;
  return earliest ? earliest.record.panelId : null;
}

/**
 * Recent records, oldest first. Each (panel id, from-id) pair is kept once, at the first time it was seen in the
 * window, so a flood of hover or hold records for one panel can't push out where a swipe started; past
 * `TOUCH_BUFFER_LIMIT` pairs, new pairs are dropped rather than old ones. Times must come from one monotonic clock.
 */
export class TouchBuffer {
  readonly #windowMs: number;
  readonly #limit: number;
  readonly #touches = new Map<string, TimedTouch>();

  constructor(windowMs: number = SWIPE_WINDOW_MS, limit: number = TOUCH_BUFFER_LIMIT) {
    this.#windowMs = windowMs;
    this.#limit = limit;
  }

  /** Adds a packet's records, all arriving at `at`, after dropping what has aged out. Repeated pairs change nothing. */
  push(records: readonly TouchRecord[], at: number): void {
    this.prune(at);
    for (const record of records) {
      const key = `${record.panelId}:${record.fromId}`;
      if (this.#touches.has(key) || this.#touches.size >= this.#limit) continue;
      this.#touches.set(key, { record, at });
    }
  }

  /** Drops records older than the window before `now`. */
  prune(now: number): void {
    for (const [key, touch] of this.#touches) if (now - touch.at > this.#windowMs) this.#touches.delete(key);
  }

  /** The records still in the window at `now`, oldest first. */
  recent(now: number): readonly TimedTouch[] {
    this.prune(now);
    return [...this.#touches.values()];
  }

  /**
   * `swipePanel` over this buffer for a swipe event that arrived at `swipeAt`, counting records up to `graceMs` after
   * it, changing nothing (a peek).
   */
  swipePanel(swipeAt: number, panelIds: Iterable<number>, graceMs: number = 0): number | null {
    return swipePanel(this.#touches.values(), swipeAt, panelIds, this.#windowMs, graceMs);
  }

  /**
   * Places a swipe event that arrived at `swipeAt` (counting records up to `graceMs` after it), then drops every
   * record at or before `swipeAt + graceMs`, placed or not, so the next swipe can't be placed by this one's touches.
   */
  takeSwipePanel(swipeAt: number, panelIds: Iterable<number>, graceMs: number = 0): number | null {
    const placed = this.swipePanel(swipeAt, panelIds, graceMs);
    this.drop(swipeAt + graceMs);
    return placed;
  }

  /** Drops every record that arrived at or before `until`. */
  drop(until: number): void {
    for (const [key, touch] of this.#touches) if (touch.at <= until) this.#touches.delete(key);
  }

  clear(): void {
    this.#touches.clear();
  }

  /** Distinct pairs held. */
  get size(): number {
    return this.#touches.size;
  }
}
