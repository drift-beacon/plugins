/**
 * Zones end to end: the plugin's main code as Drift Beacon starts it (`startNanoleaf`, with a stand-in `ctx`), the
 * real Director, Controller, event stream, touch stream and frame stream, against the controller emulator. A wall split
 * between two members, each with panels.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { startNanoleaf } from "../main/src/index.ts";
import { deviceRgb } from "../shared/color.ts";
import { FADE_MS, STAGGER_MAX_MS } from "../shared/render.ts";
import { DEFAULT_SETTINGS } from "../shared/storage.ts";
import { zoneTag, ZONE_TAG_LEVEL } from "../shared/zones.ts";
import { startEmulator } from "../tools/fake-nanoleaf.mjs";

const OWNER = "u1";
const OTHER = "u2";
const MEMBERS = [
  { id: OWNER, name: "Owner", role: "OWNER" },
  { id: OTHER, name: "Other", role: "MEMBER" },
];
const PURPLE = "#7c3aed";
const GREEN = "#10b981";
const RED = "#ef4444";
const TOKEN = "tok";
const PAUSE = { kind: "pause-resume" };
const STOP = { kind: "stop-unpin" };
let serials = 0;

/** Waits until `predicate()` is truthy, polling every 10 ms. The limit is generous: a loaded machine is slow. */
async function until(predicate, what = "the condition", timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const activity = (id, color, extra = {}) => ({
  id,
  name: id,
  trackingType: "span",
  color,
  iconPath: null,
  archived: false,
  goal: null,
  period: null,
  pinned: false,
  placedBy: null,
  progress: { type: "duration", seconds: 0 },
  ...extra,
});

const live = (id, activityId, member, startedAt) => ({
  id,
  activityId,
  type: "span",
  status: "live",
  memberIds: [member],
  currentMemberIds: [member],
  startedAt: new Date(startedAt),
  endedAt: null,
});

/** A stand-in for the SDK's `MainContext`: what startNanoleaf uses, recording what the plugin does. */
function fakeContext({ storage, activities, sessions, members = MEMBERS }) {
  const store = new Map(Object.entries(storage));
  const storageListeners = [];
  const dataListeners = [];
  const scheduleListeners = [];
  const stops = [];
  const handlers = new Map();
  const posts = [];
  const states = new Map();
  const actions = [];
  const warnings = [];
  let activityModels = activities.map((data) => ({ data }));
  let sessionModels = sessions.map((data) => ({ data }));
  const ctx = {
    plugin: { id: "nanoleaf-dev" },
    workspace: { id: `w-${++serials}` },
    members,
    log: {
      info() {},
      warn: (message) => warnings.push(message),
      error: (message) => warnings.push(message),
    },
    storage: {
      get: (key) => store.get(key),
      set: async (key, value) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
        for (const fn of storageListeners) fn(key);
      },
      onChange: (fn) => void storageListeners.push(fn),
    },
    state: { set: (key, value) => void states.set(key, value), get: (key) => states.get(key) },
    events: { emit() {} },
    ui: {
      handle: (name, fn) => void handlers.set(name, fn),
      post: (name, payload) => void posts.push([name, payload]),
      clients: [],
      onClientsChange() {},
    },
    commands: { handle() {} },
    onStop: (fn) => void stops.push(fn),
    onDataChange: (fn) => void dataListeners.push(fn),
    schedules: { onTriggered: (fn) => void scheduleListeners.push(fn) },
    activities: {
      list: () => activityModels,
      get: (id) => ({ track: async ({ members: who }) => void actions.push(["track", id, who]) }),
      pin: async (id, { placedBy }) => void actions.push(["pin", id, placedBy]),
      unpin: async (id) => void actions.push(["unpin", id]),
    },
    sessions: {
      list: () => sessionModels,
      pause: async (id, { placedBy }) => void actions.push(["pause", id, placedBy]),
      end: async (id) => void actions.push(["stop", id]),
    },
  };
  return {
    ctx,
    store,
    posts,
    states,
    actions,
    warnings,
    request: (name, input) => handlers.get(name)(input, { client: { id: "copy-1" } }),
    schedule: (trigger) => {
      for (const fn of scheduleListeners) fn({ id: "t", scheduleId: "s", kind: "once", ...trigger });
    },
    setData: (next) => {
      if (next.activities) activityModels = next.activities.map((data) => ({ data }));
      if (next.sessions) sessionModels = next.sessions.map((data) => ({ data }));
      for (const fn of dataListeners) fn();
    },
    stop: async () => {
      for (const fn of stops) await fn();
    },
  };
}

/**
 * An emulator and the plugin driving it. `zones(panels)` gives the stored zones for the emulator's light panels
 * (ascending); the plugin starts paired to the emulator and connects at once.
 */
async function run(t, { zones, activities, sessions, settings = {} }) {
  const serialNo = `ZONES${++serials}`;
  const emu = await startEmulator({ port: 0, wallPort: null, udpPort: 0, quiet: true, serialNo, tokens: [TOKEN] });
  t.after(() => emu.close());
  const panels = [...emu.lights().keys()].sort((a, b) => a - b);
  const half = Math.floor(panels.length / 2);
  const mine = panels.slice(0, half);
  const theirs = panels.slice(half);
  const fake = fakeContext({
    storage: {
      controller: { host: "127.0.0.1", port: emu.port, token: TOKEN },
      settings: {
        ...DEFAULT_SETTINGS,
        gestureActions: { tap: PAUSE, "double-tap": PAUSE, "swipe-down": STOP },
        ...settings,
      },
      zones: zones({ mine, theirs }),
    },
    activities,
    sessions,
  });
  startNanoleaf(fake.ctx, { streamPort: emu.udpPort, requestTimeoutMs: 2000 });
  t.after(() => fake.stop());
  return { emu, fake, panels, mine, theirs };
}

const SPLIT = ({ mine, theirs }) => [
  { id: "wall", member: OWNER, panels: mine },
  { id: "z2", member: OTHER, panels: theirs },
];

/** The channel a colour is brightest in: 0 red, 1 green, 2 blue. */
const top = (rgb) => rgb.indexOf(Math.max(...rgb));
const settled = (emu) => emu.lights({ settled: true });
/** The `gestureZone` messages posted so far: [gesture, zoneId]. */
const gestureZones = (fake) =>
  fake.posts.filter(([name]) => name === "gestureZone").map(([, { gesture, zoneId }]) => [gesture, zoneId]);
const allTop = (emu, ids, channel) => ids.every((id) => top(settled(emu).get(id).rgb) === channel);

test("a split wall through the emulator: own panels, own taps and swipes, own schedules, tags and output", async (t) => {
  const now = Date.now();
  const { emu, fake, mine, theirs } = await run(t, {
    zones: SPLIT,
    activities: [activity("a1", PURPLE), activity("a2", GREEN), activity("a3", RED)],
    sessions: [live("s1", "a1", OWNER, now - 120_000), live("s2", "a2", OTHER, now - 60_000)],
  });

  // Each member's session lights only their own panels, in its activity's colour.
  await until(() => emu.effect() === "*ExtControl*", "the takeover");
  await until(() => allTop(emu, mine, 2) && allTop(emu, theirs, 1), "purple in my zone, green in theirs");
  assert.equal(fake.states.get("output").mode, "live");
  assert.equal(fake.states.get("output").activityId, "a2", "output speaks for the newest session");
  assert.deepEqual(await fake.request("touchStream"), { heard: false }, "nothing heard yet");

  // A tap in each zone acts for that zone's member, on the session that zone shows.
  emu.touch(mine[0], "tap");
  await until(() => fake.actions.length === 1, "the tap in my zone");
  assert.deepEqual(fake.actions[0], ["pause", "s1", OWNER]);
  emu.touch(theirs[0], "tap");
  await until(() => fake.actions.length === 2, "the tap in theirs");
  assert.deepEqual(fake.actions[1], ["pause", "s2", OTHER]);
  // The taps carried touch stream packets: the stream has been heard, and every copy was told.
  assert.deepEqual(await fake.request("touchStream"), { heard: true });
  assert.deepEqual(
    fake.posts.filter(([name]) => name === "touchStream"),
    [["touchStream", { heard: true }]],
  );

  // A swipe the touch stream places acts in its zone; one it doesn't place does nothing on a split wall.
  emu.touch(-1, "swipe-down", { panels: [theirs[1], theirs[0]] });
  await until(() => fake.actions.length === 3, "the placed swipe");
  assert.deepEqual(fake.actions[2], ["stop", "s2"]);
  emu.touch(-1, "swipe-down");
  // Nothing happening has no event to wait for: give it well over the swipe's grace (120 ms) to act, then check it
  // didn't. The placed swipe after it shows the wall still takes gestures.
  await sleep(500);
  assert.equal(fake.actions.length, 3, "a swipe without touch data acts nowhere on a split wall");
  emu.touch(-1, "swipe-down", { panels: [mine[0], mine[1]] });
  await until(() => fake.actions.length === 4, "a placed swipe in my zone");
  assert.deepEqual(fake.actions[3], ["stop", "s1"]);
  // Every open copy was told where each gesture acted: the swipe nothing placed acted in no zone.
  await until(() => gestureZones(fake).length === 5, "a gestureZone message per gesture");
  assert.deepEqual(gestureZones(fake), [
    ["tap", "wall"],
    ["tap", "z2"],
    ["swipe-down", "z2"],
    ["swipe-down", null],
    ["swipe-down", "wall"],
  ]);

  // A schedule for one member flashes only their zone (red at its peaks), and mine stays purple.
  fake.schedule({ activityId: "a3", members: [OTHER], behavior: "pin" });
  // The alert lasts about 2.3 s, so a longer wait couldn't see it anyway.
  await until(() => allTop(emu, theirs, 0), "the alert in their zone", 2300);
  assert.ok(allTop(emu, mine, 2), "my zone doesn't flash");
  await until(() => allTop(emu, theirs, 1), "their zone back after the alert");
  // Again nothing to wait for: watch the wall for longer than an alert's first peak (450 ms) and see none.
  fake.schedule({ activityId: "a3", members: ["nobody"], behavior: "pin" });
  for (let i = 0; i < 24; i++) {
    assert.ok(allTop(emu, mine, 2) && allTop(emu, theirs, 1), "a schedule for nobody here flashes nothing");
    await sleep(50);
  }

  // The zone-editing preview: every zone in its tag colour.
  assert.deepEqual(fake.request("preview", { mode: "zones", ttlMs: 10_000 }), { shown: true });
  const tag = (position) => deviceRgb({ rgb: zoneTag(position), level: ZONE_TAG_LEVEL });
  await until(
    () =>
      mine.every((id) => String(settled(emu).get(id).rgb) === String(tag(0))) &&
      theirs.every((id) => String(settled(emu).get(id).rgb) === String(tag(1))),
    "the zone tags",
  );
  fake.request("preview", { mode: "none" });
  await until(() => allTop(emu, mine, 2) && allTop(emu, theirs, 1), "the sessions again");
});

test("a pin beside a session: the controller at Session brightness, the pin's zone scaled down", async (t) => {
  const { emu, mine, theirs } = await run(t, {
    zones: SPLIT,
    activities: [activity("a1", PURPLE), activity("a2", GREEN, { pinned: true })],
    sessions: [live("s1", "a1", OWNER, Date.now() - 60_000)],
    settings: { maxBrightness: 80, pinnedBrightness: 20, pinnedStyle: "glow" },
  });
  await until(() => emu.effect() === "*ExtControl*", "the takeover");
  const takenAt = Date.now();
  await until(() => allTop(emu, mine, 2) && allTop(emu, theirs, 1), "my session and the pin beside it");
  await until(() => emu.brightness() === 80, "Session brightness");
  const brightest = (ids) => Math.max(...ids.map((id) => Math.max(...settled(emu).get(id).rgb)));
  // Once the takeover's fade-in is over (it runs on the clock, so a slow machine only delays the frames), the pin's
  // panels sit well below the session's.
  const fadedAt = takenAt + FADE_MS + STAGGER_MAX_MS + 200;
  await until(() => {
    const pin = brightest(theirs);
    return Date.now() > fadedAt && pin > 0 && pin < brightest(mine) / 2;
  }, "the pin well below the session");
});

test("an unsplit wall: a swipe without touch data acts at once, as before zones", async (t) => {
  const { emu, fake } = await run(t, {
    zones: () => [{ id: "wall", member: OTHER }],
    activities: [activity("a1", PURPLE)],
    sessions: [live("s1", "a1", OTHER, Date.now() - 60_000)],
  });
  await until(() => emu.effect() === "*ExtControl*", "the takeover");
  emu.touch(-1, "swipe-down");
  await until(() => fake.actions.length === 1, "the swipe");
  assert.deepEqual(fake.actions[0], ["stop", "s1"]);
  // Heard or not, a tap acts for the one zone's member.
  emu.touch(undefined, "double-tap");
  await until(() => fake.actions.length === 2, "the double tap");
  assert.deepEqual(fake.actions[1], ["pause", "s1", OTHER]);
  assert.deepEqual(gestureZones(fake), [
    ["swipe-down", "wall"],
    ["double-tap", "wall"],
  ]);
  assert.deepEqual(fake.warnings, []);
});
