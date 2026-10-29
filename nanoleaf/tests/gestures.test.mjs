import assert from "node:assert/strict";
import { test } from "node:test";
import { createGestures } from "../main/src/gestures.ts";
import { resolveGesture } from "../shared/gestures.ts";
import { DEFAULT_SETTINGS, readGestureActions, readSettings } from "../shared/storage.ts";

const ME = "me";
const THEM = "them";

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
    pinnedBy: [],
    ...extra,
  };
}

function live(id, activityId, start, members = [ME]) {
  return { id, activityId, type: "span", status: "live", memberIds: members, startedAt: start, endedAt: null };
}

const PAUSE = { kind: "pause-resume" };
const STOP = { kind: "stop-unpin" };

/* ---- resolveGesture: what an action does, as the wall shows things ---- */

test("the adaptive actions act on the live session, else on the pin, else do nothing", () => {
  const work = activity("work");
  const guitar = activity("guitar", { pinnedBy: [ME] });
  const session = live("s1", "work", new Date(1000));

  assert.deepEqual(resolveGesture(PAUSE, ME, [work, guitar], [session]), {
    kind: "pause",
    sessionId: "s1",
    activityId: "work",
  });
  assert.deepEqual(resolveGesture(STOP, ME, [work, guitar], [session]), {
    kind: "stop",
    sessionId: "s1",
    activityId: "work",
  });
  assert.deepEqual(resolveGesture(PAUSE, ME, [work, guitar], []), { kind: "track", activityId: "guitar" });
  assert.deepEqual(resolveGesture(STOP, ME, [work, guitar], []), { kind: "unpin", activityId: "guitar" });
  assert.equal(resolveGesture(PAUSE, ME, [work], []), null);
  assert.equal(resolveGesture(STOP, ME, [work], []), null);
  assert.equal(resolveGesture(undefined, ME, [work, guitar], [session]), null);
});

test("the adaptive actions pick what the wall shows: the newest live span of mine, and only my pin", () => {
  const a = activity("a");
  const b = activity("b", { pinnedBy: [THEM] });
  const older = live("old", "a", new Date(1000));
  const newer = live("new", "b", new Date(2000));
  const theirs = live("theirs", "a", new Date(3000), [THEM]);
  assert.equal(resolveGesture(STOP, ME, [a, b], [older, newer, theirs])?.sessionId, "new");
  assert.equal(resolveGesture(STOP, ME, [a, b], []), null, "someone else's pin is not mine to unpin");
  const archivedPin = activity("c", { archived: true, pinnedBy: [ME] });
  assert.equal(resolveGesture(PAUSE, ME, [archivedPin], []), null, "an archived pin doesn't show");
});

test("start and pin act on the chosen activity whatever is going on, unless there is nothing to do", () => {
  const work = activity("work");
  const reading = activity("reading");
  const vitamins = activity("vitamins", { trackingType: "point" });
  const session = live("s1", "work", new Date(1000));

  assert.deepEqual(
    resolveGesture({ kind: "start", activityId: "reading" }, ME, [work, reading], [session]),
    { kind: "track", activityId: "reading" },
    "alongside what's live, as core starts a second session",
  );
  assert.equal(resolveGesture({ kind: "start", activityId: "work" }, ME, [work], [session]), null, "already live");
  assert.deepEqual(resolveGesture({ kind: "start", activityId: "vitamins" }, ME, [vitamins], []), {
    kind: "track",
    activityId: "vitamins",
  });
  assert.deepEqual(resolveGesture({ kind: "pin", activityId: "reading" }, ME, [work, reading], [session]), {
    kind: "pin",
    activityId: "reading",
  });
  const pinned = activity("reading", { pinnedBy: [ME] });
  assert.equal(resolveGesture({ kind: "pin", activityId: "reading" }, ME, [pinned], []), null, "already pinned");
  assert.equal(resolveGesture({ kind: "start", activityId: "gone" }, ME, [work], []), null);
  const archived = activity("old", { archived: true });
  assert.equal(resolveGesture({ kind: "pin", activityId: "old" }, ME, [archived], []), null);
});

/* ---- Settings: what storage may hold ---- */

test("gesture settings default to on, with the two adaptive actions", () => {
  assert.equal(DEFAULT_SETTINGS.gestures, true);
  assert.deepEqual(readSettings({}).gestureActions, { "double-tap": PAUSE, "swipe-down": STOP });
});

test("readGestureActions keeps known gestures and actions, and an activity's id", () => {
  assert.deepEqual(
    readGestureActions({
      tap: { kind: "start", activityId: " reading " },
      "double-tap": PAUSE,
      "swipe-up": { kind: "pin", activityId: "" },
      "swipe-down": { kind: "explode" },
      "swipe-left": { kind: "start" },
      "swipe-right": "pause-resume",
      pinch: STOP,
      __proto__: { tap: STOP },
    }),
    { tap: { kind: "start", activityId: "reading" }, "double-tap": PAUSE },
  );
  for (const bad of [null, 1, "x", [], true]) assert.deepEqual(readGestureActions(bad), {});
  assert.deepEqual(readSettings({ gestureActions: {} }).gestureActions, {}, "cleared stays cleared");
  assert.deepEqual(readSettings({ gestureActions: "x" }).gestureActions, {});
});

/* ---- Main: acting on a gesture ---- */

/** A gestures handler over plain data, recording what it was asked to do. */
function harness({ settings = {}, activities = [], sessions = [], drafting = false, act } = {}) {
  const calls = [];
  const logs = [];
  const record =
    (kind) =>
    (id) => {
      calls.push([kind, id]);
      return act ? act(kind, id) : Promise.resolve();
    };
  const state = { drafting, settings, data: () => ({ activities, sessions }) };
  const onGesture = createGestures({
    userId: ME,
    settings: () => readSettings({ ...state.settings }),
    data: () => state.data(),
    drafting: () => state.drafting,
    actions: {
      pause: record("pause"),
      stop: record("stop"),
      track: record("track"),
      pin: record("pin"),
      unpin: record("unpin"),
    },
    log: {
      info: (...args) => logs.push(["info", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
  });
  return { onGesture, calls, logs, state };
}

test("main does what the gesture's action resolves to, and logs it", async () => {
  const work = activity("work", { name: "Deep work" });
  const h = harness({ activities: [work], sessions: [live("s1", "work", new Date(1000))] });
  await h.onGesture("double-tap");
  await h.onGesture("swipe-down");
  await h.onGesture("tap");
  assert.deepEqual(h.calls, [
    ["pause", "s1"],
    ["stop", "s1"],
  ]);
  assert.deepEqual(
    h.logs.map(([level, message]) => [level, message]),
    [
      ["info", "double-tap: paused Deep work"],
      ["info", "swipe-down: stopped Deep work"],
    ],
  );
});

test("main leaves the workspace alone while gestures are off or tap to order holds the wall", async () => {
  const work = activity("work");
  const sessions = [live("s1", "work", new Date(1000))];
  const off = harness({ settings: { gestures: false }, activities: [work], sessions });
  await off.onGesture("swipe-down");
  assert.deepEqual(off.calls, []);

  const drafting = harness({ activities: [work], sessions, drafting: true });
  await drafting.onGesture("double-tap");
  assert.deepEqual(drafting.calls, [], "taps are numbering panels");
  drafting.state.drafting = false;
  await drafting.onGesture("double-tap");
  assert.deepEqual(drafting.calls, [["pause", "s1"]]);
});

test("main does one gesture at a time: one that arrives meanwhile is dropped", async () => {
  const guitar = activity("guitar", { pinnedBy: [ME] });
  let finish;
  const h = harness({
    activities: [guitar],
    // The first action hangs until the test lets it finish; later ones are done at once.
    act: () =>
      finish
        ? Promise.resolve()
        : new Promise((resolve) => {
            finish = resolve;
          }),
  });
  const first = h.onGesture("double-tap");
  await h.onGesture("double-tap");
  assert.deepEqual(h.calls, [["track", "guitar"]], "the second resume never ran");
  finish();
  await first;
  await h.onGesture("swipe-down");
  assert.deepEqual(h.calls.at(-1), ["unpin", "guitar"], "free again once the first was done");
});

test("main says a point activity was marked done, not started", async () => {
  const vitamins = activity("vitamins", { name: "Take vitamins", trackingType: "point", pinnedBy: [ME] });
  const h = harness({ activities: [vitamins] });
  await h.onGesture("double-tap");
  assert.deepEqual(h.calls, [["track", "vitamins"]]);
  assert.equal(h.logs[0][1], "double-tap: marked Take vitamins done");
});

test("main logs an action the app refuses, and keeps going", async () => {
  const guitar = activity("guitar", { pinnedBy: [ME] });
  const h = harness({ activities: [guitar], act: () => Promise.reject(new Error("nope")) });
  await h.onGesture("swipe-down");
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0][0], "warn");
  assert.equal(h.logs[0][1], "swipe-down: couldn't unpin guitar");
  await h.onGesture("double-tap");
  assert.equal(h.calls.length, 2, "not stuck busy");
});

test("a gesture after gestures were switched off, or tap to order began, mid-action does nothing", async () => {
  const guitar = activity("guitar", { pinnedBy: [ME] });
  let finish;
  const h = harness({
    activities: [guitar],
    act: () =>
      finish
        ? Promise.resolve()
        : new Promise((resolve) => {
            finish = resolve;
          }),
  });
  const first = h.onGesture("swipe-down");
  h.state.settings = { gestures: false };
  finish();
  await first;
  await h.onGesture("swipe-down");
  assert.deepEqual(h.calls, [["unpin", "guitar"]], "off since the first began");

  h.state.settings = {};
  h.state.drafting = true;
  await h.onGesture("swipe-down");
  assert.equal(h.calls.length, 1, "numbering since");
});

test("a failure before any action, reading what's going on, is logged and never thrown", async () => {
  const h = harness();
  h.state.data = () => {
    throw new Error("mid-sync");
  };
  await h.onGesture("double-tap");
  assert.deepEqual(
    h.logs.map(([level, message]) => [level, message]),
    [["warn", "double-tap: couldn't act on it"]],
  );
  h.state.data = () => ({ activities: [activity("g", { pinnedBy: [ME] })], sessions: [] });
  await h.onGesture("double-tap");
  assert.deepEqual(h.calls, [["track", "g"]], "not left busy");
});
