// Dates are built with local-time constructors (new Date(y, m, d, h, min)), so these tests pass in any TZ:
// periods are local calendar periods, as in the app. Try e.g. `TZ=Pacific/Chatham node --test tests/progress.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { goalProgress, myLiveSpan, periodStart } from "../shared/progress.ts";

const ME = "me";
const THEM = "them";

function activity(goal, period = "day", trackingType = "span") {
  return { id: "a", name: "Deep work", trackingType, color: "#7c3aed", iconPath: null, archived: false, goal, period };
}

let seq = 0;
function span(start, end, members = [ME], activityId = "a") {
  const status = end ? "completed" : "live";
  return { id: `s${++seq}`, activityId, type: "span", status, memberIds: members, startedAt: start, endedAt: end };
}

function point(at, members = [ME], activityId = "a") {
  const id = `p${++seq}`;
  return { id, activityId, type: "point", status: "completed", memberIds: members, startedAt: at, endedAt: at };
}

const MINUTE = 60;

test("periodStart: day, week (Sunday), month and year in local time; null is all history", () => {
  const now = new Date(2026, 8, 30, 10, 15); // Wednesday
  assert.deepEqual(periodStart("day", now), new Date(2026, 8, 30));
  assert.deepEqual(periodStart("week", now), new Date(2026, 8, 27));
  assert.deepEqual(periodStart("month", now), new Date(2026, 8, 1));
  assert.deepEqual(periodStart("year", now), new Date(2026, 0, 1));
  assert.equal(periodStart(null, now), null);
  assert.deepEqual(periodStart("day", now.getTime()), new Date(2026, 8, 30));
  assert.deepEqual(now, new Date(2026, 8, 30, 10, 15), "now is not mutated");
});

test("periodStart: the week starts on Sunday, across month, year and DST boundaries", () => {
  assert.deepEqual(periodStart("week", new Date(2026, 8, 27, 0, 0)), new Date(2026, 8, 27), "Sunday midnight");
  assert.deepEqual(periodStart("week", new Date(2026, 8, 26, 23, 59)), new Date(2026, 8, 20), "Saturday night");
  assert.deepEqual(periodStart("week", new Date(2026, 9, 1, 8)), new Date(2026, 8, 27), "into October");
  assert.deepEqual(periodStart("week", new Date(2027, 0, 1, 8)), new Date(2026, 11, 27), "into 2027");
  // US and EU DST changes fall in these weeks; the start is still local midnight.
  assert.deepEqual(periodStart("week", new Date(2026, 10, 4, 12)), new Date(2026, 10, 1));
  assert.deepEqual(periodStart("week", new Date(2026, 2, 31, 12)), new Date(2026, 2, 29));
  assert.deepEqual(periodStart("day", new Date(2026, 9, 25, 23, 59)), new Date(2026, 9, 25));
  assert.deepEqual(periodStart("month", new Date(2026, 11, 31, 23, 59)), new Date(2026, 11, 1));
  assert.deepEqual(periodStart("year", new Date(2026, 11, 31, 23, 59)), new Date(2026, 0, 1));
  assert.deepEqual(periodStart("month", new Date(2026, 2, 1, 0, 0)), new Date(2026, 2, 1));
});

test("duration: completed spans of every member today, plus my live span", () => {
  const now = new Date(2026, 8, 30, 10, 15);
  const sessions = [
    span(new Date(2026, 8, 30, 10, 0), null), // mine, live: 15 min
    span(new Date(2026, 8, 30, 9, 0), new Date(2026, 8, 30, 9, 20)), // mine: 20 min
    span(new Date(2026, 8, 30, 8, 0), new Date(2026, 8, 30, 8, 10), [THEM]), // theirs: 10 min
    span(new Date(2026, 8, 29, 23, 30), new Date(2026, 8, 30, 0, 30)), // started yesterday: its start day's
    span(new Date(2026, 8, 30, 7, 0), new Date(2026, 8, 30, 8, 0), [ME], "other"), // another activity
    point(new Date(2026, 8, 30, 9, 30)), // points never add time
  ];
  const progress = goalProgress(activity({ type: "duration", seconds: 3600 }), sessions, ME, now);
  assert.deepEqual(progress, {
    goal: { type: "duration", seconds: 3600 },
    period: "day",
    current: 45 * MINUTE,
    target: 3600,
    fraction: 0.75,
  });
});

test("duration: other members' live sessions don't count, and only my newest live span does", () => {
  const now = new Date(2026, 8, 30, 10, 0);
  const sessions = [
    span(new Date(2026, 8, 30, 9, 0), null, [THEM]), // their live session: excluded
    span(new Date(2026, 8, 30, 9, 50), null), // my newest: 10 min
    span(new Date(2026, 8, 30, 9, 30), null), // an older live one (two offline devices): ignored
  ];
  const progress = goalProgress(activity({ type: "duration", seconds: 3600 }), sessions, ME, now);
  assert.equal(progress.current, 10 * MINUTE);
  assert.equal(myLiveSpan(sessions, "a", ME), sessions[1]);
  assert.equal(myLiveSpan(sessions, "a", "nobody"), null);
  // A shared live session I'm a member of is mine too.
  const shared = [span(new Date(2026, 8, 30, 9, 0), null, [THEM, ME])];
  assert.equal(goalProgress(activity({ type: "duration", seconds: 3600 }), shared, ME, now).current, 3600);
});

test("duration: a live span that started before the period counts in full", () => {
  const now = new Date(2026, 8, 30, 0, 30);
  const sessions = [
    span(new Date(2026, 8, 29, 23, 0), null),
    span(new Date(2026, 8, 29, 20, 0), new Date(2026, 8, 29, 22, 0)), // yesterday: excluded
  ];
  const progress = goalProgress(activity({ type: "duration", seconds: 3600 }), sessions, ME, now);
  assert.equal(progress.current, 90 * MINUTE);
  assert.equal(progress.fraction, 1.5, "not clamped");
});

test("duration: millisecond precision is kept, and a live start in the future adds nothing", () => {
  const now = new Date(2026, 8, 30, 12, 0);
  const start = new Date(2026, 8, 30, 9, 0);
  const sessions = [
    span(start, new Date(start.getTime() + 1500)),
    span(new Date(2026, 8, 30, 12, 5), null),
  ];
  assert.equal(goalProgress(activity({ type: "duration", seconds: 60 }), sessions, ME, now).current, 1.5);
});

test("week, month, year and all-history periods pick the right sessions", () => {
  const now = new Date(2026, 8, 30, 12, 0); // Wednesday
  const sessions = [
    span(new Date(2026, 8, 27, 0, 0), new Date(2026, 8, 27, 1, 0)), // Sunday: this week
    span(new Date(2026, 8, 26, 23, 0), new Date(2026, 8, 27, 1, 0)), // Saturday night: last week
    span(new Date(2026, 8, 1, 8, 0), new Date(2026, 8, 1, 9, 0)), // this month
    span(new Date(2026, 0, 1, 8, 0), new Date(2026, 0, 1, 9, 0)), // this year
    span(new Date(2025, 11, 31, 23, 0), new Date(2026, 0, 1, 1, 0)), // last year
  ];
  const goal = { type: "duration", seconds: 36000 };
  const hours = (period) => goalProgress(activity(goal, period), sessions, ME, now).current / 3600;
  assert.equal(hours("day"), 0);
  assert.equal(hours("week"), 1);
  assert.equal(hours("month"), 1 + 2 + 1);
  assert.equal(hours("year"), 1 + 2 + 1 + 1);
  assert.equal(hours(null), 1 + 2 + 1 + 1 + 2);
  const noPeriod = { ...activity(goal), period: undefined };
  assert.equal(goalProgress(noPeriod, sessions, ME, now).current / 3600, 7, "an absent period is all history");
  assert.equal(goalProgress(noPeriod, sessions, ME, now).period, null);
});

test("count goal on a point activity counts every member's marks in the period", () => {
  const now = new Date(2026, 8, 30, 12, 0);
  const sessions = [
    point(new Date(2026, 8, 30, 8, 0)),
    point(new Date(2026, 8, 30, 9, 0), [THEM]),
    point(new Date(2026, 8, 30, 0, 0)),
    point(new Date(2026, 8, 29, 23, 59)), // yesterday
    point(new Date(2026, 8, 30, 9, 0), [ME], "other"),
  ];
  const progress = goalProgress(activity({ type: "count", count: 5 }, "day", "point"), sessions, ME, now);
  const goal = { type: "count", count: 5 };
  assert.deepEqual(progress, { goal, period: "day", current: 3, target: 5, fraction: 0.6 });
});

test("count goal on a span activity counts completed spans plus my live one", () => {
  const now = new Date(2026, 8, 30, 12, 0);
  const sessions = [
    span(new Date(2026, 8, 30, 11, 0), null), // mine, live: +1
    span(new Date(2026, 8, 30, 10, 0), null, [THEM]), // theirs, live: no
    span(new Date(2026, 8, 30, 8, 0), new Date(2026, 8, 30, 9, 0)),
    span(new Date(2026, 8, 30, 9, 0), new Date(2026, 8, 30, 9, 5), [THEM]),
    span(new Date(2026, 8, 29, 9, 0), new Date(2026, 8, 29, 9, 5)), // yesterday
  ];
  const goal = { type: "count", count: 4 };
  const progress = goalProgress(activity(goal), sessions, ME, now);
  assert.equal(progress.current, 3);
  assert.equal(progress.fraction, 0.75);
  assert.equal(goalProgress(activity(goal), sessions.slice(1), ME, now).current, 2);
});

test("no goal, a null goal or a target of zero gives null", () => {
  const now = new Date(2026, 8, 30, 12, 0);
  const sessions = [span(new Date(2026, 8, 30, 11, 0), null)];
  const base = activity(null);
  assert.equal(goalProgress(base, sessions, ME, now), null);
  assert.equal(goalProgress({ ...base, goal: undefined }, sessions, ME, now), null);
  assert.equal(goalProgress(activity({ type: "duration", seconds: 0 }), sessions, ME, now), null);
  assert.equal(goalProgress(activity({ type: "count", count: -1 }), sessions, ME, now), null);
  assert.equal(goalProgress(activity({ type: "duration", seconds: 60 }, "day", "point"), sessions, ME, now), null);
});
