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
    pinned: false,
    placedBy: null,
    progress: { type: "duration", seconds: 0 },
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

const PAUSE = { kind: "pause-resume" };
const STOP = { kind: "stop-unpin" };

/* ---- resolveGesture: what an action does, as the wall shows things ---- */

test("the adaptive actions act on the session the wall shows, else on the pin, else do nothing", () => {
  const work = activity("work");
  const guitar = activity("guitar", { pinned: true });
  const session = live("s1", "work", new Date(1000));

  assert.deepEqual(resolveGesture(PAUSE, [work, guitar], [session], [ME]), {
    kind: "pause",
    sessionId: "s1",
    activityId: "work",
    placedBy: ME,
  });
  assert.deepEqual(resolveGesture(STOP, [work, guitar], [session], [ME]), {
    kind: "stop",
    sessionId: "s1",
    activityId: "work",
  });
  assert.deepEqual(resolveGesture(PAUSE, [work, guitar], [], [ME]), {
    kind: "track",
    activityId: "guitar",
    members: [ME],
  });
  assert.deepEqual(resolveGesture(STOP, [work, guitar], [], [ME]), { kind: "unpin", activityId: "guitar" });
  assert.equal(resolveGesture(PAUSE, [work], [], [ME]), null);
  assert.equal(resolveGesture(STOP, [work], [], [ME]), null);
  assert.equal(resolveGesture(undefined, [work, guitar], [session], [ME]), null);
});

test("the adaptive actions pick the newest live span the member the wall follows is in, then the pin", () => {
  const a = activity("a");
  const b = activity("b", { pinned: true });
  const older = live("old", "a", new Date(1000));
  const newer = live("new", "b", new Date(2000));
  const theirs = live("theirs", "a", new Date(3000), [THEM]);
  const sessions = [older, newer, theirs];
  assert.equal(resolveGesture(STOP, [a, b], sessions, [ME])?.sessionId, "new", "not a session only others are in");
  assert.equal(resolveGesture(STOP, [a, b], sessions, [THEM])?.sessionId, "theirs");
  assert.equal(resolveGesture(PAUSE, [a, b], [older, newer], [ME])?.sessionId, "new");
  const unpin = { kind: "unpin", activityId: "b" };
  assert.deepEqual(resolveGesture(STOP, [a, b], [theirs], [ME]), unpin, "only others live: the pin");
  const archivedPin = activity("c", { archived: true, pinned: true });
  assert.equal(resolveGesture(PAUSE, [archivedPin], [], [ME]), null, "an archived pin doesn't show");
});

test("start and pin act on the chosen activity whatever is going on, unless there is nothing to do", () => {
  const work = activity("work");
  const reading = activity("reading");
  const vitamins = activity("vitamins", { trackingType: "point" });
  const session = live("s1", "work", new Date(1000));

  assert.deepEqual(
    resolveGesture({ kind: "start", activityId: "reading" }, [work, reading], [session], [ME]),
    { kind: "track", activityId: "reading", members: [ME] },
    "alongside what's live, as core starts a second session",
  );
  assert.equal(resolveGesture({ kind: "start", activityId: "work" }, [work], [session], [ME]), null, "already in it");
  assert.deepEqual(resolveGesture({ kind: "start", activityId: "vitamins" }, [vitamins], [], [ME]), {
    kind: "track",
    activityId: "vitamins",
    members: [ME],
  });
  assert.deepEqual(resolveGesture({ kind: "pin", activityId: "reading" }, [work, reading], [session], [ME]), {
    kind: "pin",
    activityId: "reading",
    placedBy: ME,
  });
  const pinned = activity("reading", { pinned: true });
  assert.equal(resolveGesture({ kind: "pin", activityId: "reading" }, [pinned], [], [ME]), null, "already pinned");
  assert.equal(resolveGesture({ kind: "start", activityId: "gone" }, [work], [], [ME]), null);
  const archived = activity("old", { archived: true });
  assert.equal(resolveGesture({ kind: "pin", activityId: "old" }, [archived], [], [ME]), null);
});

/* ---- Who a gesture is for ---- */

const START_WORK = { kind: "start", activityId: "work" };

test("a start does nothing when the member followed is in a running span of it; else it starts for them", () => {
  const work = activity("work");
  const forMe = { kind: "track", activityId: "work", members: [ME] };
  const shared = live("s1", "work", new Date(1000), [ME, THEM]);
  assert.equal(resolveGesture(START_WORK, [work], [shared], [ME]), null, "in it with someone else");
  const others = live("s3", "work", new Date(1000), [THEM]);
  assert.deepEqual(resolveGesture(START_WORK, [work], [others], [ME]), forMe, "a span only others are in");
  const left = { ...shared, currentMemberIds: [THEM] };
  assert.deepEqual(resolveGesture(START_WORK, [work], [left], [ME]), forMe, "who is in it now counts");
  const ended = { ...shared, status: "completed", currentMemberIds: [] };
  assert.deepEqual(resolveGesture(START_WORK, [work], [ended], [ME]), forMe, "an ended span");
  const point = activity("vitamins", { trackingType: "point" });
  const marked = { ...shared, id: "p1", activityId: "vitamins", type: "point", status: "completed" };
  assert.deepEqual(resolveGesture({ kind: "start", activityId: "vitamins" }, [point], [marked], [ME]), {
    kind: "track",
    activityId: "vitamins",
    members: [ME],
  });
});

test("resume starts the pin for the member followed, whoever placed it", () => {
  const guitar = activity("guitar", { pinned: true, placedBy: THEM });
  assert.deepEqual(resolveGesture(PAUSE, [guitar], [], [ME]), { kind: "track", activityId: "guitar", members: [ME] });
  const bySchedule = activity("guitar", { pinned: true, placedBy: null });
  assert.deepEqual(resolveGesture(PAUSE, [bySchedule], [], [THEM]), {
    kind: "track",
    activityId: "guitar",
    members: [THEM],
  });
});

test("a pause or pin is placed by the member followed, whoever else is in the session", () => {
  const work = activity("work");
  const reading = activity("reading");
  const session = live("s1", "work", new Date(1000), [ME, THEM]);
  const PIN = { kind: "pin", activityId: "reading" };
  assert.equal(resolveGesture(PAUSE, [work], [session], [THEM]).placedBy, THEM);
  assert.equal(resolveGesture(PAUSE, [work], [session], [ME]).placedBy, ME);
  assert.equal(resolveGesture(PIN, [work, reading], [], [ME]).placedBy, ME);
  assert.equal(resolveGesture(PIN, [work, reading], [], [THEM]).placedBy, THEM);
});

test("following nobody: the wall shows no session, and a start or resume names nobody", () => {
  const work = activity("work");
  const guitar = activity("guitar", { pinned: true });
  const session = live("s1", "work", new Date(1000));
  assert.deepEqual(resolveGesture(PAUSE, [work, guitar], [session], []), {
    kind: "track",
    activityId: "guitar",
    members: [],
  });
  const nobody = { kind: "track", activityId: "work", members: [] };
  assert.deepEqual(resolveGesture(START_WORK, [work], [session], []), nobody);
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

/** A gestures handler over plain data, recording what it was asked to do (with who a step is for or placed by). */
function harness({ settings = {}, activities = [], sessions = [], following = [ME], drafting = false, act } = {}) {
  const calls = [];
  const logs = [];
  const record =
    (kind) =>
    (id, who) => {
      calls.push(who === undefined ? [kind, id] : [kind, id, who]);
      return act ? act(kind, id) : Promise.resolve();
    };
  const state = { drafting, settings, following, data: () => ({ activities, sessions }) };
  const onGesture = createGestures({
    following: () => state.following,
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
    ["pause", "s1", ME],
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
  assert.deepEqual(drafting.calls, [["pause", "s1", ME]]);
});

test("main does one gesture at a time: one that arrives meanwhile is dropped", async () => {
  const guitar = activity("guitar", { pinned: true });
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
  assert.deepEqual(h.calls, [["track", "guitar", [ME]]], "the second resume never ran");
  finish();
  await first;
  await h.onGesture("swipe-down");
  assert.deepEqual(h.calls.at(-1), ["unpin", "guitar"], "free again once the first was done");
});

test("main says a point activity was marked done, not started", async () => {
  const vitamins = activity("vitamins", { name: "Take vitamins", trackingType: "point", pinned: true });
  const h = harness({ activities: [vitamins] });
  await h.onGesture("double-tap");
  assert.deepEqual(h.calls, [["track", "vitamins", [ME]]]);
  assert.equal(h.logs[0][1], "double-tap: marked Take vitamins done");
});

test("main logs an action the app refuses, and keeps going", async () => {
  const guitar = activity("guitar", { pinned: true });
  const h = harness({ activities: [guitar], act: () => Promise.reject(new Error("nope")) });
  await h.onGesture("swipe-down");
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0][0], "warn");
  assert.equal(h.logs[0][1], "swipe-down: couldn't unpin guitar");
  await h.onGesture("double-tap");
  assert.equal(h.calls.length, 2, "not stuck busy");
});

test("a gesture after gestures were switched off, or tap to order began, mid-action does nothing", async () => {
  const guitar = activity("guitar", { pinned: true });
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
  h.state.data = () => ({ activities: [activity("g", { pinned: true })], sessions: [] });
  await h.onGesture("double-tap");
  assert.deepEqual(h.calls, [["track", "g", [ME]]], "not left busy");
});

test("main reads who the wall follows at each gesture", async () => {
  const guitar = activity("guitar", { pinned: true });
  const h = harness({
    settings: { gestureActions: { tap: { kind: "pin", activityId: "reading" }, "double-tap": PAUSE } },
    activities: [guitar, activity("reading")],
  });
  await h.onGesture("double-tap");
  h.state.following = [THEM];
  await h.onGesture("double-tap");
  await h.onGesture("tap");
  assert.deepEqual(h.calls, [
    ["track", "guitar", [ME]],
    ["track", "guitar", [THEM]],
    ["pin", "reading", THEM],
  ]);
});

test("following nobody, a start or resume does nothing and logs one warning", async () => {
  const work = activity("work", { name: "Deep work" });
  const guitar = activity("guitar", { name: "Guitar", pinned: true });
  const h = harness({
    settings: { gestureActions: { tap: START_WORK, "double-tap": PAUSE } },
    activities: [work, guitar],
    following: [],
  });
  await h.onGesture("tap");
  await h.onGesture("double-tap");
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.logs, [
    ["warn", "tap: didn't start Deep work: Drift Beacon sent no workspace members, so nobody can be named"],
    ["warn", "double-tap: didn't start Guitar: Drift Beacon sent no workspace members, so nobody can be named"],
  ]);
});

/* ---- Through the SDK (main/src/index.ts) ---- */

test("through the SDK, a start names its members and a pause or pin who placed it", async () => {
  const { gestureActions } = await import("../main/src/index.ts");
  const calls = [];
  const ctx = {
    activities: {
      get: (id) =>
        id === "work"
          ? {
              track: async (options) => {
                calls.push(["track", id, options]);
                return { id: "w1" };
              },
            }
          : undefined,
      pin: async (id, options) => void calls.push(["pin", id, options]),
    },
    sessions: { pause: async (id, options) => void calls.push(["pause", id, options]) },
  };
  const actions = gestureActions(ctx);
  await actions.track("work", [THEM]);
  await actions.pause("s1", THEM);
  await actions.pin("work", ME);
  await actions.pin("work", null);
  assert.deepEqual(calls, [
    ["track", "work", { members: [THEM] }],
    ["pause", "s1", { placedBy: THEM }],
    ["pin", "work", { placedBy: ME }],
    ["pin", "work", { placedBy: null }],
  ]);
  await assert.rejects(actions.track("gone", [ME]), { code: "not-found" });
});

test("a Drift Beacon that sends no members: the wall follows nobody, a start sends nothing and warns", async () => {
  const { followingOf, workspaceData } = await import("../main/src/index.ts");
  const work = activity("work", { name: "Deep work" });
  const stored = { zones: undefined };
  // No `members` key, as from a hub before `ctx.members`.
  const ctx = {
    storage: { get: (key) => stored[key] },
    activities: { list: () => [{ data: work }] },
    sessions: { list: () => [] },
  };
  const following = followingOf(ctx);
  assert.deepEqual(following(), [], "nothing stored");
  stored.zones = [{ id: "wall", member: THEM }];
  assert.deepEqual(following(), [], `zone member ${THEM} stored`);
  const data = workspaceData(ctx);
  assert.deepEqual(data().members, []);

  const calls = [];
  const logs = [];
  const onGesture = createGestures({
    following,
    settings: () => readSettings({ gestureActions: { tap: START_WORK } }),
    data,
    drafting: () => false,
    actions: { track: async (id, members) => void calls.push(["track", id, members]) },
    log: {
      info: (...args) => logs.push(["info", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
  });
  await onGesture("tap");
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, [
    ["warn", "tap: didn't start Deep work: Drift Beacon sent no workspace members, so nobody can be named"],
  ]);
});
