/**
 * Goal progress for the current period, computed the way Drift Beacon computes it (packages/domain: progress-period.ts,
 * ActivityDailyStat, Activity.currentProgress and the web progress circle), so the wall agrees with the app.
 *
 * - Periods are local calendar periods: midnight, Sunday midnight, the 1st, Jan 1 (the process's time zone).
 * - Completed sessions of every member count, attributed to the moment they started (a span across midnight belongs
 *   entirely to the day it started).
 * - Only the user's own newest live span adds its running time, in full, even when it started before the period.
 */
import type { ActivityLike, GoalPeriod, GoalProgress, SessionLike } from "./types.ts";

/** Start of the local calendar period containing `now`; null (no period) means all history. */
export function periodStart(period: GoalPeriod | null, now: Date | number): Date | null {
  if (period == null) return null;
  const d = new Date(now);
  switch (period) {
    case "day":
      d.setHours(0, 0, 0, 0);
      return d;
    case "week":
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - d.getDay());
      return d;
    case "month":
      return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
    case "year":
      return new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0);
    default:
      return null;
  }
}

/** The user's newest live span of an activity (by start time), which is the only live session that counts. */
export function myLiveSpan(sessions: readonly SessionLike[], activityId: string, userId: string): SessionLike | null {
  let best: SessionLike | null = null;
  for (const s of sessions) {
    if (s.activityId !== activityId || s.status !== "live" || s.type !== "span") continue;
    if (!s.memberIds.includes(userId)) continue;
    if (!best || s.startedAt.getTime() > best.startedAt.getTime()) best = s;
  }
  return best;
}

/**
 * Progress toward the activity's goal in its current period, or null when it has no goal (or a target ≤ 0).
 * - Duration: completed spans of any member (seconds), plus the user's newest live span's elapsed time.
 * - Count, point activity: point sessions of any member.
 * - Count, span activity: completed spans of any member, plus 1 while the user has a live span of it.
 */
export function goalProgress(
  activity: ActivityLike,
  sessions: readonly SessionLike[],
  userId: string,
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
  const from = periodStart(period, nowMs)?.getTime() ?? -Infinity;

  let completedMs = 0;
  let completedSpans = 0;
  let points = 0;
  for (const s of sessions) {
    if (s.activityId !== activity.id || s.status !== "completed") continue;
    if (s.startedAt.getTime() < from) continue;
    if (s.type === "point") {
      points++;
    } else {
      completedSpans++;
      // The app sums whole milliseconds per session, then divides by 1000.
      if (s.endedAt) completedMs += Math.round(s.endedAt.getTime() - s.startedAt.getTime());
    }
  }

  let current: number;
  if (point) {
    current = points;
  } else {
    const live = myLiveSpan(sessions, activity.id, userId);
    if (goal.type === "count") {
      current = completedSpans + (live ? 1 : 0);
    } else {
      const liveMs = live ? Math.max(0, nowMs - live.startedAt.getTime()) : 0;
      current = completedMs / 1000 + liveMs / 1000;
    }
  }
  return { goal, period, current, target, fraction: current / target };
}
