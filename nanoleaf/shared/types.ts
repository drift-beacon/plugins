/**
 * Types shared by main code, the UI and the tests. Everything under shared/ is pure TypeScript: no DOM, no Node
 * built-ins, no `Buffer`, no enums or namespaces (Node strips types when the tests import these files), and only
 * ES2022 library calls (the UI's lib). Runtime imports between these files carry the `.ts` extension.
 */

/** An sRGB colour, each channel an integer 0–255. */
export type Rgb = readonly [r: number, g: number, b: number];

/* ---- Controller layout ---- */

/** Panel shape types the plugin drives (Nanoleaf Shapes). */
export const HEXAGON = 7;
export const TRIANGLE = 8;
export const MINI_TRIANGLE = 9;
/** The Shapes controller: it has a position but no light. */
export const SHAPES_CONTROLLER = 12;

export type LightShapeType = typeof HEXAGON | typeof TRIANGLE | typeof MINI_TRIANGLE;
export type PanelKind = "hexagon" | "triangle" | "mini-triangle";

/** One entry of the controller's `positionData`, as reported: layout units, Y up, `o` in degrees. */
export interface RawPanel {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly o: number;
  readonly shapeType: number;
}

/** The controller's layout, as main caches it in storage (`layout`). Every positionData entry is kept. */
export interface Layout {
  /** The controller the layout belongs to: its serial number, or `host:port` when it has none. */
  readonly controllerId: string;
  /** Degrees, as reported (`panelLayout.globalOrientation.value`). */
  readonly globalOrientation: number;
  readonly panels: readonly RawPanel[];
  /** ISO time main read it. */
  readonly fetchedAt: string;
}

/** A point in layout units. Y is up in `PlacedPanel`; a view flips it. */
export type Point = readonly [x: number, y: number];

/** A light panel placed for drawing and ordering: global orientation and the view rotation applied, Y up. */
export interface PlacedPanel {
  readonly id: number;
  readonly shapeType: LightShapeType;
  readonly kind: PanelKind;
  /** Side length in layout units (hexagon 67, triangle 134, mini triangle 67). */
  readonly side: number;
  readonly center: Point;
  /** Corners, counter-clockwise. */
  readonly corners: readonly Point[];
  /** Distance from the centre to each edge's midpoint. */
  readonly inradius: number;
}

/** Everything else in the layout: the controller and shapes this plugin doesn't drive, drawn as inert ghosts. */
export interface PlacedOther {
  readonly id: number;
  readonly shapeType: number;
  readonly center: Point;
  /** Corners when the shape is known (for example Canvas squares); null draws a small marker. */
  readonly corners: readonly Point[] | null;
  readonly role: "controller" | "unsupported";
}

export interface PlacedLayout {
  readonly panels: readonly PlacedPanel[];
  readonly others: readonly PlacedOther[];
  /** Bounds of every corner (and marker), Y up. */
  readonly bounds: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
}

/* ---- Storage (per user and workspace, shared by main and the UI) ---- */

/**
 * Storage keys and their values:
 *   controller: ControllerConfig | null   written by main (pair, forget)
 *   layout: Layout | null                  written by main whenever the controller reports a different layout
 *   order: PanelOrder                      written by the UI
 *   settings: Settings                     written by the UI
 *   handback: Handback | null              written by main while it drives the wall
 * Read them through shared/storage.ts, which validates and fills defaults: values can come from another version.
 */
export const STORAGE_KEYS = {
  controller: "controller",
  layout: "layout",
  order: "order",
  settings: "settings",
  handback: "handback",
} as const;

/**
 * The wall as it was before the plugin took it (storage `handback`, main only), so it can be handed back even after
 * a restart while streaming: by then the controller only reports `*ExtControl*`.
 */
export interface Handback {
  readonly controllerId: string;
  readonly on: boolean;
  /** 0–100. */
  readonly brightness: number;
  /** `effects.select` as it was, for example "Northern Lights", "*Solid*" or "*Static*". */
  readonly effect: string | null;
  readonly colorMode: "effect" | "hs" | "ct" | null;
  readonly hue: number | null;
  readonly sat: number | null;
  readonly ct: number | null;
  /** When `effect` is `*Static*`: its animData, if the controller returned it, so the static scene can be redrawn. */
  readonly staticAnimData: string | null;
  readonly takenAt: string;
}

/** A paired controller. The token is readable by the UI (storage has no secret store), so the UI never shows it. */
export interface ControllerConfig {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /** Serial number, when the controller reported one. */
  readonly id: string | null;
  readonly name: string | null;
  readonly model: string | null;
}

/** How the fill order is chosen. */
export type OrderMode = "auto" | "custom" | "random";
/** Automatic orders: `path` walks neighbouring panels; the others sweep across the (rotated) wall. */
export type AutoOrder = "path" | "left-right" | "right-left" | "bottom-up" | "top-down";

export interface PanelOrder {
  readonly mode: OrderMode;
  /** Used when `mode` is `auto`. */
  readonly auto: AutoOrder;
  /**
   * The hand-made order, first fills first: used when `mode` is `custom`, and kept (ignored) through `auto` and
   * `random` so choosing Custom again brings it back. Those modes are computed from the layout (see order.ts).
   */
  readonly ids: readonly number[];
  /** Used when `mode` is `random`: the same seed gives the same shuffle for the same panels. */
  readonly seed: number;
}

export type PinnedStyle = "glow" | "pulse";
export type IdleBehaviour = "restore" | "off";

export interface Settings {
  /** Drive the panels at all. Off hands the wall back (as `idle` says) and keeps it. */
  readonly enabled: boolean;
  /** 5–100: the wall's brightness while the plugin drives it. */
  readonly maxBrightness: number;
  /** How a pinned activity shows when nothing is live. */
  readonly pinnedStyle: PinnedStyle;
  /** 10–80: a pinned activity's brightness as a percentage of the maximum (the peak, when pulsing). */
  readonly pinnedLevel: number;
  /** Show the pinned activity's goal progress, not just its colour. */
  readonly pinnedProgress: boolean;
  /** Light unfilled panels faintly, so the whole goal is visible. */
  readonly track: boolean;
  /** Pulse the wall in a schedule's activity colour when the schedule fires. */
  readonly scheduleAlert: boolean;
  /** Let other plugins and Home Assistant take the wall for an effect of their own (`takeControl`). */
  readonly allowControl: boolean;
  /** What the wall does when nothing is live or pinned: go back to its own scene, or turn off. */
  readonly idle: IdleBehaviour;
  /**
   * Degrees, a multiple of 30: how the wall hangs relative to the controller's layout. It rotates the drawing, and the
   * automatic orders follow the wall as it hangs (sweeps, the path's start and tie-breaks), so main resolves the order
   * with it too. A random order doesn't depend on it.
   */
  readonly viewRotation: number;
}

/* ---- Workspace data, structurally (SDK models satisfy these; tests and the prototypes pass plain objects) ---- */

/** SDK 0.2.2 `ActivityData.goal`: null when the activity has no goal. Point activities always count. */
export type ActivityGoal =
  | { readonly type: "duration"; readonly seconds: number }
  | { readonly type: "count"; readonly count: number };

export type GoalPeriod = "day" | "week" | "month" | "year";

/**
 * What the plugin reads of an activity. `goal`, `period` and `pinnedBy` arrived in SDK 0.2.2: an older Drift Beacon
 * sends none of them, so they are optional here and absent means "no goal, all history, not pinned".
 */
export interface ActivityLike {
  readonly id: string;
  readonly name: string;
  readonly trackingType: "span" | "point";
  readonly color: string;
  readonly iconPath: string | null;
  readonly archived: boolean;
  readonly goal?: ActivityGoal | null;
  readonly period?: GoalPeriod | null;
  readonly pinnedBy?: readonly string[];
}

export interface SessionLike {
  readonly id: string;
  readonly activityId: string;
  readonly type: "span" | "point";
  readonly status: "live" | "completed";
  readonly memberIds: readonly string[];
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

/** Progress toward an activity's goal in the current period, the way the app computes it. */
export interface GoalProgress {
  readonly goal: ActivityGoal;
  readonly period: GoalPeriod | null;
  /** Seconds (duration goals) or times (count goals) so far, including the user's live session. */
  readonly current: number;
  /** `goal.seconds` or `goal.count`. */
  readonly target: number;
  /** current / target, not clamped (1.4 = 140%). */
  readonly fraction: number;
}

/* ---- What the wall should show ---- */

export type SceneKind = "off" | "live" | "pinned" | "control";

/* ---- Control: another plugin (or Home Assistant) holds the wall and says what it shows ---- */

/** `pulse` and `shuffle` loop until the lease ends; `reveal` plays once and ends its lease. See effects.ts. */
export type ControlEffectType = "pulse" | "shuffle" | "reveal";

/** The effect a controller asked for, as the engine draws it and as the `control` state publishes it. */
export interface ControlEffect {
  /** One per accepted intent: it seeds the effect's randomness, and a new one fades in over the old. */
  readonly id: string;
  readonly type: ControlEffectType;
  /** The palette as LED colours, at least one. */
  readonly colors: readonly Rgb[];
  readonly periodMs: number;
  /** `reveal`: the colour every panel ends on. */
  readonly color: Rgb | null;
  /**
   * When it started (epoch ms): main's clock in main and in the published state; the UI shifts it onto its own
   * (`clockOffset`), so a page opened part-way through draws it part-way through.
   */
  readonly startedAt: number;
}

/** A held lock, as `decideScene` reads it. */
export interface ControlLease {
  /** Who holds it: a plugin's manifest id, or `integration` for Home Assistant. */
  readonly holder: string;
  /** One per hold, kept while the same holder changes or renews its effect. */
  readonly leaseId: string;
  readonly effect: ControlEffect;
}

/** Published state `control` (manifest.json): the held lock, or null. */
export interface ControlInfo extends ControlLease {
  readonly since: string;
  readonly expiresAt: string;
}

/** The decision, before any animation: what to show, derived from data and settings (scene.ts). */
export type Scene = ActivityScene | ControlScene;

/**
 * A controller's effect in place of the user's own scene. It keeps the activity scene's fields at fixed values, so
 * code that only reads them (a goal's progress, an activity) finds none; what it shows is `effect`.
 */
export interface ControlScene {
  readonly kind: "control";
  /** `control:<leaseId>`: the same through one hold, whatever its effects. */
  readonly key: string;
  readonly holder: string;
  readonly effect: ControlEffect;
  readonly activityId: null;
  /** The palette's first colour (a reveal's winner), for the interface's accents. */
  readonly cssColor: string;
  readonly rgb: Rgb;
  readonly progress: null;
  readonly level: 1;
  readonly style: "glow";
  readonly track: false;
}

/** What the user's own sessions and pins put on the wall, or nothing. */
export interface ActivityScene {
  readonly kind: "off" | "live" | "pinned";
  /** Changes whenever something different should show: `off`, `live:<sessionId>`, `pinned:<activityId>`. */
  readonly key: string;
  readonly activityId: string | null;
  /** The activity's colour as the app gives it (for the UI). */
  readonly cssColor: string | null;
  /** The same colour for LEDs: parsed and scaled so its brightest channel is 255. */
  readonly rgb: Rgb | null;
  /** Null when there is no goal, or the scene doesn't show one (pinned with `pinnedProgress` off). */
  readonly progress: GoalProgress | null;
  /** 0–1: the scene's peak level before the wall's brightness (live 1; pinned `pinnedLevel / 100`). */
  readonly level: number;
  /** `glow` for live scenes; the setting for pinned ones. */
  readonly style: PinnedStyle;
  readonly track: boolean;
}

/** A short-lived override while someone edits in the plugin's interface (the `preview` request). */
export type Preview =
  | { readonly mode: "identify"; readonly panelIds: readonly number[]; readonly rgb: Rgb | null }
  | { readonly mode: "fill"; readonly fraction: number; readonly rgb: Rgb | null }
  | { readonly mode: "order"; readonly rgb: Rgb | null };

/** One-off flourishes the renderer plays on top of a scene. */
export type Moment =
  | { readonly kind: "goal-met"; readonly at: number }
  | { readonly kind: "arrive"; readonly at: number };

/**
 * A schedule just fired: the whole wall swells twice in its activity's colour, over the scene and any preview, from
 * `at` (ms). See render.ts `withAlert`.
 */
export interface Alert {
  readonly at: number;
  readonly rgb: Rgb;
}

/**
 * Everything render.ts needs to draw a frame at time `t` (ms). Main and the UI keep one of these and feed it the
 * latest scene through `advance()` (render.ts), so the UI's preview moves exactly like the wall. The optional fields
 * came later: a state without them behaves as before.
 */
export interface RenderState {
  readonly scene: Scene;
  /** The scene being faded out, while a change is under way. */
  readonly previous: Scene | null;
  /** When `scene` replaced `previous` (ms). */
  readonly changedAt: number;
  readonly moments: readonly Moment[];
  readonly preview: Preview | null;
  /** When the preview started or last restarted (ms): the clock of its blinks and sweep. */
  readonly previewAt: number;
  /**
   * The whole earlier state when `scene` replaced `previous` in the middle of its fade or goal-met wave: it goes on
   * animating underneath and the new fade starts from it, so a change that lands mid-fade never jumps. Null (or
   * absent) when the change started from a settled `previous`.
   */
  readonly from?: RenderState | null;
  /** The running fade is a same-scene adjustment (style, level, track, progress shown, goal): short, unstaggered. */
  readonly adjust?: boolean;
  /** When the preview layer last started fading (ms): a preview starting, being replaced or ending. */
  readonly previewFadeAt?: number;
  /**
   * The preview layer it fades from, as it stood at `previewFadeAt` (its blinks and sweep go on); null (or absent)
   * fades from the scene.
   */
  readonly previewFrom?: PreviewFade | null;
  /** The last goal fraction seen per activity, newest first, so a goal met across a scene change still shimmers. */
  readonly goals?: readonly GoalMark[];
  /** Schedule alerts running or waiting their turn, oldest first: each starts as the one before it fades out. */
  readonly alerts?: readonly Alert[];
}

/**
 * A preview layer being faded from (render.ts): its preview (null: the scene shows through), the clock of its blinks
 * and sweep, when its own fade started, and the layer that fade started from.
 */
export interface PreviewFade {
  readonly preview: Preview | null;
  readonly previewAt: number;
  readonly fadeAt: number;
  readonly from: PreviewFade | null;
}

/** An activity's goal fraction as a render state last saw it. */
export interface GoalMark {
  readonly activityId: string;
  readonly fraction: number;
}

/**
 * One panel's light: an LED colour and a level 0–1. Main sends `deviceRgb(light)` and the UI draws it at
 * `lightOpacity(level)` (color.ts), so both show the same lift for dim lights.
 */
export interface PanelLight {
  readonly rgb: Rgb;
  readonly level: number;
}

/* ---- Published state (manifest.json provides.state) ---- */

export type ConnectionStatus = "unconfigured" | "connecting" | "connected" | "unreachable" | "unauthorized";

export interface ConnectionInfo {
  readonly status: ConnectionStatus;
  readonly host: string | null;
  readonly port: number | null;
  readonly name: string | null;
  readonly model: string | null;
  readonly firmware: string | null;
  /** Human-readable, for unreachable / unauthorized. */
  readonly error: string | null;
  /**
   * ISO time of the next reconnect attempt while unreachable. Null while unreachable means main won't try again by
   * itself: the stored address isn't on the local network, and `error` says what to enter instead.
   */
  readonly retryAt: string | null;
  /** The controller's event stream (layout changes, touches) is open. */
  readonly events: boolean;
  readonly since: string;
}

/**
 * - `disconnected`: no controller, or it can't be reached.
 * - `idle`: nothing live or pinned; the wall shows its own scene (or is off).
 * - `live` / `pinned`: showing that scene. `preview`: showing an interface preview.
 * - `control`: another plugin or Home Assistant holds the wall and its effect shows (the `control` state says who).
 * - `paused`: the user switched driving off. `yielded`: someone else changed the wall; waiting for the next change.
 * - `busy`: another user's or workspace's instance of this plugin is driving the same controller.
 */
export type OutputMode =
  | "disconnected"
  | "idle"
  | "live"
  | "pinned"
  | "control"
  | "preview"
  | "paused"
  | "yielded"
  | "busy";

export interface OutputInfo {
  readonly mode: OutputMode;
  readonly activityId: string | null;
  readonly fraction: number | null;
  readonly inControl: boolean;
  readonly detail: string | null;
  readonly since: string;
}

/** A controller found on the network (the `discover` request). */
export interface FoundController {
  readonly host: string;
  readonly port: number;
  readonly name: string | null;
  readonly model: string | null;
  readonly id: string | null;
  readonly source: "mdns" | "ssdp";
}

export type TouchGesture = "tap" | "double-tap" | "swipe-up" | "swipe-down" | "swipe-left" | "swipe-right";
