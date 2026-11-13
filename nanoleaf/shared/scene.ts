/**
 * What the wall should show, before any animation: the newest live span the member the wall follows is in, else the
 * workspace's pin, else nothing. Main and the UI both call `decideScene` on the same data and the same members, so the
 * interface's preview matches the wall whoever is viewing it, except near a goal period's edge: the hub and the device
 * count goal progress in their own time zones.
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
  /** Every activity, archived included: a live session of an archived activity still glows; archived pins don't. */
  readonly activities: readonly ActivityLike[];
  /** Every session in the workspace; order doesn't matter. */
  readonly sessions: readonly SessionLike[];
  /** Who the wall follows: `actingFor` of its zone's member (acting-for.ts), a list of one. Empty follows nobody. */
  readonly following: readonly string[];
  readonly settings: Settings;
  readonly now: Date | number;
  /** The lock a controller holds on the wall, if one does: main's lease, or the published `control` state in the UI. */
  readonly control?: ControlLease | null;
}

/** A held lock as a scene: the controller's effect in place of the workspace's own scene. */
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
 * The live span the wall shows: the newest live span the member in `following` is in now (`currentMemberIds`), whose
 * activity exists, archived or not (as core's live-activity slot shows it). Null when there is none: a span they
 * aren't in doesn't light the wall.
 */
export function shownLive(
  activities: readonly ActivityLike[],
  sessions: readonly SessionLike[],
  following: readonly string[],
): { readonly session: SessionLike; readonly activity: ActivityLike } | null {
  let found: { session: SessionLike; activity: ActivityLike } | null = null;
  for (const s of sessions) {
    if (s.status !== "live" || s.type !== "span") continue;
    if (!s.currentMemberIds.some((id) => following.includes(id))) continue;
    if (found && s.startedAt.getTime() <= found.session.startedAt.getTime()) continue;
    const activity = activities.find((a) => a.id === s.activityId);
    if (activity) found = { session: s, activity };
  }
  return found;
}

/**
 * The workspace's pin the wall shows: the first non-archived pinned activity, or null. Core keeps one pin per workspace
 * (pinning moves the old one to Next), so "first" only matters if that ever changes: then this is the first in the
 * app's order, not the newest pin, and what Stop or unpin acts on would need choosing again.
 */
export function pinnedFor(activities: readonly ActivityLike[]): ActivityLike | null {
  return activities.find((a) => !a.archived && a.pinned === true) ?? null;
}

/**
 * Decides the scene: off when disabled; else a controller's effect while one holds the wall and the setting allows it;
 * else the live span `shownLive` picks (live, full level); else the workspace's pin, if its activity isn't archived
 * (pinned level and style); else off.
 */
export function decideScene({ activities, sessions, following, settings, now, control }: SceneInput): Scene {
  if (!settings.enabled) return OFF_SCENE;
  if (control && settings.allowControl) return controlScene(control);
  const at = typeof now === "number" ? now : now.getTime();

  const shown = shownLive(activities, sessions, following);
  if (shown) {
    const { session: live, activity: liveActivity } = shown;
    return {
      kind: "live",
      key: `live:${live.id}`,
      activityId: liveActivity.id,
      cssColor: liveActivity.color,
      rgb: ledColor(liveActivity),
      progress: goalProgress(liveActivity, live, at),
      level: 1,
      style: "glow",
      track: settings.track,
    };
  }

  const pinned = pinnedFor(activities);
  if (pinned) {
    return {
      kind: "pinned",
      key: `pinned:${pinned.id}`,
      activityId: pinned.id,
      cssColor: pinned.color,
      rgb: ledColor(pinned),
      progress: settings.pinnedProgress ? goalProgress(pinned, null, at) : null,
      // Dimmed by the wall's brightness instead (main drives a pin at `pinnedBrightness`).
      level: 1,
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
