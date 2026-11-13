import assert from "node:assert/strict";
import { test } from "node:test";
import { WARM_WHITE } from "../shared/color.ts";
import { decideScene, describeProgress, formatDuration, OFF_SCENE, progressPercent } from "../shared/scene.ts";

const ME = "me";
const THEM = "them";
const NOW = new Date(2026, 8, 30, 10, 0);

const SETTINGS = Object.freeze({
  enabled: true,
  maxBrightness: 80,
  pinnedStyle: "pulse",
  pinnedBrightness: 28,
  pinnedProgress: true,
  track: true,
  scheduleAlert: true,
  idle: "restore",
  viewRotation: 0,
});

function activity(id, extra = {}) {
  return {
    id,
    name: id,
    trackingType: "span",
    color: "#7c3aed",
    iconPath: null,
    archived: false,
    goal: null,
    period: "day",
    pinned: false,
    placedBy: null,
    progress: extra.goal?.type === "count" ? { type: "count", count: 0 } : { type: "duration", seconds: 0 },
    ...extra,
  };
}

function live(id, activityId, start, members = [ME]) {
  return {
    id,
    activityId,
    type: "span",
    status: "live",
    memberIds: members,
    currentMemberIds: members,
    startedAt: start,
    endedAt: null,
  };
}

function scene(input) {
  return decideScene({ activities: [], sessions: [], following: [ME], settings: SETTINGS, now: NOW, ...input });
}

test("OFF_SCENE is the frozen off scene", () => {
  assert.deepEqual(OFF_SCENE, {
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
  assert.ok(Object.isFrozen(OFF_SCENE));
});

test("disabled gives off, even with a live session", () => {
  const activities = [activity("a")];
  const sessions = [live("s1", "a", new Date(2026, 8, 30, 9, 0))];
  assert.equal(scene({ activities, sessions, settings: { ...SETTINGS, enabled: false } }), OFF_SCENE);
});

test("nothing live or pinned gives off", () => {
  assert.equal(scene({ activities: [activity("a")] }), OFF_SCENE);
});

test("live beats pinned, at full level with the activity's LED colour and goal progress", () => {
  const activities = [
    activity("pin", { pinned: true }),
    activity("a", { color: "rgb(0 0 128)", goal: { type: "duration", seconds: 3600 } }),
  ];
  const sessions = [live("s1", "a", new Date(2026, 8, 30, 9, 30))];
  assert.deepEqual(scene({ activities, sessions }), {
    kind: "live",
    key: "live:s1",
    activityId: "a",
    cssColor: "rgb(0 0 128)",
    rgb: [0, 0, 255],
    progress: { goal: { type: "duration", seconds: 3600 }, period: "day", current: 1800, target: 3600, fraction: 0.5 },
    level: 1,
    style: "glow",
    track: true,
  });
  assert.equal(scene({ activities, sessions, settings: { ...SETTINGS, track: false } }).track, false);
});

test("the newest live span the member the wall follows is in wins; missing activities are skipped", () => {
  const activities = [activity("a"), activity("b"), activity("c")];
  const sessions = [
    live("gone", "deleted", new Date(2026, 8, 30, 9, 58)),
    live("theirs", "c", new Date(2026, 8, 30, 9, 55), [THEM]),
    live("older", "a", new Date(2026, 8, 30, 8, 0)),
    live("newer", "b", new Date(2026, 8, 30, 9, 0)),
  ];
  const result = scene({ activities, sessions });
  assert.equal(result.key, "live:newer", "a newer session they aren't in doesn't light the wall");
  assert.equal(result.activityId, "b");
  assert.equal(result.progress, null, "no goal, no progress");
  assert.equal(scene({ activities, sessions, following: [THEM] }).key, "live:theirs");
  assert.equal(scene({ activities, sessions: sessions.slice(0, 2) }), OFF_SCENE);
  assert.equal(scene({ activities, sessions, following: [] }), OFF_SCENE, "following nobody");
});

test("who is in a span now counts: not someone who left it, nor a span nobody is in, a point or an ended one", () => {
  const activities = [activity("a")];
  const left = { ...live("s0", "a", new Date(2026, 8, 30, 9, 0), [THEM]), memberIds: [ME, THEM] };
  assert.equal(scene({ activities, sessions: [left] }), OFF_SCENE, "they left it");
  const nobody = live("s1", "a", new Date(2026, 8, 30, 9, 0), []);
  assert.equal(scene({ activities, sessions: [nobody] }), OFF_SCENE);
  const shared = live("s2", "a", new Date(2026, 8, 30, 9, 0), [THEM, ME]);
  assert.equal(scene({ activities, sessions: [shared] }).key, "live:s2");
  const completed = { ...shared, status: "completed", currentMemberIds: [], endedAt: new Date(2026, 8, 30, 9, 30) };
  assert.equal(scene({ activities, sessions: [completed] }), OFF_SCENE);
  const point = { ...shared, type: "point", status: "completed", currentMemberIds: [] };
  assert.equal(scene({ activities, sessions: [point] }), OFF_SCENE);
});

test("the shown span's goal progress is the activity's progress plus that span only", () => {
  const goal = { type: "duration", seconds: 3600 };
  const activities = [activity("a", { goal, progress: { type: "duration", seconds: 600 } })];
  const sessions = [
    live("mine", "a", new Date(2026, 8, 30, 9, 0)),
    live("theirs", "a", new Date(2026, 8, 30, 9, 40), [THEM]),
  ];
  const shared = { ...sessions[1], memberIds: [THEM, ME], currentMemberIds: [THEM, ME] };
  const result = scene({ activities, sessions: [sessions[0], shared], following: [ME] });
  assert.equal(result.key, "live:theirs");
  assert.equal(result.progress.current, 600 + 20 * 60, "only the span the wall shows adds, not every live one");
});

test("pinned: the first non-archived pin of the workspace, at the pinned level and style", () => {
  const activities = [
    activity("archived", { archived: true, pinned: true }),
    activity("unpinned"),
    activity("mine", {
      pinned: true,
      placedBy: THEM,
      color: "gold",
      goal: { type: "count", count: 4 },
      progress: { type: "count", count: 1 },
    }),
    activity("second", { pinned: true }),
  ];
  const sessions = [];
  const result = scene({ activities, sessions });
  assert.deepEqual(result, {
    kind: "pinned",
    key: "pinned:mine",
    activityId: "mine",
    cssColor: "gold",
    rgb: [255, 215, 0],
    progress: { goal: { type: "count", count: 4 }, period: "day", current: 1, target: 4, fraction: 0.25 },
    level: 1,
    style: "pulse",
    track: true,
  });
  // A pin's level is 1 whatever its brightness: main dims it on the wall (`pinnedBrightness`), not the frames.
  const glow = scene({ activities, sessions, settings: { ...SETTINGS, pinnedStyle: "glow", pinnedBrightness: 80 } });
  assert.equal(glow.style, "glow");
  assert.equal(glow.level, 1);
});

test("an archived activity's live session still glows (as core's live slot shows it); its pin is ignored", () => {
  const goal = { type: "duration", seconds: 3600 };
  const activities = [
    activity("old", { archived: true, pinned: true, color: "#ff0000", goal }),
    activity("pin", { pinned: true }),
  ];
  const sessions = [live("s1", "old", new Date(2026, 8, 30, 9, 30))];
  const result = scene({ activities, sessions });
  assert.equal(result.kind, "live");
  assert.equal(result.key, "live:s1");
  assert.equal(result.activityId, "old");
  assert.deepEqual(result.rgb, [255, 0, 0]);
  assert.equal(result.progress.fraction, 0.5);
  // Without the session, the archived pin is skipped for the next one.
  assert.equal(scene({ activities }).key, "pinned:pin");
  assert.equal(scene({ activities: activities.slice(0, 1) }), OFF_SCENE);
});

test("pinnedProgress off drops the pinned scene's progress, but not a live one's", () => {
  const goal = { type: "duration", seconds: 3600 };
  const settings = { ...SETTINGS, pinnedProgress: false };
  const pinned = [activity("a", { pinned: true, goal })];
  assert.equal(scene({ activities: pinned, settings }).progress, null);
  const sessions = [live("s1", "a", new Date(2026, 8, 30, 9, 30))];
  assert.equal(scene({ activities: pinned, sessions, settings }).progress.fraction, 0.5);
});

test("colours: unparseable becomes warm white, black becomes warm white, and now may be epoch ms", () => {
  const sessions = [live("s1", "a", new Date(2026, 8, 30, 9, 30))];
  assert.deepEqual(scene({ activities: [activity("a", { color: "var(--x)" })], sessions }).rgb, WARM_WHITE);
  assert.deepEqual(scene({ activities: [activity("a", { color: "#000" })], sessions }).rgb, WARM_WHITE);
  const goal = { type: "duration", seconds: 3600 };
  const byMs = scene({ activities: [activity("a", { goal })], sessions, now: NOW.getTime() });
  assert.equal(byMs.progress.current, 1800);
});

test("an older app without goals or pins still glows for a live session", () => {
  const old = { id: "a", name: "a", trackingType: "span", color: "#ff0000", iconPath: null, archived: false };
  const sessions = [live("s1", "a", new Date(2026, 8, 30, 9, 30))];
  const result = scene({ activities: [old], sessions });
  assert.equal(result.kind, "live");
  assert.equal(result.progress, null);
  assert.equal(scene({ activities: [old] }), OFF_SCENE);
});

test("formatDuration is compact", () => {
  assert.equal(formatDuration(0), "0 s");
  assert.equal(formatDuration(45.9), "45 s");
  assert.equal(formatDuration(60), "1 min");
  assert.equal(formatDuration(21 * 60 + 59), "21 min");
  assert.equal(formatDuration(3600), "1 h");
  assert.equal(formatDuration(3900), "1 h 5 min");
  assert.equal(formatDuration(99 * 3600), "99 h");
  assert.equal(formatDuration(-5), "0 s");
});

test("describeProgress gives the Now card's words", () => {
  const duration = { type: "duration", seconds: 3600 };
  assert.deepEqual(describeProgress({ goal: duration, period: "day", current: 1260, target: 3600, fraction: 0.35 }), {
    percent: 35,
    currentLabel: "21 min",
    targetLabel: "1 h",
    periodLabel: "today",
  });
  const count = { type: "count", count: 5 };
  assert.deepEqual(describeProgress({ goal: count, period: "week", current: 3, target: 5, fraction: 0.6 }), {
    percent: 60,
    currentLabel: "3",
    targetLabel: "5 times",
    periodLabel: "this week",
  });
  const once = { type: "count", count: 1 };
  const over = describeProgress({ goal: once, period: null, current: 2, target: 1, fraction: 2 });
  assert.deepEqual(over, { percent: 100, currentLabel: "2", targetLabel: "1 time", periodLabel: "in total" });
  const periods = ["month", "year"].map(
    (period) => describeProgress({ goal: count, period, current: 0, target: 5, fraction: 0 }).periodLabel,
  );
  assert.deepEqual(periods, ["this month", "this year"]);
  // Rounded like the app's progress button: 20 min 46 s of an hour reads 35%, as the app shows it.
  const almost = { goal: duration, period: "day", current: 1246, target: 3600, fraction: 1246 / 3600 };
  assert.equal(describeProgress(almost).percent, 35);
});

test("progressPercent rounds like the app and stops at 100", () => {
  // The app's SpanProgressButton: Math.min(100, Math.round(elapsed / target · 100)).
  const app = (fraction) => Math.min(100, Math.round(fraction * 100));
  for (let seconds = 0; seconds <= 3700; seconds += 1) {
    assert.equal(progressPercent(seconds / 3600), app(seconds / 3600), `${seconds} s of 1 h`);
  }
  assert.equal(progressPercent(0.3461), 35);
  assert.equal(progressPercent(0.994), 99);
  assert.equal(progressPercent(0.996), 100);
  assert.equal(progressPercent(1.4), 100);
  assert.equal(progressPercent(0), 0);
  assert.equal(progressPercent(-0.2), 0);
  assert.equal(progressPercent(Number.NaN), 0);
});

test("describeProgress counts sessions for a span activity's count goal, times for a point's", () => {
  const count = { type: "count", count: 5 };
  const progress = { goal: count, period: "week", current: 3, target: 5, fraction: 0.6 };
  assert.equal(describeProgress(progress, "span").targetLabel, "5 sessions");
  const once = { ...progress, goal: { type: "count", count: 1 }, target: 1 };
  assert.equal(describeProgress(once, "span").targetLabel, "1 session");
  assert.equal(describeProgress(progress, "point").targetLabel, "5 times");
  // Duration goals read the same whatever the activity tracks.
  const duration = { goal: { type: "duration", seconds: 3600 }, period: "day", current: 60, target: 3600, fraction: 0 };
  assert.equal(describeProgress(duration, "span").targetLabel, "1 h");
});
