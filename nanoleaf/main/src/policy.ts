/**
 * The Director's decisions as pure functions of its state: whether it wants the wall, what `output` says, when
 * someone else has taken the wall over, and whether a frame is worth sending. director.ts holds the state and the
 * I/O; everything it decides goes through here so the tests can cover every case without a clock or a device.
 */
import type { OutputInfo, OutputMode, Rgb, Scene } from "../../shared/types.ts";
import { EXT_CONTROL_EFFECT, STATIC_EFFECT } from "./handback.ts";

/** Everything the control decision and `output` depend on, at one moment. */
export interface ControlInput {
  /** The connection is `connected`. */
  readonly linked: boolean;
  /** Light panels in the controller's layout (0 before it is known, or for a wall with no Shapes panels). */
  readonly panels: number;
  readonly enabled: boolean;
  readonly scene: Scene;
  /** An interface preview's lease is running. */
  readonly previewActive: boolean;
  /** A schedule alert is playing, or waiting for the wall to be taken. */
  readonly alertActive: boolean;
  /** The scene key the Director yielded on, if it did. */
  readonly yieldedKey: string | null;
  /** Another instance holds the controller's claim. */
  readonly claimedElsewhere: boolean;
  readonly inControl: boolean;
  /** What the Director has to say about driving (static fallback, a failed takeover); null when all is well. */
  readonly note: string | null;
  /** Why it yielded, for `yielded`. */
  readonly yieldNote: string | null;
}

/** `output` without its timestamp: what is compared to decide whether to publish. */
export type OutputCore = Omit<OutputInfo, "since">;

/** Detail for `busy`: the claim is another user's or workspace's. */
export const BUSY_DETAIL = "Another Drift Beacon user or workspace is driving this controller";
/** Detail for `yielded` when there is no better reason. */
export const YIELDED_DETAIL = "Someone else changed the wall";
/** Detail when the layout has no panels this plugin can drive. */
export const NO_PANELS_DETAIL = "The controller reports no Shapes panels";

/** Something should show: a live or pinned scene, a controller's effect, an interface preview or a schedule alert. */
function hasSomethingToShow(input: ControlInput): boolean {
  return input.scene.kind !== "off" || input.previewActive || input.alertActive;
}

function isYielded(input: ControlInput): boolean {
  return input.yieldedKey !== null && input.yieldedKey === input.scene.key;
}

/**
 * Whether the Director wants to drive the wall: enabled, connected with panels, something to show, not yielded for
 * this scene, and the claim free (or its own).
 */
export function wantsControl(input: ControlInput): boolean {
  return (
    input.enabled &&
    input.linked &&
    input.panels > 0 &&
    hasSomethingToShow(input) &&
    !isYielded(input) &&
    !input.claimedElsewhere
  );
}

/** The published output's mode and detail. */
export function outputMode(input: ControlInput): { readonly mode: OutputMode; readonly detail: string | null } {
  if (!input.linked) return { mode: "disconnected", detail: null };
  if (!input.enabled) return { mode: "paused", detail: null };
  if (input.panels === 0) return { mode: "idle", detail: NO_PANELS_DETAIL };
  const active = hasSomethingToShow(input);
  if (active && isYielded(input)) return { mode: "yielded", detail: input.yieldNote ?? YIELDED_DETAIL };
  if (active && input.claimedElsewhere && !input.inControl) return { mode: "busy", detail: BUSY_DETAIL };
  if (input.previewActive) return { mode: "preview", detail: input.note };
  const kind = input.scene.kind;
  return { mode: kind === "off" ? "idle" : kind, detail: input.note };
}

/** Goal progress for `output`: clamped to 0–1.5 and rounded to 0.001, or null without a goal. */
export function outputFraction(scene: Scene): number | null {
  const fraction = scene.progress?.fraction;
  if (fraction === undefined || !Number.isFinite(fraction)) return null;
  return Math.round(Math.min(1.5, Math.max(0, fraction)) * 1000) / 1000;
}

/** The whole `output` (without `since`) for this moment. */
export function deriveOutput(input: ControlInput): OutputCore {
  const { mode, detail } = outputMode(input);
  return {
    mode,
    activityId: input.scene.activityId,
    fraction: outputFraction(input.scene),
    inControl: input.inControl,
    detail,
  };
}

/** Whether two outputs say the same (`since` is not part of them). */
export function sameOutput(a: OutputCore | null, b: OutputCore): boolean {
  return (
    a !== null &&
    a.mode === b.mode &&
    a.activityId === b.activityId &&
    a.fraction === b.fraction &&
    a.inControl === b.inControl &&
    a.detail === b.detail
  );
}

/** What the controller reported while the Director drives it (an event, a poll or a read). */
export interface YieldInput {
  /** It drives the wall with static writes, so `*Static*` is its own effect. */
  readonly staticMode: boolean;
  /** The effect reported; undefined when it wasn't reported. */
  readonly effect?: string | null;
  /** The power state reported; undefined when it wasn't reported. */
  readonly on?: boolean;
}

/**
 * Why the Director should yield, or null: the controller reports an effect other than its own (`*ExtControl*`, or
 * `*Static*` in static mode) or that the wall was switched off. The takeover's echo window is `echoWait`'s concern.
 */
export function yieldReason(input: YieldInput): string | null {
  if (input.on === false) return "The wall was switched off from somewhere else";
  const effect = input.effect;
  if (effect === undefined || effect === null || effect === EXT_CONTROL_EFFECT) return null;
  if (input.staticMode && effect === STATIC_EFFECT) return null;
  return `The wall was switched to "${effect}" from somewhere else`;
}

/**
 * How long a report that would make it yield may still be an echo of the takeover (the old effect announced again as
 * the wall powers on, or a hand-back just before it), so it is checked again then rather than acted on; 0 once past.
 */
export function echoWait(now: number, takenAt: number, windowMs: number): number {
  return Math.max(0, takenAt + windowMs - now);
}

/** One panel's colour in a frame, as sent. */
export type FrameEntry = readonly [id: number, rgb: Rgb];

/** Whether `next` differs from what was last sent: other panels, or any channel off by 1 or more. */
export function frameChanged(previous: readonly FrameEntry[] | null, next: readonly FrameEntry[]): boolean {
  if (!previous || previous.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) {
    const a = previous[i];
    const b = next[i];
    if (!a || !b || a[0] !== b[0]) return true;
    const [ra, ga, ba] = a[1];
    const [rb, gb, bb] = b[1];
    if (Math.abs(ra - rb) >= 1 || Math.abs(ga - gb) >= 1 || Math.abs(ba - bb) >= 1) return true;
  }
  return false;
}

/** How long to wait before a throttled write may go (0: now). */
export function throttleWait(now: number, lastWriteAt: number, intervalMs: number): number {
  return Math.max(0, lastWriteAt + intervalMs - now);
}
