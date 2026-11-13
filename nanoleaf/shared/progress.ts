/**
 * Goal progress for the current period, so the wall agrees with the app. Drift Beacon counts the activity's progress
 * (`ActivityLike.progress`, SDK 0.4): every member's ended sessions from the period's start, in the hub's time zone in
 * main code and the device's in the interface. A running span isn't in it, so the wall adds the one it shows.
 */
import type { ActivityLike, GoalProgress, SessionLike } from "./types.ts";

/**
 * Progress toward the activity's goal in its current period, or null when it has no goal (or a target ≤ 0).
 * `live` is the live span the wall shows: it adds to the activity's own progress only when it is this activity's.
 * - Duration: the ended sessions' seconds, plus the shown span's elapsed time (in full, even when it started before the
 *   period, as the app does).
 * - Count, point activity: the marks.
 * - Count, span activity: the ended sessions, plus 1 while the shown span runs.
 */
export function goalProgress(
  activity: ActivityLike,
  live: SessionLike | null,
  now: Date | number,
): GoalProgress | null {
  const goal = activity.goal;
  if (!goal) return null;
  const target = goal.type === "duration" ? goal.seconds : goal.count;
  if (!(target > 0) || !Number.isFinite(target)) return null;
  const point = activity.trackingType === "point";
  // Point activities only ever count (the SDK sends them count goals); a duration goal on one can't be measured.
  if (point && goal.type !== "count") return null;

  const nowMs = typeof now === "number" ? now : now.getTime();
  const period = activity.period ?? null;
  // Drift Beacon counts progress the way the goal measures it; anything else counts as nothing so far.
  const counted = activity.progress;
  const base =
    goal.type === "duration"
      ? counted?.type === "duration"
        ? counted.seconds
        : 0
      : counted?.type === "count"
        ? counted.count
        : 0;
  const shown =
    !point && live && live.activityId === activity.id && live.status === "live" && live.type === "span" ? live : null;

  let current = base;
  if (shown) {
    current += goal.type === "count" ? 1 : Math.max(0, nowMs - shown.startedAt.getTime()) / 1000;
  }
  return { goal, period, current, target, fraction: current / target };
}
