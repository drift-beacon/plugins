/**
 * What the wall should show, before any animation: the user's live session, else their pinned activity, else nothing.
 * Main and the UI both call `decideScene` on the same data, so the interface's preview matches the wall.
 */
import { cssRgb, parseColor, toLedRgb, WARM_WHITE } from "./color.ts";
import { goalProgress } from "./progress.ts";
import type {
  ActivityLike,
  ActivityScene,
  ControlLease,
  ControlScene,
  GoalPeriod,
  GoalProgress,
  Rgb,
  Scene,
  SessionLike,
  Settings,
} from "./types.ts";

/** The scene when nothing should show (or driving is switched off). */
export const OFF_SCENE: ActivityScene = Object.freeze({
  kind: "off",
  key: "off",
  activityId: null,
  cssColor: null,
  rgb: null,
  progress: null,
  level: 0,
  style: "glow",
  track: false,
});

/** Everything `decideScene` reads. `now` is a `Date` or epoch ms. */
export interface SceneInput {
  readonly userId: string;
  /** Every activity, archived included: a live session of an archived activity still glows; archived pins don't. */
  readonly activities: readonly ActivityLike[];
  /** Every session in the workspace; order doesn't matter. */
  readonly sessions: readonly SessionLike[];
  readonly settings: Settings;
  readonly now: Date | number;
  /** The lock a controller holds on the wall, if one does: main's lease, or the published `control` state in the UI. */
  readonly control?: ControlLease | null;
}

/** A held lock as a scene: the controller's effect in place of the user's own. */
export function controlScene(control: ControlLease): ControlScene {
  const effect = control.effect;
  const rgb = effect.color ?? effect.colors[0] ?? WARM_WHITE;
  return {
    kind: "control",
    key: `control:${control.leaseId}`,
    holder: control.holder,
    effect,
    activityId: null,
    cssColor: cssRgb(rgb),
    rgb,
    progress: null,
    level: 1,
    style: "glow",
    track: false,
  };
}

function ledColor(activity: ActivityLike): Rgb {
  return toLedRgb(parseColor(activity.color) ?? WARM_WHITE);
}

/**
 * Decides the scene: off when disabled; else a controller's effect while one holds the wall and the user allows it;
 * else the user's newest live span whose activity exists, archived or not, as core's live-activity slot shows it
 * (live, full level); else the first non-archived activity the user pinned (pinned level and style); else off.
 */
export function decideScene({ userId, activities, sessions, settings, now, control }: SceneInput): Scene {
  if (!settings.enabled) return OFF_SCENE;
  if (control && settings.allowControl) return controlScene(control);
  const at = typeof now === "number" ? now : now.getTime();

  let live: SessionLike | null = null;
  let liveActivity: ActivityLike | null = null;
  for (const s of sessions) {
    if (s.status !== "live" || s.type !== "span" || !s.memberIds.includes(userId)) continue;
    if (live && s.startedAt.getTime() <= live.startedAt.getTime()) continue;
    const activity = activities.find((a) => a.id === s.activityId);
    if (!activity) continue;
    live = s;
    liveActivity = activity;
  }
  if (live && liveActivity) {
    return {
      kind: "live",
      key: `live:${live.id}`,
      activityId: liveActivity.id,
      cssColor: liveActivity.color,
      rgb: ledColor(liveActivity),
      progress: goalProgress(liveActivity, sessions, userId, at),
      level: 1,
      style: "glow",
      track: settings.track,
    };
  }

  const pinned = activities.find((a) => !a.archived && (a.pinnedBy?.includes(userId) ?? false));
  if (pinned) {
    return {
      kind: "pinned",
      key: `pinned:${pinned.id}`,
      activityId: pinned.id,
      cssColor: pinned.color,
      rgb: ledColor(pinned),
      progress: settings.pinnedProgress ? goalProgress(pinned, sessions, userId, at) : null,
      level: settings.pinnedLevel / 100,
      style: settings.pinnedStyle,
      track: settings.track,
    };
  }
  return OFF_SCENE;
}

/* ---- Copy for the interface ---- */

/**
 * A goal fraction as the whole percent the app shows (its progress button rounds and stops at 100), so the plugin and
 * the app never disagree: 0.346 → 35, 0.996 → 100, 1.4 → 100. Anything not above 0 is 0.
 */
export function progressPercent(fraction: number): number {
  return Math.min(100, Math.round((fraction > 0 ? fraction : 0) * 100));
}

/** Progress as words and numbers for the UI: compose as `${currentLabel} of ${targetLabel} ${periodLabel}`. */
export interface ProgressCopy {
  /** Whole percent as the app shows it: `progressPercent(fraction)`, rounded and at most 100. */
  readonly percent: number;
  /** "21 min", "1 h 5 min", "45 s"; for counts just the number ("3"). */
  readonly currentLabel: string;
  /** "1 h"; for counts with the unit ("5 times", "1 time"). */
  readonly targetLabel: string;
  /** "today", "this week", "this month", "this year", or "in total" without a period. */
  readonly periodLabel: string;
}

const PERIOD_LABELS: Record<GoalPeriod, string> = {
  day: "today",
  week: "this week",
  month: "this month",
  year: "this year",
};

/** Seconds as a compact duration: "45 s" under a minute, "21 min" under an hour, then "1 h" or "1 h 5 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * Words for a goal's progress, for the Now card ("35% · 21 min of 1 h today", "3 of 5 times this week"). A span
 * activity's count goal counts sessions, so it reads "3 of 5 sessions" when `trackingType` says so.
 */
export function describeProgress(progress: GoalProgress, trackingType?: ActivityLike["trackingType"]): ProgressCopy {
  const percent = progressPercent(progress.fraction);
  const periodLabel = progress.period ? PERIOD_LABELS[progress.period] : "in total";
  if (progress.goal.type === "count") {
    const target = progress.target;
    const [one, many] = trackingType === "span" ? ["session", "sessions"] : ["time", "times"];
    return {
      percent,
      currentLabel: String(Math.max(0, Math.floor(progress.current))),
      targetLabel: `${target} ${target === 1 ? one : many}`,
      periodLabel,
    };
  }
  return {
    percent,
    currentLabel: formatDuration(progress.current),
    targetLabel: formatDuration(progress.target),
    periodLabel,
  };
}
