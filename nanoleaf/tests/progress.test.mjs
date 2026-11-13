// Drift Beacon counts an activity's progress (`progress`: every member's ended sessions in the period); the wall adds
// the live span it shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { goalProgress } from "../shared/progress.ts";

const ME = "me";
const THEM = "them";
const MINUTE = 60;

function activity(goal, progress, period = "day", trackingType = "span") {
  return {
    id: "a",
    name: "Deep work",
    trackingType,
    color: "#7c3aed",
    iconPath: null,
    archived: false,
    goal,
    period,
    pinned: false,
    placedBy: null,
    progress,
  };
}

const seconds = (n) => ({ type: "duration", seconds: n });
const count = (n) => ({ type: "count", count: n });

function live(start, members = [ME], activityId = "a") {
  return {
    id: "live",
    activityId,
    type: "span",
    status: "live",
    memberIds: members,
    currentMemberIds: members,
    startedAt: start,
    endedAt: null,
  };
}

test("duration: the activity's progress plus the shown span's elapsed time", () => {
  const now = new Date(2026, 8, 30, 10, 15);
  const progress = goalProgress(activity(seconds(3600), seconds(30 * MINUTE)), live(new Date(2026, 8, 30, 10, 0)), now);
  const goal = seconds(3600);
  assert.deepEqual(progress, { goal, period: "day", current: 45 * MINUTE, target: 3600, fraction: 0.75 });
});

test("the shown span counts whoever is in it, or nobody", () => {
  const now = new Date(2026, 8, 30, 10, 0);
  const a = activity(seconds(3600), seconds(0));
  for (const members of [[ME], [THEM], [ME, THEM], []]) {
    const shown = live(new Date(2026, 8, 30, 9, 50), members);
    assert.equal(goalProgress(a, shown, now).current, 10 * MINUTE, `${members}`);
  }
});

test("only the shown span adds: none, another activity's, or one that ended adds nothing", () => {
  const now = new Date(2026, 8, 30, 10, 0);
  const a = activity(seconds(3600), seconds(20 * MINUTE));
  assert.equal(goalProgress(a, null, now).current, 20 * MINUTE);
  assert.equal(goalProgress(a, live(new Date(2026, 8, 30, 9, 0), [ME], "other"), now).current, 20 * MINUTE);
  const ended = { ...live(new Date(2026, 8, 30, 9, 0)), status: "completed", endedAt: now, currentMemberIds: [] };
  assert.equal(goalProgress(a, ended, now).current, 20 * MINUTE, "an ended span is in `progress` already");
});

test("duration: a shown span that started before the period counts in full, and a future start adds nothing", () => {
  const a = activity(seconds(3600), seconds(0));
  const progress = goalProgress(a, live(new Date(2026, 8, 29, 23, 0)), new Date(2026, 8, 30, 0, 30));
  assert.equal(progress.current, 90 * MINUTE);
  assert.equal(progress.fraction, 1.5, "not clamped");
  assert.equal(goalProgress(a, live(new Date(2026, 8, 30, 12, 5)), new Date(2026, 8, 30, 12, 0)).current, 0);
});

test("a year's or all history's goal reads Drift Beacon's count, however old its sessions", () => {
  const now = new Date(2026, 8, 30, 12, 0);
  for (const period of ["year", null]) {
    const progress = goalProgress(activity(seconds(1000 * 3600), seconds(400 * 3600), period), null, now);
    assert.equal(progress.current, 400 * 3600);
    assert.equal(progress.period, period);
  }
  const noPeriod = { ...activity(seconds(3600), seconds(60)), period: undefined };
  assert.equal(goalProgress(noPeriod, null, now).period, null, "an absent period is all history");
});

test("count goal on a point activity is the marks counted", () => {
  const now = new Date(2026, 8, 30, 12, 0);
  const progress = goalProgress(activity(count(5), count(3), "day", "point"), null, now);
  assert.deepEqual(progress, { goal: count(5), period: "day", current: 3, target: 5, fraction: 0.6 });
});

test("count goal on a span activity: the ended sessions, plus 1 while the shown span runs", () => {
  const now = new Date(2026, 8, 30, 12, 0);
  const a = activity(count(4), count(2));
  assert.equal(goalProgress(a, live(new Date(2026, 8, 30, 11, 0), [THEM]), now).current, 3);
  assert.equal(goalProgress(a, live(new Date(2026, 8, 30, 11, 0), [THEM]), now).fraction, 0.75);
  assert.equal(goalProgress(a, null, now).current, 2);
});

test("progress counted another way than the goal measures counts as nothing so far", () => {
  const now = new Date(2026, 8, 30, 12, 0);
  assert.equal(goalProgress(activity(seconds(3600), count(3)), null, now).current, 0);
  assert.equal(goalProgress(activity(count(4), seconds(600)), null, now).current, 0);
});

test("no goal, a null goal or a target of zero gives null", () => {
  const now = new Date(2026, 8, 30, 12, 0);
  const shown = live(new Date(2026, 8, 30, 11, 0));
  const base = activity(null, seconds(0));
  assert.equal(goalProgress(base, shown, now), null);
  assert.equal(goalProgress({ ...base, goal: undefined }, shown, now), null);
  assert.equal(goalProgress(activity(seconds(0), seconds(0)), shown, now), null);
  assert.equal(goalProgress(activity(count(-1), count(0)), shown, now), null);
  assert.equal(goalProgress(activity(seconds(60), seconds(0), "day", "point"), shown, now), null);
});
