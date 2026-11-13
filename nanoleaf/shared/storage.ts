/**
 * Reads every storage value (see STORAGE_KEYS in types.ts) through a validator: storage can hold anything, written by
 * another version of the plugin, another device or a person with a JSON editor. A bad or missing field falls back to
 * its default and numbers are clamped, so callers never see a half-valid value.
 */
import { actingFor } from "./acting-for.ts";
import { GESTURE_KINDS, GESTURES } from "./gestures.ts";
import type {
  AutoOrder,
  ControllerConfig,
  GestureAction,
  GestureActions,
  Handback,
  IdleBehaviour,
  Layout,
  MemberLike,
  OrderMode,
  PanelOrder,
  PinnedStyle,
  RawPanel,
  Settings,
  SweepFill,
  Zone,
} from "./types.ts";

/** What a user gets before they change anything. */
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  enabled: true,
  maxBrightness: 80,
  pinnedStyle: "pulse",
  // The light a pin had as 35% of the default 80: the same wall, now its own setting.
  pinnedBrightness: 28,
  pinnedProgress: false,
  track: true,
  scheduleAlert: true,
  allowControl: true,
  idle: "off",
  viewRotation: 0,
  gestures: true,
  // The two that follow what's going on; nothing for a chosen activity, which only the user can pick.
  gestureActions: Object.freeze({
    "double-tap": Object.freeze({ kind: "pause-resume" }),
    "swipe-down": Object.freeze({ kind: "stop-unpin" }),
  }) as GestureActions,
});

/** Rise from the bottom as a straight line, like a glass filling up, until the user picks something else. */
export const DEFAULT_ORDER: PanelOrder = Object.freeze({
  mode: "auto",
  auto: "bottom-up",
  ids: Object.freeze([]) as readonly number[],
  seed: 1,
  sweepFill: "line",
});

/** The controller's REST port, used when nothing else is known. */
export const DEFAULT_PORT = 16021;

/** Documented ranges of the numeric settings (inclusive), shared with the UI's sliders. */
export const SETTING_RANGES = Object.freeze({
  maxBrightness: Object.freeze({ min: 5, max: 100 }),
  pinnedBrightness: Object.freeze({ min: 5, max: 100 }),
});

/** Every order mode, in the order the UI offers them. */
export const ORDER_MODES: readonly OrderMode[] = Object.freeze(["auto", "random", "custom"]);
/** Every automatic order, in the order the UI offers them. */
export const AUTO_ORDERS: readonly AutoOrder[] = Object.freeze([
  "path",
  "left-right",
  "right-left",
  "bottom-up",
  "top-down",
]);

const SWEEP_FILLS: readonly SweepFill[] = ["line", "panels"];
const PINNED_STYLES: readonly PinnedStyle[] = ["glow", "pulse"];
const IDLE_BEHAVIOURS: readonly IdleBehaviour[] = ["restore", "off"];
const COLOR_MODES = ["effect", "hs", "ct"] as const;
/** Stands in for a missing timestamp: a valid ISO time that is obviously old. */
const EPOCH = "1970-01-01T00:00:00.000Z";

type Fields = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A finite number, rounded and clamped; anything else is the fallback. */
function readInt<T>(value: unknown, min: number, max: number, fallback: T): number | T {
  return isFiniteNumber(value) ? clamp(Math.round(value), min, max) + 0 : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readOneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

/** A non-empty string (trimmed), or null. */
function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

/** Degrees in [0, 360). */
function wrapDegrees(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped >= 360 ? 0 : wrapped + 0;
}

/** Settings, field by field: bad fields take their default, numbers are clamped and rounded. */
export function readSettings(raw: unknown): Settings {
  if (!isRecord(raw)) return DEFAULT_SETTINGS;
  const d = DEFAULT_SETTINGS;
  const { maxBrightness, pinnedBrightness } = SETTING_RANGES;
  const rotation = isFiniteNumber(raw.viewRotation) ? wrapDegrees(Math.round(raw.viewRotation / 30) * 30) : 0;
  return {
    enabled: readBoolean(raw.enabled, d.enabled),
    maxBrightness: readInt(raw.maxBrightness, maxBrightness.min, maxBrightness.max, d.maxBrightness),
    pinnedStyle: readOneOf(raw.pinnedStyle, PINNED_STYLES, d.pinnedStyle),
    pinnedBrightness: readInt(raw.pinnedBrightness, pinnedBrightness.min, pinnedBrightness.max, d.pinnedBrightness),
    pinnedProgress: readBoolean(raw.pinnedProgress, d.pinnedProgress),
    track: readBoolean(raw.track, d.track),
    scheduleAlert: readBoolean(raw.scheduleAlert, d.scheduleAlert),
    allowControl: readBoolean(raw.allowControl, d.allowControl),
    idle: readOneOf(raw.idle, IDLE_BEHAVIOURS, d.idle),
    viewRotation: rotation,
    gestures: readBoolean(raw.gestures, d.gestures),
    gestureActions: raw.gestureActions === undefined ? d.gestureActions : readGestureActions(raw.gestureActions),
  };
}

/**
 * What each gesture does: unknown gestures and actions are dropped, and an action for a chosen activity needs its id.
 * Anything that isn't an object reads as no gestures at all (missing reads as the defaults, in readSettings).
 */
export function readGestureActions(raw: unknown): GestureActions {
  if (!isRecord(raw)) return {};
  const actions: Partial<Record<(typeof GESTURES)[number], GestureAction>> = {};
  for (const gesture of GESTURES) {
    const action = raw[gesture];
    if (!isRecord(action) || !GESTURE_KINDS.includes(action.kind as GestureAction["kind"])) continue;
    if (action.kind === "start" || action.kind === "pin") {
      const id = typeof action.activityId === "string" ? action.activityId.trim() : "";
      if (id !== "") actions[gesture] = { kind: action.kind, activityId: id };
    } else {
      actions[gesture] = { kind: action.kind as "pause-resume" | "stop-unpin" };
    }
  }
  return actions;
}

/** The id the first zone, the whole wall until it is split, is given when it is first written. It never changes. */
export const WALL_ZONE_ID = "wall";

/** Panel ids: the first copy of each non-negative integer (panel ids are never negative), in their stored order. */
function readPanelIds(raw: readonly unknown[]): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const id of raw) {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id + 0);
  }
  return ids;
}

/**
 * The wall's zones, every valid entry in stored order. An entry is an object; its id is a non-empty string, or
 * `WALL_ZONE_ID` for the first entry read when it has none (a later entry without one, or one repeating an id read
 * before, is left out). Its member is null unless a non-empty string. `panels` is kept when it is a list (its valid
 * ids, see `readPanelIds`) and `order` when it is an object (`readOrder`); otherwise the key is left out, so the zone
 * takes the panels nobody listed or the wall's order. Anything that isn't a list reads as no zones (the wall follows
 * the owner).
 */
export function readZones(raw: unknown): Zone[] {
  if (!Array.isArray(raw)) return [];
  const zones: Zone[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = readText(entry.id) ?? (zones.length === 0 ? WALL_ZONE_ID : null);
    if (id === null || ids.has(id)) continue;
    ids.add(id);
    const zone: { id: string; member: string | null; panels?: number[]; order?: PanelOrder } = {
      id,
      member: readText(entry.member),
    };
    if (Array.isArray(entry.panels)) zone.panels = readPanelIds(entry.panels);
    if (isRecord(entry.order)) zone.order = readOrder(entry.order);
    zones.push(zone);
  }
  return zones;
}

/* ---- Edits the zone screens make: each from the stored list to the next one, or a refusal ---- */

/** Why an edit to the zones was refused. */
export type ZoneRefusal =
  | "no-roster"
  | "not-a-member"
  | "has-zone"
  | "everyone-has-zone"
  | "last-zone"
  | "no-zone"
  | "split-wall"
  | "no-change";

/** Each refusal in words the screens can show. */
export const ZONE_REFUSALS: Readonly<Record<ZoneRefusal, string>> = Object.freeze({
  "no-roster": "This Drift Beacon doesn't say who is in the workspace.",
  "not-a-member": "Only someone in this workspace can have a zone.",
  "has-zone": "They have a zone already.",
  "everyone-has-zone": "Everyone has a zone already.",
  "last-zone": "The wall needs at least one zone.",
  "no-zone": "That zone isn't there any more.",
  "split-wall": "The wall has more than one zone.",
  "no-change": "Nothing would change.",
});

/** An edit's outcome: the list to store, or why not (`reason` is `ZONE_REFUSALS[refusal]`). */
export type ZoneEdit =
  | { readonly ok: true; readonly zones: Zone[] }
  | { readonly ok: false; readonly refusal: ZoneRefusal; readonly reason: string };

function refuse(refusal: ZoneRefusal): ZoneEdit {
  return { ok: false, refusal, reason: ZONE_REFUSALS[refusal] };
}

/** The edit's list, unless it would store exactly what is stored. */
function edited(stored: readonly Zone[], next: Zone[]): ZoneEdit {
  return JSON.stringify(next) === JSON.stringify(stored) ? refuse("no-change") : { ok: true, zones: next };
}

/** The lowest `z<n>` (from `z1`) that no zone in `zones` uses, so a new zone's id is unique and never `WALL_ZONE_ID`. */
export function nextZoneId(zones: readonly Zone[]): string {
  const used = new Set(zones.map((zone) => zone.id));
  let n = 1;
  while (used.has(`z${n}`)) n++;
  return `z${n}`;
}

/**
 * The zones the wall shows, as stored entries: what every edit starts from and all it writes back. They are exactly
 * the zones `resolveZones` (zones.ts) keeps, in stored order, each with the member it acts for and its id, panels and
 * order. A lone stored zone stands for the member it acts for (`actingFor`: its member, else the owner). With two or
 * more stored, a zone whose member has left, a second zone for a member and a repeated id are dropped; if none stands,
 * the wall is one zone (`WALL_ZONE_ID`) for the owner. Null with an empty roster: there is nobody to edit zones for.
 */
function standing(zones: readonly Zone[], members: readonly MemberLike[]): Zone[] | null {
  if (members.length === 0) return null;
  if (zones.length === 1) {
    const only = zones[0] as Zone;
    return [{ ...only, member: actingFor(only.member, members)[0] ?? null }];
  }
  const kept: Zone[] = [];
  const ids = new Set<string>();
  const zoned = new Set<string>();
  for (const zone of zones) {
    const member = zone.member;
    if (member === null || !members.some((m) => m.id === member) || zoned.has(member) || ids.has(zone.id)) continue;
    zoned.add(member);
    ids.add(zone.id);
    kept.push(zone);
  }
  return kept.length > 0 ? kept : [{ id: WALL_ZONE_ID, member: actingFor(null, members)[0] ?? null }];
}

/**
 * The members without a zone, in the roster's order: the only people a new zone, or a zone given away, can be for.
 * Every member, with no zone standing for any of them, is free; an empty roster has nobody.
 */
export function freeMembers(zones: readonly Zone[], members: readonly MemberLike[]): MemberLike[] {
  const zoned = new Set((standing(zones, members) ?? []).map((zone) => zone.member));
  return members.filter((member) => !zoned.has(member.id));
}

/**
 * What the unsplit wall's picker ("This wall follows") writes for `member`: the one zone the wall shows, given to them,
 * keeping its id (`WALL_ZONE_ID` the first time), panels and order. With the roster (`members`, as the screens pass
 * it) it is an edit like the others: refused with no roster, for someone outside the workspace, on a wall with more
 * than one zone standing (the zone screens use `giveZone` there), and when nothing would change.
 *
 * Called without the roster (main and the interface before zones), it can't tell which zones stand: a stored list of
 * at most one entry gives that entry (or a new `WALL_ZONE_ID` one) to `member`, as before zones; a longer stored list
 * comes back as read, unchanged, so the call can never give one member two zones.
 */
export function zonesFollowing(raw: unknown, member: string): Zone[];
export function zonesFollowing(raw: unknown, member: string, members: readonly MemberLike[]): ZoneEdit;
export function zonesFollowing(raw: unknown, member: string, members?: readonly MemberLike[]): Zone[] | ZoneEdit {
  const stored = readZones(raw);
  if (!members) {
    if (stored.length > 1) return stored;
    const first = stored[0];
    return [first ? { ...first, member } : { id: WALL_ZONE_ID, member }];
  }
  const shown = standing(stored, members);
  if (!shown) return refuse("no-roster");
  if (!members.some((m) => m.id === member)) return refuse("not-a-member");
  if (shown.length > 1) return refuse("split-wall");
  return edited(stored, [{ ...(shown[0] as Zone), member }]);
}

/**
 * Adds a zone for `member`, who must be in the workspace and have none, after the zones that stand, with an id none of
 * them uses and no panels yet. A wall that is one zone splits cleanly: that zone is stored with the member it acts for
 * and keeps every panel, since it lists none, until panels are moved.
 */
export function addZone(zones: readonly Zone[], member: string, members: readonly MemberLike[]): ZoneEdit {
  const shown = standing(zones, members);
  if (!shown) return refuse("no-roster");
  if (!members.some((m) => m.id === member)) return refuse("not-a-member");
  if (shown.length >= members.length) return refuse("everyone-has-zone");
  if (shown.some((zone) => zone.member === member)) return refuse("has-zone");
  return edited(zones, [...shown, { id: nextZoneId(shown), member, panels: [] }]);
}

/** Where a removed zone's panels go (`removeZone`): the zone `to`, which needs the wall's panel ids to name them all. */
export interface PanelsGoTo {
  readonly to: string;
  /** The wall's light panels (`placeLayout(...).panels`' ids). */
  readonly panelIds: Iterable<number>;
}

/**
 * Removes a standing zone; never the last. Its panels go to the first zone that remains (they are then listed
 * nowhere, or only by it), or, with `give`, to the zone named there: every panel the removed zone holds on the wall
 * is then listed in that zone.
 */
export function removeZone(
  zones: readonly Zone[],
  id: string,
  members: readonly MemberLike[],
  give?: PanelsGoTo,
): ZoneEdit {
  const shown = standing(zones, members);
  if (!shown) return refuse("no-roster");
  const at = shown.findIndex((zone) => zone.id === id);
  if (at < 0) return refuse("no-zone");
  if (shown.length <= 1) return refuse("last-zone");
  const rest = shown.filter((zone) => zone.id !== id);
  if (!give) return edited(zones, rest);
  if (give.to === id || !rest.some((zone) => zone.id === give.to)) return refuse("no-zone");
  // What it holds, by the rules `resolveZones` uses: what it lists that no zone before it lists, and, as the first,
  // every panel nobody lists.
  const before = new Set(shown.slice(0, at).flatMap((zone) => zone.panels ?? []));
  const listed = new Set(shown.flatMap((zone) => zone.panels ?? []));
  const own = new Set((shown[at] as Zone).panels ?? []);
  const held = [...new Set(give.panelIds)].filter(
    (panel) => (own.has(panel) && !before.has(panel)) || (at === 0 && !listed.has(panel)),
  );
  return edited(zones, moveInto(rest, give.to, held));
}

/**
 * Gives a standing zone to `member`, who must be in the workspace and have no zone; its panels and order stay. There is
 * no way to swap two people's zones: with everyone zoned, a zone can only be given back to its own member.
 */
export function giveZone(zones: readonly Zone[], id: string, member: string, members: readonly MemberLike[]): ZoneEdit {
  const shown = standing(zones, members);
  if (!shown) return refuse("no-roster");
  if (!shown.some((zone) => zone.id === id)) return refuse("no-zone");
  if (!members.some((m) => m.id === member)) return refuse("not-a-member");
  if (shown.some((zone) => zone.member === member)) return refuse("has-zone");
  return edited(zones, shown.map((zone) => (zone.id === id ? { ...zone, member } : zone)));
}

/** `zones` with `ids` listed in zone `id` (after what it lists already, which keeps its place) and off every other list. */
function moveInto(zones: readonly Zone[], id: string, ids: readonly number[]): Zone[] {
  const taken = new Set(ids);
  return zones.map((zone) => {
    const kept = zone.panels?.filter((panel) => !taken.has(panel));
    if (zone.id === id) {
      const listed = new Set(zone.panels ?? []);
      return { ...zone, panels: [...(zone.panels ?? []), ...ids.filter((panel) => !listed.has(panel))] };
    }
    return kept && kept.length !== zone.panels?.length ? { ...zone, panels: kept } : zone;
  });
}

/**
 * Moves panel ids into a standing zone: listed there (after the ones it lists already, which keep their place), and
 * taken off every other zone's list. A zone that lists nothing keeps listing nothing. Ids that aren't valid panel ids are ignored.
 */
export function movePanels(
  zones: readonly Zone[],
  id: string,
  panelIds: readonly number[],
  members: readonly MemberLike[],
): ZoneEdit {
  const shown = standing(zones, members);
  if (!shown) return refuse("no-roster");
  if (!shown.some((zone) => zone.id === id)) return refuse("no-zone");
  return edited(zones, moveInto(shown, id, readPanelIds(panelIds)));
}

/** Sets how a standing zone fills; null takes its own order away, so it fills by the wall's. */
export function setZoneOrder(
  zones: readonly Zone[],
  id: string,
  order: PanelOrder | null,
  members: readonly MemberLike[],
): ZoneEdit {
  const shown = standing(zones, members);
  if (!shown) return refuse("no-roster");
  if (!shown.some((zone) => zone.id === id)) return refuse("no-zone");
  return edited(
    zones,
    shown.map((zone) => {
      if (zone.id !== id) return zone;
      const { order: _old, ...rest } = zone;
      return order ? { ...rest, order: { ...order, ids: [...order.ids] } } : rest;
    }),
  );
}

/**
 * The fill order: unknown modes fall back, ids keep the first copy of each non-negative integer (panel ids are never
 * negative), and the seed becomes a uint32.
 */
export function readOrder(raw: unknown): PanelOrder {
  if (!isRecord(raw)) return DEFAULT_ORDER;
  const ids = Array.isArray(raw.ids) ? readPanelIds(raw.ids) : [];
  return {
    mode: readOneOf(raw.mode, ORDER_MODES, DEFAULT_ORDER.mode),
    auto: readOneOf(raw.auto, AUTO_ORDERS, DEFAULT_ORDER.auto),
    ids,
    seed: isFiniteNumber(raw.seed) ? Math.trunc(raw.seed) >>> 0 : DEFAULT_ORDER.seed,
    sweepFill: readOneOf(raw.sweepFill, SWEEP_FILLS, DEFAULT_ORDER.sweepFill),
  };
}

/** The paired controller, or null unless it has a host, a valid port and a token. */
export function readController(raw: unknown): ControllerConfig | null {
  if (!isRecord(raw)) return null;
  const host = readText(raw.host);
  const token = readText(raw.token);
  const port = raw.port;
  if (!host || !token || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, token, id: readText(raw.id), name: readText(raw.name), model: readText(raw.model) };
}

/**
 * `positionData`-like entries as `RawPanel`s. Entries without an integer id (under `idKey`) or finite x and y are
 * dropped, as are repeated ids (the first wins); `o` is wrapped into [0, 360) and a missing `shapeType` is 0, which
 * is what Light Panels firmware that predates shape types means.
 */
export function readRawPanels(raw: unknown, idKey: "id" | "panelId" = "id"): RawPanel[] {
  if (!Array.isArray(raw)) return [];
  const panels: RawPanel[] = [];
  const seen = new Set<number>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = entry[idKey];
    const { x, y, o, shapeType } = entry;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || seen.has(id)) continue;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) continue;
    seen.add(id);
    panels.push({
      id,
      x: x + 0,
      y: y + 0,
      o: isFiniteNumber(o) ? wrapDegrees(o) : 0,
      shapeType: typeof shapeType === "number" && Number.isInteger(shapeType) && shapeType >= 0 ? shapeType : 0,
    });
  }
  return panels;
}

/** The cached layout, or null without a controller id and a panel list. Bad panel entries are dropped. */
export function readLayout(raw: unknown): Layout | null {
  if (!isRecord(raw)) return null;
  const controllerId = readText(raw.controllerId);
  if (!controllerId || !Array.isArray(raw.panels)) return null;
  return {
    controllerId,
    globalOrientation: isFiniteNumber(raw.globalOrientation) ? wrapDegrees(raw.globalOrientation) : 0,
    panels: readRawPanels(raw.panels, "id"),
    fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : EPOCH,
  };
}

/** The wall as it was before takeover, or null unless it names its controller, power state and brightness. */
export function readHandback(raw: unknown): Handback | null {
  if (!isRecord(raw)) return null;
  const controllerId = readText(raw.controllerId);
  if (!controllerId || typeof raw.on !== "boolean" || !isFiniteNumber(raw.brightness)) return null;
  return {
    controllerId,
    on: raw.on,
    brightness: clamp(Math.round(raw.brightness), 0, 100) + 0,
    effect: typeof raw.effect === "string" && raw.effect !== "" ? raw.effect : null,
    colorMode: readOneOf<(typeof COLOR_MODES)[number] | "">(raw.colorMode, COLOR_MODES, "") || null,
    hue: readInt(raw.hue, 0, 360, null),
    sat: readInt(raw.sat, 0, 100, null),
    ct: readInt(raw.ct, 1200, 6500, null),
    staticAnimData: typeof raw.staticAnimData === "string" && raw.staticAnimData !== "" ? raw.staticAnimData : null,
    takenAt: typeof raw.takenAt === "string" ? raw.takenAt : EPOCH,
  };
}

/**
 * Whether two layouts describe the same wall: controller, global orientation and panels (id, x, y, o, shapeType),
 * in any order. `fetchedAt` is ignored, so main only rewrites storage when something real changed.
 */
export function sameLayout(a: Layout | null | undefined, b: Layout | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.controllerId !== b.controllerId) return false;
  if (wrapDegrees(a.globalOrientation) !== wrapDegrees(b.globalOrientation)) return false;
  if (a.panels.length !== b.panels.length) return false;
  const others = new Map(b.panels.map((panel) => [panel.id, panel]));
  if (others.size !== b.panels.length) return false;
  const seen = new Set<number>();
  for (const panel of a.panels) {
    const other = others.get(panel.id);
    if (!other || seen.has(panel.id)) return false;
    seen.add(panel.id);
    const same =
      panel.x === other.x &&
      panel.y === other.y &&
      wrapDegrees(panel.o) === wrapDegrees(other.o) &&
      panel.shapeType === other.shapeType;
    if (!same) return false;
  }
  return true;
}
