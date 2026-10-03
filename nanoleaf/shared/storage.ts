/**
 * Reads every storage value (see STORAGE_KEYS in types.ts) through a validator: storage can hold anything, written by
 * another version of the plugin, another device or a person with a JSON editor. A bad or missing field falls back to
 * its default and numbers are clamped, so callers never see a half-valid value.
 */
import type {
  AutoOrder,
  ControllerConfig,
  Handback,
  IdleBehaviour,
  Layout,
  OrderMode,
  PanelOrder,
  PinnedStyle,
  RawPanel,
  Settings,
} from "./types.ts";

/** What a user gets before they change anything. */
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  enabled: true,
  maxBrightness: 80,
  pinnedStyle: "pulse",
  pinnedLevel: 35,
  pinnedProgress: true,
  track: true,
  scheduleAlert: true,
  allowControl: true,
  idle: "restore",
  viewRotation: 0,
});

/** Fill along a walk over neighbouring panels until the user picks something else. */
export const DEFAULT_ORDER: PanelOrder = Object.freeze({
  mode: "auto",
  auto: "path",
  ids: Object.freeze([]) as readonly number[],
  seed: 1,
});

/** The controller's REST port, used when nothing else is known. */
export const DEFAULT_PORT = 16021;

/** Documented ranges of the numeric settings (inclusive), shared with the UI's sliders. */
export const SETTING_RANGES = Object.freeze({
  maxBrightness: Object.freeze({ min: 5, max: 100 }),
  pinnedLevel: Object.freeze({ min: 10, max: 80 }),
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
  const { maxBrightness, pinnedLevel } = SETTING_RANGES;
  const rotation = isFiniteNumber(raw.viewRotation) ? wrapDegrees(Math.round(raw.viewRotation / 30) * 30) : 0;
  return {
    enabled: readBoolean(raw.enabled, d.enabled),
    maxBrightness: readInt(raw.maxBrightness, maxBrightness.min, maxBrightness.max, d.maxBrightness),
    pinnedStyle: readOneOf(raw.pinnedStyle, PINNED_STYLES, d.pinnedStyle),
    pinnedLevel: readInt(raw.pinnedLevel, pinnedLevel.min, pinnedLevel.max, d.pinnedLevel),
    pinnedProgress: readBoolean(raw.pinnedProgress, d.pinnedProgress),
    track: readBoolean(raw.track, d.track),
    scheduleAlert: readBoolean(raw.scheduleAlert, d.scheduleAlert),
    allowControl: readBoolean(raw.allowControl, d.allowControl),
    idle: readOneOf(raw.idle, IDLE_BEHAVIOURS, d.idle),
    viewRotation: rotation,
  };
}

/**
 * The fill order: unknown modes fall back, ids keep the first copy of each non-negative integer (panel ids are never
 * negative), and the seed becomes a uint32.
 */
export function readOrder(raw: unknown): PanelOrder {
  if (!isRecord(raw)) return DEFAULT_ORDER;
  const ids: number[] = [];
  if (Array.isArray(raw.ids)) {
    const seen = new Set<number>();
    for (const id of raw.ids) {
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || seen.has(id)) continue;
      seen.add(id);
      ids.push(id + 0);
    }
  }
  return {
    mode: readOneOf(raw.mode, ORDER_MODES, DEFAULT_ORDER.mode),
    auto: readOneOf(raw.auto, AUTO_ORDERS, DEFAULT_ORDER.auto),
    ids,
    seed: isFiniteNumber(raw.seed) ? Math.trunc(raw.seed) >>> 0 : DEFAULT_ORDER.seed,
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
