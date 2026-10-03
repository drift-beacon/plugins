/**
 * What the player and the plugin say to each other over HTTP. Both sides are tested against this file: main parses
 * with it, and tests/firmware.test.mjs feeds the firmware's own report bodies through `parseReport` and the replies
 * built by `playerReply` through the firmware's reader, so the two can't drift apart.
 *
 * The protocol is level-triggered: the player reports what is in its slot now, on every change, on boot and
 * reconnect, and every `heartbeat_s` seconds; a lost or repeated report is harmless because the next one says the same
 * thing.
 */
import { normalizeTag, type Tag } from "./tags.ts";

/** The `player` field the probe answers with: firmware checks it before it saves a hub. */
export const PLAYER_KIND = "cartridge-player";
export const PROTOCOL = 2;
/** How often a player reports while nothing changes. Sent in every reply, so main can change it. */
export const HEARTBEAT_S = 30;
/** No report for this long and the player counts as offline: two missed heartbeats and some slack. */
export const OFFLINE_AFTER_MS = HEARTBEAT_S * 2_500;
/** Route names under `ctx.plugin.apiPath`. */
export const ROUTES = { report: "player", cubePreset: "cube-preset" } as const;
/** Activity names in replies are cut to this many characters (code points): the player only logs them. */
export const REPLY_NAME_MAX = 40;

/**
 * Why the player sent a report. Main applies what the report says is in the slot, whatever the reason. The reason
 * only decides two things: what a report that changes nothing is answered (`change`, `boot` and `pair` are retries of
 * a report whose reply was lost, and get that reply and its cue again while main still holds it, so not after a
 * restart; `heartbeat` and `reconnect` get `unchanged`), and `pair`, a player just set up, asks to be the one shown.
 * The firmware also sends `heartbeat`, under the `seq` already applied, when its reader fails or recovers and for what
 * it wanted to say while a report was out.
 */
export type ReportReason = "boot" | "pair" | "change" | "heartbeat" | "reconnect";
const REASONS: readonly ReportReason[] = ["boot", "pair", "change", "heartbeat", "reconnect"];

export interface DeviceInfo {
  /** "cp-" and the last three bytes of the MAC address, for example "cp-a1b2c3". */
  readonly id: string;
  /** Firmware version, for example "2.0.0". */
  readonly fw: string | null;
  /** The name it shows on its setup network, for example "Cartridge-A1B2". */
  readonly name: string | null;
}

/** A report, parsed. On the wire the field names are snake_case (see `parseReport`). */
export interface PlayerReport {
  readonly v: 2;
  readonly device: DeviceInfo;
  /** Random per power-up: a new value means the player restarted, so its `seq` starts again. */
  readonly boot: number;
  /** Goes up by one on every change of slot within a boot; heartbeats and retries repeat the last one. */
  readonly seq: number;
  readonly reason: ReportReason;
  /** What is in the slot now, or null when it's empty. */
  readonly tag: Tag | null;
  /** How long ago the slot last changed, by the player's clock. Informational: sessions can't be backdated. */
  readonly ageMs: number | null;
  readonly rssi: number | null;
  readonly uptimeS: number | null;
  /**
   * The reader's health. "fault" means the player can't currently tell whether a cartridge is in: `tag` is then the
   * last value it read (null when it never read one). Main never takes an empty slot from such a report, and under a
   * `(boot, seq)` it has already applied it takes nothing from it at all: the cartridge may since have been read in
   * another player's slot. "ok" is only said of a slot the reader has read, which is what lets main trust `tag` over
   * the `seq` it remembers.
   */
  readonly reader: "ok" | "fault" | null;
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const U32 = 0xffff_ffff;

type Fields = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isU32 = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= U32;
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Printable text cut to `max` characters, or null. Device-supplied names end up in the UI. */
function label(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text ? text.slice(0, max) : null;
}

/**
 * A report body:
 * `{ "v": 2, "device": { "id", "fw", "name" }, "boot", "seq", "reason", "tag": "04:A2:…" | null, "age_ms", "rssi",
 * "uptime_s", "reader": "ok" | "fault" }`. Unknown fields are ignored, so later firmware can add some.
 */
export function parseReport(body: unknown): Parsed<PlayerReport> {
  if (!isRecord(body) || body.v !== PROTOCOL) return { ok: false, error: `Expected a protocol ${PROTOCOL} report` };
  const device = isRecord(body.device) ? body.device : null;
  if (!device || typeof device.id !== "string" || !DEVICE_ID.test(device.id))
    return { ok: false, error: "device.id must be lower-case letters, digits and dashes" };
  if (!isU32(body.boot)) return { ok: false, error: "boot must be an unsigned 32-bit integer" };
  if (!isU32(body.seq)) return { ok: false, error: "seq must be an unsigned 32-bit integer" };
  const reason = REASONS.includes(body.reason as ReportReason) ? (body.reason as ReportReason) : null;
  if (!reason) return { ok: false, error: `reason must be one of ${REASONS.join(", ")}` };
  let tag: Tag | null = null;
  if (body.tag !== null && body.tag !== undefined) {
    tag = normalizeTag(body.tag);
    if (!tag) return { ok: false, error: "tag must be a UID like 04:A2:3B:1C, or null" };
  }
  const ageMs = finite(body.age_ms);
  return {
    ok: true,
    value: {
      v: PROTOCOL,
      device: { id: device.id, fw: label(device.fw, 32), name: label(device.name, 32) },
      boot: body.boot,
      seq: body.seq,
      reason,
      tag,
      ageMs: ageMs === null ? null : Math.max(0, Math.round(ageMs)),
      rssi: finite(body.rssi),
      uptimeS: finite(body.uptime_s),
      reader: body.reader === "ok" || body.reader === "fault" ? body.reader : null,
    },
  };
}

/**
 * What a report did:
 * - started / marked: the cartridge went in and its activity started (a span) or was marked (a point)
 * - resumed: it went in, or is still in after a restart, and its activity was already live: that session carries on
 * - unchanged: the slot is as main last knew it (a heartbeat, a retry, a repeat)
 * - ended / empty: the slot emptied and its session ended, or there was nothing to end
 * - unknown: an unlabelled cartridge went in; orphan / archived: its activity was deleted / archived
 * - error: starting failed (the plugin is fine; the report needn't be retried); stale: an older report than one
 *   already applied, ignored
 */
export type ReportResult =
  | "started"
  | "marked"
  | "resumed"
  | "unchanged"
  | "ended"
  | "empty"
  | "unknown"
  | "orphan"
  | "archived"
  | "error"
  | "stale";

/** The sound and light the player plays for a reply. */
export type Cue = "ok" | "bye" | "unknown" | "error" | "none";

export function cueFor(result: ReportResult): Cue {
  switch (result) {
    case "started":
    case "marked":
    case "resumed":
      return "ok";
    case "ended":
    case "empty":
      return "bye";
    case "unknown":
      return "unknown";
    case "orphan":
    case "archived":
    case "error":
      return "error";
    case "unchanged":
    case "stale":
      return "none";
  }
}

/** The 200 answer to a report. Kept under 512 bytes: the player reads it into a fixed buffer. */
export interface PlayerReply {
  readonly ok: true;
  readonly v: 2;
  /** The `seq` this answers. */
  readonly seq: number;
  readonly result: ReportResult;
  readonly cue: Cue;
  readonly heartbeat_s: number;
  /** The activity it's about, for the player's log. */
  readonly activity: string | null;
}

export function playerReply(seq: number, result: ReportResult, activity: string | null = null): PlayerReply {
  return {
    ok: true,
    v: PROTOCOL,
    seq,
    result,
    cue: cueFor(result),
    heartbeat_s: HEARTBEAT_S,
    // By code point: cutting a surrogate pair in two would send the player half an emoji, which isn't valid UTF-8.
    activity: activity === null ? null : Array.from(activity).slice(0, REPLY_NAME_MAX).join(""),
  };
}

/**
 * A report main didn't apply. `bad_request` (sent with status 400) won't get better by sending it again; `retry`
 * (status 503) will, after `retry_ms`. The platform answers 401/403 (key), 404 (path, or the plugin is off) and
 * 502/503/504 (restarting, crashed, timed out) itself, with `{ success: false, error }`.
 */
export interface ErrorReply {
  readonly ok: false;
  readonly v: 2;
  readonly code: "bad_request" | "retry";
  readonly error: string;
  readonly retry_ms?: number;
}

/** `GET <apiPath>/player`: the side-effect-free check a player makes before it saves a hub. */
export interface ProbeReply {
  readonly ok: true;
  readonly player: typeof PLAYER_KIND;
  readonly protocol: typeof PROTOCOL;
  readonly heartbeat_s: number;
}

export const probeReply = (): ProbeReply => ({
  ok: true,
  player: PLAYER_KIND,
  protocol: PROTOCOL,
  heartbeat_s: HEARTBEAT_S,
});
