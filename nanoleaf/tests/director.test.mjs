import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deviceRgb, parseColor, toLedRgb } from "../shared/color.ts";
import { layoutFromPanelLayout, placeLayout } from "../shared/geometry.ts";
import { resolveOrder } from "../shared/order.ts";
import { parseAnimData } from "../shared/protocol.ts";
import { readEffect, REVEAL_MS } from "../shared/effects.ts";
import { ALERT_BEAT_MS, ALERT_MS, ALERT_OUT_MS, FADE_MS, STAGGER_MAX_MS } from "../shared/render.ts";
import { OFF_SCENE } from "../shared/scene.ts";
import { DEFAULT_ORDER, DEFAULT_SETTINGS } from "../shared/storage.ts";
import { acquire, clearYielded, createOwner, holder, markYielded, release, yieldedMark } from "../main/src/claims.ts";
import { DEFAULT_TIMINGS, Director, STATIC_NOTE } from "../main/src/director.ts";
import { captureHandback, handbackPlan, isReservedEffect, runHandback, stillOurs } from "../main/src/handback.ts";
import { NanoleafError, parseInfo } from "../main/src/nanoleaf/http.ts";
import {
  BUSY_DETAIL,
  deriveOutput,
  echoWait,
  frameChanged,
  NO_PANELS_DETAIL,
  outputFraction,
  outputMode,
  sameOutput,
  throttleWait,
  wantsControl,
  yieldReason,
  YIELDED_DETAIL,
} from "../main/src/policy.ts";
import { STATIC_TRANSITION_DS, STREAM_TRANSITION_DS } from "../main/src/session.ts";
import { takeOver } from "../main/src/takeover.ts";

const duck = JSON.parse(readFileSync(new URL("./fixtures/theduck.json", import.meta.url), "utf8"));
const T0 = Date.UTC(2026, 8, 30, 9, 0, 0);
const USER = "u1";
const PURPLE = "#7c3aed";
const quiet = { info() {}, warn() {}, error() {} };

/* ---- Fakes ---- */

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A manual clock with timers: `advance(ms)` runs every due timer in order, letting promises settle in between. */
function fakeClock(start = T0) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, ms), fn, every });
    return id;
  };
  return {
    now: () => now,
    timers: {
      setTimeout: (fn, ms) => add(fn, ms, null),
      clearTimeout: (id) => timers.delete(id),
      setInterval: (fn, ms) => add(fn, ms, ms),
      clearInterval: (id) => timers.delete(id),
    },
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at > end) continue;
          if (!next || timer.at < next[1].at || (timer.at === next[1].at && id < next[0])) next = [id, timer];
        }
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.every) timer.at += timer.every;
        else timers.delete(id);
        timer.fn();
      }
      now = end;
      await flush();
    },
  };
}

let controllers = 0;

/** A controller's REST API in memory: records calls (into a shared journal) and applies them to its state. */
function fakeDevice(journal, overrides = {}) {
  const id = `ctl-${++controllers}`;
  const state = {
    on: true,
    brightness: 50,
    effect: "Northern Lights",
    effectsList: ["*Solid*", "Blaze", "Northern Lights"],
    colorMode: "effect",
    hue: 120,
    sat: 80,
    ct: 4000,
    staticAnimData: null,
    ...overrides,
  };
  const fail = {};
  const hang = {};
  const calls = [];
  const record = async (name, args, options, apply) => {
    calls.push([name, ...args]);
    journal.push(name);
    if (hang[name]) {
      await new Promise((_, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (fail[name]) throw fail[name];
    return apply?.();
  };
  const client = {
    info: (options) =>
      record("info", [], options, () =>
        parseInfo({
          name: "Wall",
          serialNo: id,
          model: "NL42",
          firmwareVersion: "9.2.3",
          state: {
            on: { value: state.on },
            brightness: { value: state.brightness },
            hue: { value: state.hue },
            sat: { value: state.sat },
            ct: { value: state.ct },
            colorMode: state.colorMode,
          },
          effects: { select: state.effect, effectsList: state.effectsList },
          panelLayout: duck.panelLayout,
        }),
      ),
    select: (options) => record("select", [], options, () => state.effect),
    setState: (patch, options) =>
      record("setState", [patch], options, () => {
        if (patch.brightness && "value" in patch.brightness) state.brightness = patch.brightness.value;
        if (patch.on) state.on = patch.on.value;
        if (patch.hue || patch.sat) {
          state.colorMode = "hs";
          state.effect = "*Solid*";
        }
        if (patch.ct) {
          state.colorMode = "ct";
          state.effect = "*Solid*";
        }
      }),
    selectEffect: (name, options) =>
      record("selectEffect", [name], options, () => {
        state.effect = name;
        state.on = true;
      }),
    write: (body, options) =>
      record("write", [body], options, () => {
        if (body.animType === "static") state.effect = "*Static*";
        return null;
      }),
    enterExtControl: (options) => record("enterExtControl", [], options, () => (state.effect = "*ExtControl*")),
    requestStatic: (options) => record("requestStatic", [], options, () => state.staticAnimData),
  };
  const config = { host: "10.0.0.9", port: 16021, token: "tok", id, name: "Wall", model: "NL42" };
  return { id, state, calls, fail, hang, client, config, names: () => calls.map((c) => c[0]) };
}

/** `accepts(n)` says whether the n-th send (from 0) reaches the socket; a dropped one isn't recorded. */
function fakeStream(clock, accepts = () => true) {
  let sends = 0;
  return {
    frames: [],
    closed: false,
    send(lights, transitionDs) {
      if (!accepts(sends++)) return false;
      this.frames.push({ at: clock.now(), lights: [...lights], transitionDs });
      return true;
    },
    close() {
      this.closed = true;
    },
  };
}

function fakeStorage(journal, initial) {
  const map = new Map(Object.entries(initial));
  const writes = [];
  return {
    map,
    writes,
    get: (key) => map.get(key),
    set: async (key, value) => {
      journal.push(`storage:${key}`);
      writes.push([key, value]);
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    },
  };
}

const activity = (id, color, extra = {}) => ({
  id,
  name: id,
  trackingType: "span",
  color,
  iconPath: null,
  archived: false,
  goal: null,
  period: null,
  pinnedBy: [],
  ...extra,
});

const liveSession = (id, activityId, startedAt) => ({
  id,
  activityId,
  type: "span",
  status: "live",
  memberIds: [USER],
  startedAt: new Date(startedAt),
  endedAt: null,
});

/**
 * A Director over fakes, connected to a fresh fake controller with theduck's layout. `shared: env` makes a second
 * instance (its own storage, data and owner) on env's controller and clock, as two users of one wall.
 */
function setup(options = {}) {
  const shared = options.shared;
  const journal = shared?.journal ?? [];
  const clock = shared?.clock ?? fakeClock();
  const device = shared?.device ?? fakeDevice(journal, options.device);
  const layout = layoutFromPanelLayout(duck, device.id, new Date(T0).toISOString());
  const storage = fakeStorage(journal, {
    layout,
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
    ...(options.storage ?? {}),
  });
  const data = {
    activities: options.activities ?? [activity("a1", PURPLE), activity("a2", "#10b981")],
    sessions: options.sessions ?? [],
  };
  const streams = [];
  const published = [];
  const controls = [];
  const deviceErrors = [];
  const owner = createOwner("test");
  const director = new Director({
    userId: USER,
    owner,
    data: () => data,
    storage,
    createClient: () => device.client,
    createStream: () => {
      const stream = fakeStream(clock, options.streamAccepts);
      streams.push(stream);
      return stream;
    },
    publish: (output) => published.push(output),
    publishControl: (control) => controls.push(control),
    log: quiet,
    now: clock.now,
    timers: clock.timers,
    timings: options.timings,
    onDeviceError: (error) => deviceErrors.push(error),
  });
  const link = {
    status: "connected",
    config: device.config,
    controllerId: device.id,
    events: options.events ?? true,
  };
  const order = resolveOrder(DEFAULT_ORDER, placeLayout(layout).panels);
  return {
    journal,
    clock,
    device,
    storage,
    data,
    streams,
    published,
    controls,
    deviceErrors,
    owner,
    director,
    link,
    order,
  };
}

/** Starts the Director, connects it and lets the takeover (if any) finish. */
async function connect(env) {
  env.director.start();
  env.director.setLink(env.link);
  await env.clock.advance(0);
}

function startLive(env, activityId = "a1", id = "s1", startedAt = T0 - 60_000) {
  env.data.sessions = [liveSession(id, activityId, startedAt), ...env.data.sessions];
  env.director.update();
}

function endLive(env, id = "s1") {
  env.data.sessions = env.data.sessions.map((s) =>
    s.id === id ? { ...s, status: "completed", endedAt: new Date(env.clock.now()) } : s,
  );
  env.director.update();
}

function pin(env, activityId) {
  env.data.activities = env.data.activities.map((a) => (a.id === activityId ? { ...a, pinnedBy: [USER] } : a));
  env.director.update();
}

const lastFrame = (env) => env.streams.at(-1).frames.at(-1);

/** The level a panel was sent at, from its brightest channel: `deviceRgb`'s mapping for `led` undone by bisection. */
function levelOf(rgb, led) {
  const target = Math.max(...rgb);
  if (target === 0) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (Math.max(...deviceRgb({ rgb: led, level: mid })) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

/* ---- Claims ---- */

test("claims: the first owner wins, the same owner may re-acquire, only the holder can release", () => {
  const a = createOwner("a");
  const b = createOwner("a");
  assert.equal(acquire("claim-1", a), true);
  assert.equal(acquire("claim-1", a), true);
  assert.equal(acquire("claim-1", b), false);
  release("claim-1", b);
  assert.equal(holder("claim-1"), a);
  release("claim-1", a);
  assert.equal(holder("claim-1"), null);
  assert.equal(acquire("claim-1", b), true);
  release("claim-1", b);
});

/* ---- Pure decisions ---- */

const liveScene = {
  ...OFF_SCENE,
  kind: "live",
  key: "live:s1",
  activityId: "a1",
  cssColor: PURPLE,
  rgb: [133, 62, 255],
  level: 1,
};
const base = {
  linked: true,
  panels: 7,
  enabled: true,
  scene: liveScene,
  previewActive: false,
  alertActive: false,
  yieldedKey: null,
  claimedElsewhere: false,
  inControl: false,
  note: null,
  yieldNote: null,
};

test("wantsControl needs enabled, connected with panels, something to show, no yield and a free claim", () => {
  assert.equal(wantsControl(base), true);
  assert.equal(wantsControl({ ...base, enabled: false }), false);
  assert.equal(wantsControl({ ...base, linked: false }), false);
  assert.equal(wantsControl({ ...base, panels: 0 }), false);
  assert.equal(wantsControl({ ...base, scene: OFF_SCENE }), false);
  assert.equal(wantsControl({ ...base, scene: OFF_SCENE, previewActive: true }), true);
  assert.equal(wantsControl({ ...base, scene: OFF_SCENE, alertActive: true }), true);
  assert.equal(wantsControl({ ...base, scene: OFF_SCENE, alertActive: true, yieldedKey: "off" }), false);
  assert.equal(wantsControl({ ...base, yieldedKey: "live:s1" }), false);
  assert.equal(wantsControl({ ...base, yieldedKey: "live:old" }), true);
  assert.equal(wantsControl({ ...base, claimedElsewhere: true }), false);
});

test("outputMode: disconnected, paused, busy, yielded, preview, live, pinned and idle", () => {
  const mode = (patch) => outputMode({ ...base, ...patch });
  assert.deepEqual(mode({ linked: false }), { mode: "disconnected", detail: null });
  assert.deepEqual(mode({ enabled: false }), { mode: "paused", detail: null });
  assert.deepEqual(mode({ panels: 0 }), { mode: "idle", detail: NO_PANELS_DETAIL });
  assert.deepEqual(mode({ claimedElsewhere: true }), { mode: "busy", detail: BUSY_DETAIL });
  assert.deepEqual(mode({ claimedElsewhere: true, scene: OFF_SCENE }), { mode: "idle", detail: null });
  assert.deepEqual(mode({ yieldedKey: "live:s1" }), { mode: "yielded", detail: YIELDED_DETAIL });
  assert.deepEqual(mode({ yieldedKey: "live:s1", yieldNote: "why" }), { mode: "yielded", detail: "why" });
  assert.deepEqual(mode({ yieldedKey: "off", scene: OFF_SCENE }), { mode: "idle", detail: null });
  assert.deepEqual(mode({ previewActive: true, note: "n" }), { mode: "preview", detail: "n" });
  assert.deepEqual(mode({}), { mode: "live", detail: null });
  assert.deepEqual(mode({ scene: { ...liveScene, kind: "pinned", key: "pinned:a1" } }), {
    mode: "pinned",
    detail: null,
  });
  assert.deepEqual(mode({ scene: OFF_SCENE, inControl: true }), { mode: "idle", detail: null });
});

test("deriveOutput: fraction clamped to 0–1.5 and rounded to 0.001, null without a goal", () => {
  const progress = (fraction) => ({
    goal: { type: "count", count: 3 },
    period: "day",
    current: 1,
    target: 3,
    fraction,
  });
  assert.equal(outputFraction(liveScene), null);
  assert.equal(outputFraction({ ...liveScene, progress: progress(1 / 3) }), 0.333);
  assert.equal(outputFraction({ ...liveScene, progress: progress(2.4) }), 1.5);
  assert.equal(outputFraction({ ...liveScene, progress: progress(-1) }), 0);
  const out = deriveOutput({ ...base, inControl: true, scene: { ...liveScene, progress: progress(0.35) } });
  assert.deepEqual(out, { mode: "live", activityId: "a1", fraction: 0.35, inControl: true, detail: null });
  assert.equal(sameOutput(out, { ...out }), true);
  assert.equal(sameOutput(out, { ...out, inControl: false }), false);
  assert.equal(sameOutput(null, out), false);
});

test("yieldReason: another effect or power off; echoWait: how long after a takeover a report may be its echo", () => {
  const at = (patch) => yieldReason({ staticMode: false, ...patch });
  assert.match(at({ effect: "Flames" }), /Flames/);
  assert.match(at({ on: false }), /switched off/);
  assert.equal(echoWait(10_000, 8_500, 2000), 500);
  assert.equal(echoWait(10_000, 8_000, 2000), 0);
  assert.equal(echoWait(10_000, 7_000, 2000), 0);
  assert.equal(at({ effect: "*ExtControl*" }), null);
  assert.equal(at({ on: true }), null);
  assert.equal(at({}), null);
  assert.equal(at({ effect: null }), null);
  assert.match(at({ effect: "*Static*" }), /Static/);
  assert.equal(at({ effect: "*Static*", staticMode: true }), null);
  assert.match(at({ effect: "*Solid*", staticMode: true }), /Solid/);
});

test("frameChanged: any channel off by 1 or more, other panels, or nothing sent yet", () => {
  const frame = [
    [1, [10, 20, 30]],
    [2, [0, 0, 0]],
  ];
  assert.equal(frameChanged(null, frame), true);
  assert.equal(
    frameChanged(
      frame,
      frame.map(([id, rgb]) => [id, [...rgb]]),
    ),
    false,
  );
  assert.equal(frameChanged(frame, [frame[0], [2, [0, 1, 0]]]), true);
  assert.equal(frameChanged(frame, [frame[0], [3, [0, 0, 0]]]), true);
  assert.equal(frameChanged(frame, [frame[0]]), true);
  assert.equal(throttleWait(1000, 900, 150), 50);
  assert.equal(throttleWait(1000, 800, 150), 0);
});

/* ---- Hand-back capture and plans ---- */

const handback = (patch = {}) => ({
  controllerId: "c1",
  on: true,
  brightness: 64,
  effect: "Northern Lights",
  colorMode: "effect",
  hue: null,
  sat: null,
  ct: null,
  staticAnimData: null,
  takenAt: "2026-09-30T09:00:00.000Z",
  ...patch,
});

test("captureHandback reads the wall, keeps a stored one while it still streams, and keeps static animData", () => {
  const info = (select, state = {}) =>
    parseInfo({
      state: { on: { value: true }, brightness: { value: 64.4 }, hue: { value: 30 }, sat: { value: 70 }, ...state },
      effects: { select, effectsList: [] },
    });
  const fresh = captureHandback("c1", info("Flames"), null, null, "now");
  assert.deepEqual(fresh, {
    controllerId: "c1",
    on: true,
    brightness: 64,
    effect: "Flames",
    colorMode: null,
    hue: 30,
    sat: 70,
    ct: null,
    staticAnimData: null,
    takenAt: "now",
  });
  const stored = handback({ brightness: 12 });
  assert.equal(captureHandback("c1", info("*ExtControl*"), null, stored, "now"), stored);
  assert.notEqual(captureHandback("c2", info("*ExtControl*"), null, stored, "now"), stored);
  assert.equal(captureHandback("c1", info("Flames"), null, stored, "now").effect, "Flames");
  // A *Static* wall over a stored scene that wasn't static is the static fallback's frozen frame: still ours.
  assert.equal(captureHandback("c1", info("*Static*"), "1 5 1 1 2 3 0 10", stored, "now"), stored);
  const storedStatic = handback({ effect: "*Static*", staticAnimData: "1 5 1 9 9 9 0 5" });
  assert.equal(
    captureHandback("c1", info("*Static*"), "1 5 1 1 2 3 0 5", storedStatic, "now").staticAnimData,
    "1 5 1 1 2 3 0 5",
  );
  assert.equal(
    captureHandback("c1", info("*Static*"), "1 5 1 1 2 3 0 5", null, "now").staticAnimData,
    "1 5 1 1 2 3 0 5",
  );
  assert.equal(captureHandback("c1", info("Flames"), "1 5 1 1 2 3 0 5", null, "now").staticAnimData, null);
});

test("stillOurs: streaming, or a static display over a stored scene that wasn't static, for the same controller", () => {
  const stored = handback();
  assert.equal(stillOurs(stored, "c1", "*ExtControl*"), true);
  assert.equal(stillOurs(stored, "c1", "*Static*"), true);
  assert.equal(stillOurs(stored, "c1", "Northern Lights"), false);
  assert.equal(stillOurs(stored, "c1", "*Solid*"), false);
  assert.equal(stillOurs(stored, "c2", "*ExtControl*"), false);
  assert.equal(stillOurs(null, "c1", "*ExtControl*"), false);
  assert.equal(stillOurs(handback({ effect: "*Static*" }), "c1", "*Static*"), false, "maybe the user's own scene");
  assert.equal(stillOurs(handback({ effect: "*Static*" }), "c1", "*ExtControl*"), true);
});

test("handbackPlan: idle off, and restore for off, named, solid, static and other effects", () => {
  // Off: the scene first (never *ExtControl* on a black frame for the next power-on), then brightness and off.
  const off = { kind: "state", patch: { brightness: { value: 64 }, on: { value: false } } };
  assert.deepEqual(handbackPlan(handback(), "off"), [{ kind: "select", effect: "Northern Lights" }, off]);
  assert.deepEqual(handbackPlan(null, "off"), [
    { kind: "first-effect" },
    { kind: "state", patch: { on: { value: false } } },
  ]);
  assert.deepEqual(handbackPlan(handback({ effect: "*Solid*", colorMode: "ct", ct: 2700 }), "off"), [
    { kind: "state", patch: { ct: { value: 2700 } } },
    off,
  ]);
  assert.deepEqual(handbackPlan(null, "restore"), [{ kind: "first-effect" }]);
  assert.deepEqual(handbackPlan(handback({ on: false }), "restore"), [
    { kind: "select", effect: "Northern Lights" },
    off,
  ]);
  assert.deepEqual(handbackPlan(handback({ on: false, effect: "*ExtControl*" }), "restore"), [
    { kind: "first-effect" },
    off,
  ]);
  const brightness = { kind: "state", patch: { brightness: { value: 64 } } };
  assert.deepEqual(handbackPlan(handback(), "restore"), [{ kind: "select", effect: "Northern Lights" }, brightness]);
  assert.deepEqual(handbackPlan(handback({ effect: "*Solid*", colorMode: "hs", hue: 40, sat: 60 }), "restore"), [
    { kind: "state", patch: { hue: { value: 40 }, sat: { value: 60 } } },
    brightness,
  ]);
  assert.deepEqual(
    handbackPlan(handback({ effect: "*Solid*", colorMode: "ct", ct: 2700, hue: 1, sat: 2 }), "restore"),
    [{ kind: "state", patch: { ct: { value: 2700 } } }, brightness],
  );
  assert.deepEqual(handbackPlan(handback({ effect: "*Solid*" }), "restore"), [{ kind: "first-effect" }, brightness]);
  const animData = "1 7 1 255 0 0 0 5";
  assert.deepEqual(handbackPlan(handback({ effect: "*Static*", staticAnimData: animData }), "restore"), [
    {
      kind: "write",
      body: { command: "display", animType: "static", animData, loop: false, palette: [], colorType: "HSB" },
    },
    brightness,
  ]);
  assert.deepEqual(handbackPlan(handback({ effect: "*Static*" }), "restore"), [{ kind: "first-effect" }, brightness]);
  assert.deepEqual(handbackPlan(handback({ effect: "*Dynamic*" }), "restore"), [{ kind: "first-effect" }, brightness]);
  assert.deepEqual(handbackPlan(handback({ effect: "*ExtControl*" }), "restore"), [
    { kind: "first-effect" },
    brightness,
  ]);
  assert.deepEqual(handbackPlan(handback({ effect: null }), "restore"), [{ kind: "first-effect" }, brightness]);
  assert.equal(isReservedEffect("*Solid*"), true);
  assert.equal(isReservedEffect("Solid"), false);
});

test("runHandback: the first saved effect skips reserved names; a refused select falls back", async () => {
  const device = fakeDevice([], { effectsList: ["*Solid*", "Blaze", "Northern Lights"] });
  await runHandback(device.client, [{ kind: "first-effect" }]);
  assert.deepEqual(device.calls.at(-1), ["selectEffect", "Blaze"]);

  const refusing = fakeDevice([]);
  const original = refusing.client.selectEffect;
  refusing.client.selectEffect = async (name, options) => {
    if (name === "Gone") {
      refusing.calls.push(["selectEffect", name]);
      throw new NanoleafError("rejected", "no such effect", 404);
    }
    return original(name, options);
  };
  const refused = await runHandback(refusing.client, [
    { kind: "select", effect: "Gone" },
    { kind: "state", patch: { brightness: { value: 10 } } },
  ]);
  assert.equal(refused.length, 1);
  assert.deepEqual(refusing.names(), ["selectEffect", "info", "selectEffect", "setState"]);
  assert.equal(refusing.state.effect, "Blaze");
  assert.equal(refusing.state.brightness, 10);

  const gone = fakeDevice([]);
  gone.fail.selectEffect = new NanoleafError("unreachable", "gone");
  await assert.rejects(
    runHandback(gone.client, [
      { kind: "select", effect: "Blaze" },
      { kind: "state", patch: { brightness: { value: 10 } } },
    ]),
    /gone/,
  );
  assert.deepEqual(gone.names(), ["selectEffect"]);
});

/* ---- Takeover ---- */

test("takeover order: claim, hand-back, brightness and on, extControl, then the stream and a frame", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0 - 60_000)] });
  await connect(env);
  assert.deepEqual(env.journal, ["info", "storage:handback", "setState", "enterExtControl"]);
  assert.deepEqual(env.device.calls[1], ["setState", { brightness: { value: 80, duration: 0 }, on: { value: true } }]);
  assert.equal(holder(env.device.id), env.owner);
  assert.equal(env.director.inControl, true);
  assert.equal(env.director.controlMode, "stream");
  assert.equal(env.streams.length, 1);
  const stored = env.storage.map.get("handback");
  assert.equal(stored.controllerId, env.device.id);
  assert.equal(stored.effect, "Northern Lights");
  assert.equal(stored.brightness, 50);
  // The first frame goes out at once, faded in from dark, with every light panel in order.
  const first = env.streams[0].frames[0];
  assert.equal(first.at, T0);
  assert.equal(first.transitionDs, STREAM_TRANSITION_DS);
  assert.deepEqual(
    first.lights.map(([id]) => id),
    env.order,
  );
  assert.deepEqual(first.lights[0][1], [0, 0, 0]);
  assert.deepEqual(env.published.at(-1), {
    mode: "live",
    activityId: "a1",
    fraction: null,
    inControl: true,
    detail: null,
    since: new Date(T0).toISOString(),
  });
  // Once the fade is over, every panel is the activity's LED colour at full level.
  await env.clock.advance(2000);
  for (const [, rgb] of lastFrame(env).lights) assert.deepEqual(rgb, deviceRgb({ rgb: [133, 62, 255], level: 1 }));
  await env.director.stop();
});

test("takeover reads a *Static* scene's animData before touching the wall", async () => {
  const animData = "1 49632 1 255 0 0 0 5";
  const env = setup({
    device: { effect: "*Static*", staticAnimData: animData },
    sessions: [liveSession("s1", "a1", T0)],
  });
  await connect(env);
  assert.deepEqual(env.journal, ["info", "requestStatic", "storage:handback", "setState", "enterExtControl"]);
  assert.equal(env.storage.map.get("handback").staticAnimData, animData);
  await env.director.stop();
});

test("a restart while streaming keeps the stored hand-back instead of recording the stream", async () => {
  const journal = [];
  const probe = fakeDevice(journal);
  const stored = handback({ controllerId: `ctl-${controllers + 1}`, brightness: 23, effect: "Blaze" });
  const env = setup({
    device: { effect: "*ExtControl*", brightness: 80 },
    sessions: [liveSession("s1", "a1", T0)],
    storage: { handback: stored },
  });
  assert.equal(env.device.id, stored.controllerId);
  assert.ok(probe);
  await connect(env);
  assert.deepEqual(env.journal, ["info", "setState", "enterExtControl"]);
  assert.equal(env.storage.map.get("handback"), stored);
  // …and hands back to what was there before the restart.
  endLive(env);
  await env.clock.advance(2000);
  assert.equal(env.director.inControl, false);
  assert.equal(env.device.state.effect, "Blaze");
  assert.equal(env.device.state.brightness, 23);
  assert.equal(env.storage.map.get("handback"), null);
});

test("a stored hand-back for another controller, or a wall no longer streaming, is replaced", async () => {
  const env = setup({
    sessions: [liveSession("s1", "a1", T0)],
    storage: { handback: handback({ controllerId: "someone-else", effect: "Blaze" }) },
  });
  await connect(env);
  assert.equal(env.storage.map.get("handback").controllerId, env.device.id);
  assert.equal(env.storage.map.get("handback").effect, "Northern Lights");
  await env.director.stop();
});

test("takeOver aborts between requests without touching the wall", async () => {
  const device = fakeDevice([]);
  const abort = new AbortController();
  device.hang.info = true;
  const touched = [];
  const done = takeOver({
    client: device.client,
    controllerId: device.id,
    storage: fakeStorage([], {}),
    log: quiet,
    brightness: 80,
    takenAt: "now",
    signal: abort.signal,
    onHandback: () => touched.push("handback"),
    onTouch: () => touched.push("touch"),
  });
  abort.abort(new Error("stopped"));
  await assert.rejects(done, /stopped/);
  assert.deepEqual(touched, []);
});

test("static fallback on a 4xx: display writes at most every 1.5 s, transition 10, when changed", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  env.device.fail.enterExtControl = new NanoleafError("rejected", "not supported", 400);
  await connect(env);
  assert.equal(env.director.controlMode, "static");
  assert.equal(env.streams.length, 0);
  assert.equal(env.director.output.detail, STATIC_NOTE);
  const writes = () => env.device.calls.filter(([name]) => name === "write");
  assert.equal(writes().length, 1);
  const body = writes()[0][1];
  assert.equal(body.animType, "static");
  const frames = parseAnimData(body.animData);
  assert.deepEqual([...frames.keys()], env.order);
  for (const [, [frame]] of frames) assert.equal(frame.t, STATIC_TRANSITION_DS);
  // During the fade frames change every tick, but writes stay 1.5 s apart.
  await env.clock.advance(1400);
  assert.equal(writes().length, 1);
  await env.clock.advance(200);
  assert.equal(writes().length, 2);
  // Once the colour is steady nothing more is written (no keep-alive for static displays).
  await env.clock.advance(3000);
  const settled = writes().length;
  await env.clock.advance(6000);
  assert.equal(writes().length, settled);
  // Its own *Static* effect event isn't someone else's.
  env.director.onDeviceEvent({ effect: "*Static*" });
  assert.equal(env.director.inControl, true);
  await env.director.stop();
});

test("a failed takeover (not a refusal) undoes its changes, frees the claim and retries after a backoff", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  env.device.fail.enterExtControl = new NanoleafError("timeout", "no answer");
  await connect(env);
  assert.equal(env.director.inControl, false);
  assert.equal(holder(env.device.id), null);
  assert.equal(env.deviceErrors.length, 1);
  assert.match(env.director.output.detail, /Couldn't take over the wall: no answer/);
  assert.equal(env.director.output.mode, "live");
  // It put the brightness back (and re-selected the effect).
  assert.equal(env.device.state.brightness, 50);
  assert.equal(env.device.state.effect, "Northern Lights");
  const attempts = () => env.device.calls.filter(([name]) => name === "enterExtControl").length;
  assert.equal(attempts(), 1);
  await env.clock.advance(1900);
  assert.equal(attempts(), 1);
  delete env.device.fail.enterExtControl;
  await env.clock.advance(200);
  assert.equal(attempts(), 2);
  assert.equal(env.director.inControl, true);
  assert.equal(env.director.output.detail, null);
  await env.director.stop();
});

/* ---- Streaming ---- */

test("frames go out on change and as a keep-alive every second when nothing changes", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  await env.clock.advance(3000);
  const stream = env.streams[0];
  const during = stream.frames.filter((f) => f.at > T0 && f.at <= T0 + 1200).length;
  assert.ok(during >= 10, `the fade sends every tick (${during})`);
  const start = stream.frames.length;
  await env.clock.advance(5000);
  const steady = stream.frames.slice(start);
  assert.ok(steady.length >= 4 && steady.length <= 6, `keep-alives: ${steady.length}`);
  for (let i = 1; i < steady.length; i++) {
    const gap = steady[i].at - steady[i - 1].at;
    assert.ok(gap >= 1000 && gap <= 1100, `keep-alive gap ${gap}`);
  }
  await env.director.stop();
});

test("a frame the stream drops (a name still resolving) goes out on the next tick, not after a keep-alive", async () => {
  let accepting = false;
  const env = setup({ sessions: [liveSession("s1", "a1", T0)], streamAccepts: () => accepting });
  await connect(env);
  // Past the fade and just past a keep-alive's moment (they fall every 1000 ms from 1100), so none is due soon.
  await env.clock.advance(3150);
  const stream = env.streams[0];
  assert.equal(stream.frames.length, 0);
  accepting = true;
  const at = env.clock.now();
  await env.clock.advance(150);
  assert.ok(stream.frames.length >= 1, "sent once the stream takes frames");
  assert.ok(stream.frames[0].at - at <= 100, `on the next tick: ${stream.frames[0].at - at} ms`);
  await env.director.stop();
});

test("a pinned pulse changes every tick, so every tick sends", async () => {
  const env = setup({ activities: [activity("a1", PURPLE, { pinnedBy: [USER] })] });
  await connect(env);
  assert.equal(env.director.scene.kind, "pinned");
  await env.clock.advance(3000);
  const stream = env.streams[0];
  const start = stream.frames.length;
  await env.clock.advance(2000);
  assert.ok(stream.frames.length - start >= 19, `pulse frames: ${stream.frames.length - start}`);
  assert.equal(env.director.output.mode, "pinned");
  await env.director.stop();
});

test("goal progress fills the panels in order: 35% of the goal across the wall", async () => {
  const goal = { goal: { type: "duration", seconds: 3600 }, period: "day" };
  const env = setup({
    activities: [activity("a1", PURPLE, goal)],
    sessions: [liveSession("s1", "a1", T0 - 21 * 60_000)],
    settings: { track: false },
  });
  await connect(env);
  await env.clock.advance(2000);
  const n = env.order.length;
  const filled = ((21 * 60 + 2) / 3600) * n;
  const led = toLedRgb(parseColor(PURPLE));
  const levels = lastFrame(env).lights.map(([, rgb]) => levelOf(rgb, led));
  for (let k = 0; k < n; k++) {
    const expected = Math.min(1, Math.max(0, filled - k));
    const boost = k === Math.floor(filled) ? 0.07 : 0;
    assert.ok(levels[k] >= expected - 0.02 && levels[k] <= expected + boost + 0.02, `panel ${k}: ${levels[k]}`);
  }
  assert.equal(env.director.output.fraction, Math.round(((21 * 60 + 2) / 3600) * 1000) / 1000);
  await env.director.stop();
});

test("a takeover keeps the tracked render state: the goal-met wave plays once, not again on a restart", async () => {
  const goal = { goal: { type: "count", count: 3 }, period: "day" };
  const done = (id, endedAt) => ({
    ...liveSession(id, "a1", endedAt - 600_000),
    status: "completed",
    endedAt: new Date(endedAt),
  });
  const earlier = [done("s1", T0 - 3_600_000), done("s2", T0 - 2_000_000)];
  // How white the wall went: the goal-met wave mixes the colour toward white, lifting purple's minor channels.
  const whitest = (env) => {
    let most = 0;
    for (const stream of env.streams) {
      for (const frame of stream.frames) {
        for (const [, rgb] of frame.lights) {
          if (Math.max(...rgb) >= 40) most = Math.max(most, Math.min(...rgb) / Math.max(...rgb));
        }
      }
    }
    return most;
  };
  // Main starts in the middle of the third session: the goal was met when it started, long ago.
  const restarted = setup({
    activities: [activity("a1", PURPLE, goal)],
    sessions: [liveSession("s3", "a1", T0 - 20 * 60_000), ...earlier],
  });
  await connect(restarted);
  await restarted.clock.advance(2500);
  assert.equal(restarted.director.inControl, true);
  assert.ok(whitest(restarted) < 0.35, `no wave on a restart: ${whitest(restarted)}`);
  await restarted.director.stop();
  // An idle wall taken over because the final session starts: the change that caused the takeover met the goal.
  const idle = setup({ activities: [activity("a1", PURPLE, goal)], sessions: earlier });
  await connect(idle);
  await idle.clock.advance(1000);
  assert.equal(idle.director.inControl, false);
  startLive(idle, "a1", "s3", T0 + 1000);
  await idle.clock.advance(2500);
  assert.equal(idle.director.inControl, true);
  assert.ok(whitest(idle) > 0.5, `the wave plays: ${whitest(idle)}`);
  await idle.director.stop();
});

/* ---- Release ---- */

test("release waits out the 1.5 s grace, then hands back (restore)", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  await env.clock.advance(1000);
  const before = env.device.calls.length;
  endLive(env);
  await env.clock.advance(1400);
  assert.equal(env.director.inControl, true);
  assert.equal(env.device.calls.length, before);
  assert.equal(env.director.output.mode, "idle");
  await env.clock.advance(200);
  assert.equal(env.director.inControl, false);
  assert.deepEqual(env.device.calls.slice(before), [
    ["selectEffect", "Northern Lights"],
    ["setState", { brightness: { value: 50 } }],
  ]);
  assert.equal(env.streams[0].closed, true);
  assert.equal(holder(env.device.id), null);
  assert.equal(env.storage.map.get("handback"), null);
  assert.deepEqual(env.published.at(-1).inControl, false);
});

test("a session ending and a pin within the grace keep control without a hand-back", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  const before = env.device.calls.length;
  endLive(env);
  await env.clock.advance(800);
  pin(env, "a2");
  await env.clock.advance(4000);
  assert.equal(env.director.inControl, true);
  assert.equal(env.director.scene.key, "pinned:a2");
  assert.deepEqual(env.device.calls.slice(before), []);
  assert.equal(env.streams.length, 1);
  await env.director.stop();
});

test("release with idle off: the scene back, then brightness and off, so a later power-on shows the scene", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)], settings: { idle: "off" } });
  await connect(env);
  const before = env.device.calls.length;
  endLive(env);
  await env.clock.advance(1600);
  assert.deepEqual(env.device.calls.slice(before), [
    ["selectEffect", "Northern Lights"],
    ["setState", { brightness: { value: 50 }, on: { value: false } }],
  ]);
  assert.equal(env.device.state.on, false);
  assert.equal(env.device.state.effect, "Northern Lights", "not left in *ExtControl*");
});

test("restore of a wall that was off puts its colour back before turning it off again", async () => {
  const env = setup({
    sessions: [liveSession("s1", "a1", T0)],
    device: { on: false, effect: "*Solid*", colorMode: "hs", hue: 200, sat: 40, brightness: 30 },
  });
  await connect(env);
  assert.equal(env.device.state.on, true);
  const before = env.device.calls.length;
  endLive(env);
  await env.clock.advance(1600);
  assert.deepEqual(env.device.calls.slice(before), [
    ["setState", { hue: { value: 200 }, sat: { value: 40 } }],
    ["setState", { brightness: { value: 30 }, on: { value: false } }],
  ]);
  assert.equal(env.device.state.effect, "*Solid*");
  assert.equal(env.device.state.on, false);
});

test("losing the controller mid-stream drops control after the grace without trying to hand back", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  const before = env.device.calls.length;
  env.director.setLink({ ...env.link, status: "unreachable" });
  assert.equal(env.director.output.mode, "disconnected");
  await env.clock.advance(1600);
  assert.equal(env.director.inControl, false);
  assert.deepEqual(env.device.calls.slice(before), []);
  assert.equal(holder(env.device.id), null);
  // The stored hand-back stays for when it comes back.
  assert.equal(env.storage.map.get("handback").effect, "Northern Lights");
  await env.director.stop();
});

test("a hand-back left from a crash is carried out once connected, if the wall still streams", async () => {
  const id = `ctl-${controllers + 1}`;
  const env = setup({
    device: { effect: "*ExtControl*", brightness: 80 },
    storage: { handback: handback({ controllerId: id, effect: "Blaze", brightness: 33 }) },
  });
  await connect(env);
  assert.deepEqual(env.device.names(), ["select", "selectEffect", "setState"]);
  assert.equal(env.device.state.effect, "Blaze");
  assert.equal(env.device.state.brightness, 33);
  assert.equal(env.storage.map.get("handback"), null);
  assert.equal(holder(id), null);
  await env.director.stop();
});

test("a hand-back that fails is tried again after a backoff while the wall still streams", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)], device: { brightness: 50 } });
  await connect(env);
  const before = env.device.calls.length;
  env.device.fail.selectEffect = new NanoleafError("server", "Busy", 503);
  endLive(env);
  await env.clock.advance(1600);
  assert.equal(env.director.inControl, false);
  assert.deepEqual(env.device.calls.slice(before), [["selectEffect", "Northern Lights"]]);
  assert.equal(env.storage.map.get("handback").effect, "Northern Lights", "kept for the next attempt");
  assert.equal(env.deviceErrors.length, 1, "the connection is checked");
  assert.equal(holder(env.device.id), null);
  await env.clock.advance(1800);
  assert.equal(env.device.calls.length, before + 1, "waits out the first backoff (2 s)");
  await env.clock.advance(200);
  assert.deepEqual(env.device.names().slice(before + 1), ["select", "selectEffect"]);
  delete env.device.fail.selectEffect;
  await env.clock.advance(5000);
  assert.deepEqual(env.device.names().slice(before + 3), ["select", "selectEffect", "setState"], "then 5 s");
  assert.equal(env.device.state.effect, "Northern Lights");
  assert.equal(env.storage.map.get("handback"), null);
  const done = env.device.calls.length;
  await env.clock.advance(60_000);
  assert.equal(env.device.calls.length, done, "nothing more once it landed");
  await env.director.stop();
});

test("a hand-back that failed partway goes on from the scene it put back, unless someone changed the wall", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)], settings: { idle: "off" } });
  await connect(env);
  env.device.fail.setState = new NanoleafError("timeout", "no answer");
  endLive(env);
  await env.clock.advance(1600);
  assert.equal(env.device.state.effect, "Northern Lights", "the scene is back");
  assert.equal(env.device.state.on, true, "but the wall didn't turn off");
  delete env.device.fail.setState;
  const before = env.device.calls.length;
  await env.clock.advance(2100);
  assert.deepEqual(env.device.calls.slice(before), [
    ["select"],
    ["selectEffect", "Northern Lights"],
    ["setState", { brightness: { value: 50 }, on: { value: false } }],
  ]);
  assert.equal(env.device.state.on, false);
  assert.equal(env.storage.map.get("handback"), null);
  await env.director.stop();

  const other = setup({ sessions: [liveSession("s1", "a1", T0)], settings: { idle: "off" } });
  await connect(other);
  other.device.fail.setState = new NanoleafError("timeout", "no answer");
  endLive(other);
  await other.clock.advance(1600);
  delete other.device.fail.setState;
  other.device.state.effect = "Blaze"; // Someone picks an effect in the Nanoleaf app meanwhile.
  const since = other.device.calls.length;
  await other.clock.advance(2100);
  assert.deepEqual(other.device.calls.slice(since), [["select"]], "left alone");
  assert.equal(other.device.state.on, true);
  assert.equal(other.storage.map.get("handback"), null);
  await other.director.stop();
});

test("a leftover hand-back is dropped when the wall shows something else now", async () => {
  const id = `ctl-${controllers + 1}`;
  const env = setup({ storage: { handback: handback({ controllerId: id, effect: "Blaze" }) } });
  await connect(env);
  assert.deepEqual(env.device.names(), ["select"]);
  assert.equal(env.storage.map.get("handback"), null);
  await env.director.stop();
});

test("a crash in static fallback: the frozen *Static* frame is handed back, unless the stored scene was static", async () => {
  const frozen = setup({
    device: { effect: "*Static*", brightness: 80 },
    storage: { handback: handback({ controllerId: `ctl-${controllers + 1}`, effect: "Blaze", brightness: 33 }) },
  });
  await connect(frozen);
  assert.deepEqual(frozen.device.names(), ["select", "selectEffect", "setState"]);
  assert.equal(frozen.device.state.effect, "Blaze");
  assert.equal(frozen.device.state.brightness, 33);
  assert.equal(frozen.storage.map.get("handback"), null);
  await frozen.director.stop();

  const users = setup({
    device: { effect: "*Static*" },
    storage: { handback: handback({ controllerId: `ctl-${controllers + 1}`, effect: "*Static*" }) },
  });
  await connect(users);
  assert.deepEqual(users.device.names(), ["select"], "maybe the user's own static scene: left alone");
  assert.equal(users.storage.map.get("handback"), null);
  await users.director.stop();
});

test("a takeover after a crash in static fallback keeps the stored hand-back instead of the frozen frame", async () => {
  const env = setup({
    device: { effect: "*Static*", staticAnimData: "1 5 1 9 9 9 0 10" },
    sessions: [liveSession("s1", "a1", T0)],
    storage: { handback: handback({ controllerId: `ctl-${controllers + 1}`, effect: "Blaze", brightness: 33 }) },
  });
  await connect(env);
  assert.deepEqual(env.journal, ["info", "requestStatic", "setState", "enterExtControl"]);
  assert.equal(env.storage.map.get("handback").effect, "Blaze");
  endLive(env);
  await env.clock.advance(2000);
  assert.equal(env.device.state.effect, "Blaze");
  assert.equal(env.device.state.brightness, 33);
});

/* ---- Yield ---- */

test("yield on someone else's effect after the takeover's echo window; inside it, a read decides", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  const reads = () => env.device.names().filter((name) => name === "info").length;
  const taken = reads();
  await env.clock.advance(1000);
  env.director.onDeviceEvent({ effect: "Flames" });
  assert.equal(env.director.inControl, true, "inside the 2 s window: maybe an echo");
  env.director.onDeviceEvent({ effect: "*ExtControl*" });
  env.director.onDeviceEvent({ effect: "Flames" });
  await env.clock.advance(1000);
  assert.equal(reads(), taken + 1, "one read when the window closed");
  assert.equal(env.director.inControl, true, "the wall still streams: it was an echo");
  await env.clock.advance(500);
  env.director.onDeviceEvent({ effect: "*ExtControl*" });
  assert.equal(env.director.inControl, true);
  const before = env.device.calls.length;
  const sent = env.streams[0].frames.length;
  env.director.onDeviceEvent({ effect: "Flames" });
  assert.equal(env.director.inControl, false);
  assert.equal(env.director.yieldedKey, "live:s1");
  assert.equal(env.streams[0].closed, true);
  assert.equal(holder(env.device.id), null);
  assert.deepEqual(env.published.at(-1).mode, "yielded");
  assert.match(env.published.at(-1).detail, /Flames/);
  await env.clock.advance(5000);
  assert.equal(env.streams[0].frames.length, sent);
  assert.deepEqual(env.device.calls.slice(before), [], "nothing restored");
  assert.equal(env.storage.map.get("handback"), null);
  await env.director.stop();
});

test("yield on power off at once, even just after its own brightness write (whose echoes can't look like it)", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  await env.clock.advance(2500);
  env.director.brightness(60);
  await env.clock.advance(500);
  env.director.onDeviceEvent({ on: false });
  assert.equal(env.director.inControl, false);
  assert.match(env.director.output.detail, /switched off/);
  await env.director.stop();
});

test("a change inside the takeover's echo window is read again when the window ends, not lost", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  const reads = () => env.device.names().filter((name) => name === "info").length;
  const taken = reads();
  await env.clock.advance(1500);
  env.device.state.effect = "Blaze"; // The Nanoleaf app, 1.5 s after the takeover.
  env.director.onDeviceEvent({ effect: "Blaze" });
  assert.equal(env.director.inControl, true);
  await env.clock.advance(400);
  assert.equal(reads(), taken);
  await env.clock.advance(200);
  assert.equal(reads(), taken + 1);
  assert.equal(env.director.inControl, false);
  assert.equal(env.director.output.mode, "yielded");
  assert.match(env.director.output.detail, /Blaze/);
  endLive(env);
  await env.clock.advance(3000);
  assert.equal(env.device.state.effect, "Blaze", "nothing restored over the user's pick");

  // Power off inside the window: the read reports it too.
  const off = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(off);
  await off.clock.advance(300);
  off.device.state.on = false;
  off.director.onDeviceEvent({ on: false });
  assert.equal(off.director.inControl, true);
  await off.clock.advance(1800);
  assert.equal(off.director.inControl, false);
  assert.match(off.director.output.detail, /switched off/);
  await off.director.stop();
});

test("static fallback yields at once to someone else's effect, even while an animated scene keeps writing", async () => {
  const env = setup({ activities: [activity("a1", PURPLE, { pinnedBy: [USER] })] });
  env.device.fail.enterExtControl = new NanoleafError("rejected", "not supported", 400);
  await connect(env);
  assert.equal(env.director.controlMode, "static");
  assert.equal(env.director.scene.style, "pulse");
  const writes = () => env.device.names().filter((name) => name === "write").length;
  await env.clock.advance(5000);
  const before = writes();
  assert.ok(before >= 3, `the pulse keeps writing static displays (${before})`);
  env.device.state.effect = "Flames";
  env.director.onDeviceEvent({ effect: "Flames" });
  assert.equal(env.director.inControl, false);
  assert.equal(env.director.output.mode, "yielded");
  await env.clock.advance(6000);
  assert.equal(writes(), before, "no static write over the user's pick");
  assert.equal(env.device.state.effect, "Flames");
  await env.director.stop();
});

test("when the event stream opens again it reads what the wall shows, and yields to a change made meanwhile", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  await env.clock.advance(3000);
  const reads = () => env.device.names().filter((name) => name === "info").length;
  const before = reads();
  // A reopen with nothing changed: one read, still in control.
  env.director.setLink({ ...env.link, events: false });
  env.director.setLink({ ...env.link, events: true });
  await env.clock.advance(0);
  assert.equal(reads(), before + 1);
  assert.equal(env.director.inControl, true);
  // The stream drops, and someone picks an effect in the gap; no event will ever say so.
  env.director.setLink({ ...env.link, events: false });
  env.device.state.effect = "Northern Lights";
  await env.clock.advance(1000);
  assert.equal(env.director.inControl, true);
  env.director.setLink({ ...env.link, events: true });
  await env.clock.advance(0);
  assert.equal(env.director.inControl, false);
  assert.match(env.director.output.detail, /Northern Lights/);
  await env.director.stop();
});

test("a yield clears when the scene key changes, on resume, and when driving is toggled", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  await env.clock.advance(2500);
  env.director.onDeviceEvent({ effect: "Flames" });
  assert.equal(env.director.output.mode, "yielded");
  await env.clock.advance(3000);
  assert.equal(env.director.inControl, false, "stays yielded while the scene is the same");

  // A new session: something different should show.
  startLive(env, "a2", "s2", T0 + 5000);
  await env.clock.advance(0);
  assert.equal(env.director.yieldedKey, null);
  assert.equal(env.director.inControl, true);

  // Resume.
  await env.clock.advance(2500);
  env.director.onDeviceEvent({ effect: "Flames" });
  assert.equal(env.director.inControl, false);
  env.director.resume();
  await env.clock.advance(0);
  assert.equal(env.director.inControl, true);

  // Toggling driving off and on.
  await env.clock.advance(2500);
  env.director.onDeviceEvent({ on: false });
  assert.equal(env.director.output.mode, "yielded");
  env.storage.map.set("settings", { ...DEFAULT_SETTINGS, enabled: false });
  env.director.update();
  assert.equal(env.director.output.mode, "paused");
  env.storage.map.set("settings", { ...DEFAULT_SETTINGS, enabled: true });
  env.director.update();
  await env.clock.advance(0);
  assert.equal(env.director.inControl, true);
  await env.director.stop();
});

test("without the event stream it polls effects/select every 15 s and yields on a change", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)], events: false });
  await connect(env);
  const selects = () => env.device.calls.filter(([name]) => name === "select").length;
  await env.clock.advance(14_000);
  assert.equal(selects(), 0);
  await env.clock.advance(1100);
  assert.equal(selects(), 1);
  assert.equal(env.director.inControl, true);
  env.device.state.effect = "Blaze";
  await env.clock.advance(15_000);
  assert.equal(selects(), 2);
  assert.equal(env.director.inControl, false);
  assert.equal(env.director.output.mode, "yielded");
  await env.director.stop();
});

/* ---- Claims between instances ---- */

test("busy while another instance holds the claim; takes over once it is free", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  const other = createOwner("other");
  acquire(env.device.id, other);
  await connect(env);
  assert.equal(env.director.inControl, false);
  assert.deepEqual(env.device.calls, []);
  assert.equal(env.director.output.mode, "busy");
  assert.equal(env.director.output.detail, BUSY_DETAIL);
  assert.equal(env.director.preview({ mode: "order" }).shown, false);
  release(env.device.id, other);
  await env.clock.advance(200);
  assert.equal(env.director.inControl, true);
  assert.equal(env.director.output.mode, "preview");
  await env.director.stop();
});

test("claims: a yield mark per controller, unique, until an instance takes the controller again", () => {
  assert.equal(yieldedMark("mark-1"), null);
  const first = markYielded("mark-1", "why");
  const second = markYielded("mark-1", "why again");
  assert.notEqual(first.id, second.id);
  assert.deepEqual(yieldedMark("mark-1"), second);
  assert.equal(yieldedMark("mark-2"), null);
  clearYielded("mark-1");
  assert.equal(yieldedMark("mark-1"), null);
});

test("after one instance yields, another that was busy doesn't take the wall back until its scene changes", async () => {
  const a = setup({ sessions: [liveSession("s1", "a1", T0)] });
  const b = setup({ shared: a, sessions: [liveSession("s2", "a2", T0)] });
  await connect(a);
  await connect(b);
  assert.equal(a.director.inControl, true);
  assert.equal(b.director.output.mode, "busy");
  await a.clock.advance(2500);
  a.device.state.effect = "Flames"; // The Nanoleaf app.
  a.director.onDeviceEvent({ effect: "Flames" });
  assert.equal(a.director.inControl, false);
  await a.clock.advance(3000);
  assert.equal(b.director.inControl, false, "the yield belongs to the controller");
  assert.equal(b.director.output.mode, "yielded");
  assert.match(b.director.output.detail, /Flames/);
  assert.equal(a.device.state.effect, "Flames");
  assert.equal(holder(a.device.id), null);

  // Something different to show for B: it takes the wall, and A's yield ends with that (A waits its turn).
  startLive(b, "a1", "s3", T0 + 6000);
  await a.clock.advance(100);
  assert.equal(b.director.inControl, true);
  assert.equal(yieldedMark(a.device.id), null);
  assert.equal(a.director.yieldedKey, null);
  assert.equal(a.director.output.mode, "busy");
  await b.director.stop();
  await a.clock.advance(200);
  assert.equal(a.director.inControl, true);
  await a.director.stop();
});

test("resume on the instance that yielded ends the yield for the others too", async () => {
  const a = setup({ sessions: [liveSession("s1", "a1", T0)] });
  const b = setup({ shared: a, sessions: [liveSession("s2", "a2", T0)] });
  await connect(a);
  await connect(b);
  await a.clock.advance(2500);
  a.director.onDeviceEvent({ on: false });
  await a.clock.advance(500);
  assert.equal(b.director.output.mode, "yielded");
  assert.match(b.director.output.detail, /switched off/);
  a.director.resume();
  await a.clock.advance(100);
  assert.equal(a.director.inControl, true);
  assert.equal(b.director.yieldedKey, null);
  assert.equal(b.director.output.mode, "busy");
  // An instance that starts later on a yielded controller sees the yield too.
  a.device.state.effect = "Blaze";
  a.director.onDeviceEvent({ effect: "Blaze" });
  await a.clock.advance(3000);
  assert.equal(a.director.inControl, false);
  const c = setup({ shared: a, sessions: [liveSession("s4", "a1", T0)] });
  await connect(c);
  await a.clock.advance(500);
  assert.equal(c.director.inControl, false);
  assert.equal(c.director.output.mode, "yielded");
  for (const env of [a, b, c]) await env.director.stop();
});

/* ---- Preview ---- */

test("a preview takes the wall for its lease, then the grace, then hands back", async () => {
  const env = setup();
  await connect(env);
  assert.equal(env.director.output.mode, "idle");
  assert.deepEqual(env.device.calls, []);
  const id = env.order[2];
  assert.deepEqual(env.director.preview({ mode: "identify", panelIds: [id], activityId: "a2" }), { shown: true });
  await env.clock.advance(0);
  assert.equal(env.director.inControl, true);
  assert.equal(env.director.output.mode, "preview");
  await env.clock.advance(700);
  const frame = lastFrame(env).lights;
  const lit = frame.find(([panel]) => panel === id)[1];
  const dim = frame.find(([panel]) => panel !== id)[1];
  assert.ok(lit[1] > 200 && lit[1] > lit[0], `identify uses the activity's green: ${lit}`);
  assert.ok(levelOf(dim, toLedRgb(parseColor("#10b981"))) < 0.1, `the other panels are dim: ${dim}`);
  // Renewing the lease keeps it going.
  await env.clock.advance(3000);
  env.director.preview({ mode: "identify", panelIds: [id], activityId: "a2" });
  await env.clock.advance(3000);
  assert.equal(env.director.output.mode, "preview");
  // Lapsed: the grace, then the hand-back.
  await env.clock.advance(1100);
  assert.equal(env.director.output.mode, "idle");
  assert.equal(env.director.inControl, true);
  await env.clock.advance(1500);
  assert.equal(env.director.inControl, false);
  assert.equal(env.device.state.effect, "Northern Lights");
});

test("preview none ends the lease at once; a preview never shows while paused", async () => {
  const env = setup({ settings: { enabled: false } });
  await connect(env);
  assert.deepEqual(env.director.preview({ mode: "fill", fraction: 0.5 }), { shown: false });
  assert.equal(env.director.output.mode, "paused");
  env.storage.map.set("settings", DEFAULT_SETTINGS);
  env.director.update();
  assert.deepEqual(env.director.preview({ mode: "fill", fraction: 0.5, ttlMs: 10_000 }), { shown: true });
  await env.clock.advance(100);
  assert.equal(env.director.inControl, true);
  assert.deepEqual(env.director.preview({ mode: "none" }), { shown: false });
  assert.equal(env.director.output.mode, "idle");
  await env.clock.advance(1600);
  assert.equal(env.director.inControl, false);
});

test("a preview is held by the copy that asked: only it ends it with none, and it ends when that copy closes", async () => {
  const env = setup();
  await connect(env);
  const show = { mode: "fill", fraction: 0.5, ttlMs: 15_000 };
  assert.deepEqual(env.director.preview(show, "phone"), { shown: true });
  await env.clock.advance(100);
  assert.equal(env.director.output.mode, "preview");
  // Another copy letting go of its own (long gone) preview leaves this one alone.
  assert.deepEqual(env.director.preview({ mode: "none" }, "desk"), { shown: false });
  assert.equal(env.director.output.mode, "preview");
  // Copies opening and closing, as long as the holder is among them.
  env.director.endPreviewsExcept(new Set(["phone", "desk", "tab"]));
  assert.equal(env.director.output.mode, "preview");
  // The holder closed: the preview ends now, not when its 15 s lease lapses, and the wall is handed back.
  env.director.endPreviewsExcept(new Set(["desk"]));
  assert.equal(env.director.output.mode, "idle");
  await env.clock.advance(1600);
  assert.equal(env.director.inControl, false);

  // The latest request takes the wall whoever held it, and becomes the holder.
  env.director.preview(show, "phone");
  env.director.preview({ mode: "order", ttlMs: 15_000 }, "desk");
  assert.deepEqual(env.director.preview({ mode: "none" }, "phone"), { shown: false });
  assert.equal(env.director.output.mode, "preview");
  env.director.endPreviewsExcept(new Set(["phone"]));
  assert.equal(env.director.output.mode, "idle");

  // A preview nobody holds (no copy named) ends for anyone, and never because a copy closed.
  env.director.preview(show);
  env.director.endPreviewsExcept(new Set());
  assert.equal(env.director.output.mode, "preview");
  env.director.preview({ mode: "none" }, "desk");
  assert.equal(env.director.output.mode, "idle");
  // The lease stays the backstop for a holder that never says goodbye.
  env.director.preview({ mode: "fill", fraction: 0.5 }, "phone");
  await env.clock.advance(4100);
  assert.equal(env.director.output.mode, "idle");
});

/* ---- Brightness ---- */

test("a schedule alert over a live scene swells twice in its activity's colour and leaves the scene as it was", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  // Past the takeover's fade, and on a tick, so the frames below are the ones at the times named.
  await env.clock.advance(FADE_MS + STAGGER_MAX_MS + 160);
  const purple = toLedRgb(parseColor(PURPLE));
  const green = toLedRgb(parseColor("#10b981"));
  const first = () => lastFrame(env).lights[0][1];
  assert.ok(Math.abs(levelOf(first(), purple) - 1) < 0.01, "the live scene at full level");

  assert.deepEqual(env.director.alert("a2"), { shown: true });
  // Half a beat in: every panel at the peak, in the scheduled activity's green.
  await env.clock.advance(ALERT_BEAT_MS / 2);
  for (const [, rgb] of lastFrame(env).lights) {
    assert.ok(rgb[1] > rgb[0] && levelOf(rgb, green) > 0.95, `green at the peak: ${rgb}`);
  }
  // Between the beats: nearly dark, so it reads even over a wall that was already full.
  await env.clock.advance(ALERT_BEAT_MS / 2);
  assert.ok(levelOf(first(), green) < 0.1, `the trough: ${first()}`);
  await env.clock.advance(ALERT_BEAT_MS / 2);
  assert.ok(levelOf(first(), green) > 0.95, "the second peak");
  // Over: the live scene again, still in control, nothing handed back.
  await env.clock.advance(ALERT_BEAT_MS / 2 + ALERT_OUT_MS + 200);
  assert.ok(Math.abs(levelOf(first(), purple) - 1) < 0.01 && first()[2] > first()[1], `purple again: ${first()}`);
  assert.equal(env.director.inControl, true);
  assert.equal(env.director.output.mode, "live");
  await env.director.stop();
});

test("a schedule alert on an idle wall takes it, starts once it is taken, then hands it back", async () => {
  const env = setup();
  await connect(env);
  assert.equal(env.director.inControl, false);
  assert.deepEqual(env.director.alert("a2"), { shown: true });
  await env.clock.advance(0);
  assert.equal(env.director.inControl, true);
  assert.equal(env.director.output.mode, "idle");
  const green = toLedRgb(parseColor("#10b981"));
  await env.clock.advance(ALERT_BEAT_MS / 2);
  assert.ok(levelOf(lastFrame(env).lights[0][1], green) > 0.95, "the first peak, counted from the takeover");
  // The alert, then the grace, then the wall as it was.
  await env.clock.advance(ALERT_MS - ALERT_BEAT_MS / 2 + 100);
  assert.equal(env.director.inControl, true);
  await env.clock.advance(1500);
  assert.equal(env.director.inControl, false);
  assert.equal(env.device.state.effect, "Northern Lights");
});

test("a schedule alert is dropped, never played late: switched off, paused, yielded, busy or static", async () => {
  // Switched off in the settings, or driving paused.
  for (const settings of [{ scheduleAlert: false }, { enabled: false }]) {
    const env = setup({ settings });
    await connect(env);
    assert.deepEqual(env.director.alert("a2"), { shown: false });
    await env.clock.advance(1000);
    assert.equal(env.director.inControl, false);
    assert.deepEqual(env.device.calls, []);
  }

  // The wall can't be taken (another instance drives it): the alert waits 5 s, then is gone for good.
  const first = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(first);
  const second = setup({ shared: first });
  await connect(second);
  assert.deepEqual(second.director.alert("a2"), { shown: false });
  await first.clock.advance(5100);
  endLive(first);
  await first.clock.advance(1600);
  assert.equal(first.director.inControl, false);
  await first.clock.advance(1000);
  assert.equal(second.director.inControl, false, "the wall is free, but the moment has passed");

  // Static writes can't swell: nothing changes on the wall.
  const fallback = setup({ sessions: [liveSession("s1", "a1", T0)] });
  fallback.device.fail.enterExtControl = new NanoleafError("rejected", "not supported", 400);
  await connect(fallback);
  await fallback.clock.advance(4000);
  const writes = fallback.device.calls.length;
  assert.deepEqual(fallback.director.alert("a2"), { shown: false });
  await fallback.clock.advance(3000);
  assert.equal(fallback.device.calls.length, writes);
  await fallback.director.stop();
});

test("brightness overrides are throttled to one write per 150 ms and the last value lands", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  await env.clock.advance(1000);
  const writes = () =>
    env.device.calls.filter(([name, patch]) => name === "setState" && patch.brightness).map(([, p]) => p.brightness);
  const start = writes().length;
  assert.deepEqual(env.director.brightness(50), { applied: true });
  await env.clock.advance(0);
  assert.deepEqual(writes().slice(start), [{ value: 50, duration: 0 }]);
  await env.clock.advance(50);
  env.director.brightness(40);
  await env.clock.advance(50);
  env.director.brightness(30);
  await env.clock.advance(30);
  assert.equal(writes().length, start + 1);
  await env.clock.advance(30);
  assert.deepEqual(writes().slice(start), [
    { value: 50, duration: 0 },
    { value: 30, duration: 0 },
  ]);
  // The override lapses after 3 s: back to the setting.
  await env.clock.advance(3100);
  assert.deepEqual(writes().at(-1), { value: 80, duration: 0 });
  // A new maximum in the settings applies the same way.
  env.storage.map.set("settings", { ...DEFAULT_SETTINGS, maxBrightness: 35 });
  env.director.update();
  await env.clock.advance(200);
  assert.deepEqual(writes().at(-1), { value: 35, duration: 0 });
  await env.director.stop();
});

test("a failed brightness write is tried again after a backoff until it lands", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  await env.clock.advance(1000);
  const attempts = () =>
    env.device.calls.filter(([name, patch]) => name === "setState" && patch.brightness?.value === 40).length;
  env.device.fail.setState = new NanoleafError("timeout", "no answer");
  env.storage.map.set("settings", { ...DEFAULT_SETTINGS, maxBrightness: 40 });
  env.director.update();
  await env.clock.advance(200);
  assert.equal(attempts(), 1);
  await env.clock.advance(1700);
  assert.equal(attempts(), 1, "waits out the first backoff (2 s)");
  await env.clock.advance(200);
  assert.equal(attempts(), 2);
  delete env.device.fail.setState;
  await env.clock.advance(5000);
  assert.equal(attempts(), 3, "then 5 s");
  assert.equal(env.device.state.brightness, 40);
  await env.clock.advance(10_000);
  assert.equal(attempts(), 3, "nothing more once it landed");
  await env.director.stop();
});

test("a brightness command while not in control only sets the override for the next takeover", async () => {
  const env = setup();
  await connect(env);
  assert.deepEqual(env.director.brightness(42), { applied: false });
  startLive(env);
  await env.clock.advance(0);
  assert.deepEqual(env.device.calls[1], ["setState", { brightness: { value: 42, duration: 0 }, on: { value: true } }]);
  await env.director.stop();
});

/* ---- Output ---- */

test("output is published only when it changes", async () => {
  const env = setup();
  env.director.start();
  assert.deepEqual(env.published, [
    {
      mode: "disconnected",
      activityId: null,
      fraction: null,
      inControl: false,
      detail: null,
      since: new Date(T0).toISOString(),
    },
  ]);
  env.director.setLink(env.link);
  await env.clock.advance(5000);
  assert.deepEqual(
    env.published.map((o) => o.mode),
    ["disconnected", "idle"],
  );
  startLive(env);
  await env.clock.advance(10_000);
  assert.deepEqual(
    env.published.map((o) => [o.mode, o.inControl]),
    [
      ["disconnected", false],
      ["idle", false],
      ["live", false],
      ["live", true],
    ],
  );
  assert.equal(env.published[3].since, new Date(T0 + 5000).toISOString());
  await env.director.stop();
});

test("no layout panels: idle with a note, and nothing is taken", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)], storage: { layout: null } });
  await connect(env);
  assert.deepEqual(env.device.calls, []);
  assert.equal(env.director.output.mode, "idle");
  assert.equal(env.director.output.detail, NO_PANELS_DETAIL);
  await env.director.stop();
});

/* ---- Stop ---- */

test("stop hands back when in control and frees the claim", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  const before = env.device.calls.length;
  await env.director.stop();
  assert.deepEqual(env.device.calls.slice(before), [
    ["selectEffect", "Northern Lights"],
    ["setState", { brightness: { value: 50 } }],
  ]);
  assert.equal(holder(env.device.id), null);
  assert.equal(env.clock.pending(), 0, "no timers left");
  const frames = env.streams[0].frames.length;
  await env.clock.advance(1000);
  assert.equal(env.streams[0].frames.length, frames);
});

test("stop gives up on a hand-back that hangs after the 3 s budget", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  env.device.hang.selectEffect = true;
  let done = false;
  const stopping = env.director.stop().then(() => (done = true));
  await env.clock.advance(2900);
  assert.equal(done, false);
  await env.clock.advance(200);
  await stopping;
  assert.equal(done, true);
  assert.equal(holder(env.device.id), null);
  assert.equal(env.storage.map.get("handback").effect, "Northern Lights", "kept for next time");
});

test("stop during a takeover that already changed the wall undoes it", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  env.device.hang.enterExtControl = true;
  await connect(env);
  assert.equal(env.director.inControl, false);
  assert.deepEqual(env.device.names(), ["info", "setState", "enterExtControl"]);
  await env.director.stop();
  assert.deepEqual(env.device.names().slice(3), ["selectEffect", "setState"]);
  assert.equal(env.device.state.brightness, 50);
  assert.equal(env.streams.length, 0);
  assert.equal(holder(env.device.id), null);
});

test("handBack (forget) releases at once and takes nothing until the connection changes", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  await env.director.handBack();
  assert.equal(env.director.inControl, false);
  assert.equal(env.device.state.effect, "Northern Lights");
  await env.clock.advance(3000);
  assert.equal(env.director.inControl, false);
  env.director.setLink({ status: "unconfigured", config: null, controllerId: null, events: false });
  assert.equal(env.director.output.mode, "disconnected");
  await env.director.stop();
});

test("handBack before pairing another address: the new link lifts the hold, even for the same controller", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  await env.director.handBack();
  assert.equal(env.director.inControl, false);
  env.director.setLink({ ...env.link, events: false });
  await env.clock.advance(3000);
  assert.equal(env.director.inControl, false, "held while the link is the same");
  // Same serial, another address (an IP → its mDNS name): a new connection.
  env.director.setLink({ ...env.link, config: { ...env.device.config, host: "wall.local" } });
  await env.clock.advance(0);
  assert.equal(env.director.inControl, true);
  await env.director.stop();
});

/* ---- Control: another plugin or Home Assistant holds the wall ---- */

const CUBE = "magic-cube";
const HA = "integration";
const PULSE = readEffect({ type: "pulse", colors: ["#ff0000", "#00ff00"] });
const SHUFFLE = readEffect({ type: "shuffle", colors: ["#ff0000", "#00ff00"] });
const REVEAL = readEffect({ type: "reveal", colors: ["#ff0000", "#00ff00"], color: "#0000ff" });
const REFUSED = { granted: false, shown: false, leaseId: null, effectId: null, expiresAt: null };
const panel = (env, k) => lastFrame(env).lights.find(([id]) => id === env.order[k])[1];

test("takeControl: the caller holds the wall, changes and renews its effect, and everyone else is refused", async () => {
  const env = setup();
  await connect(env);
  const first = env.director.takeControl(CUBE, PULSE, 10_000, "r1");
  assert.equal(first.granted, true);
  assert.equal(first.reason, null);
  assert.equal(first.shown, true);
  assert.equal(first.holder, CUBE);
  assert.equal(first.expiresAt, new Date(T0 + 10_000).toISOString());
  assert.equal(env.director.output.mode, "control");
  assert.equal(env.director.output.activityId, null);
  assert.deepEqual(env.controls.at(-1), {
    holder: CUBE,
    leaseId: first.leaseId,
    effect: { ...PULSE, id: first.effectId, startedAt: T0 },
    since: new Date(T0).toISOString(),
    expiresAt: first.expiresAt,
  });
  // Someone else: refused, told who has it, and nothing changes.
  assert.deepEqual(env.director.takeControl(HA, SHUFFLE), { ...REFUSED, reason: "held", holder: CUBE });
  assert.deepEqual(env.director.releaseControl(HA), { released: false });
  assert.equal(env.director.control.effect.id, first.effectId);

  // The same effect again only renews: the same effect, on the clock it started on.
  await env.clock.advance(5000);
  const renewed = env.director.takeControl(CUBE, PULSE, 10_000, "r2");
  assert.equal(renewed.leaseId, first.leaseId);
  assert.equal(renewed.effectId, first.effectId);
  assert.equal(env.director.control.effect.startedAt, T0);
  assert.equal(renewed.expiresAt, new Date(T0 + 15_000).toISOString());
  // Another effect: a new one under the same lease.
  const changed = env.director.takeControl(CUBE, SHUFFLE, 10_000, "r3");
  assert.equal(changed.leaseId, first.leaseId);
  assert.notEqual(changed.effectId, first.effectId);
  assert.equal(env.director.control.effect.startedAt, T0 + 5000);

  assert.deepEqual(env.director.releaseControl(CUBE, changed.leaseId), { released: true });
  assert.equal(env.director.control, null);
  assert.equal(env.controls.at(-1), null);
  assert.equal(env.director.output.mode, "idle");
  // Free again: the next caller gets a lease of its own.
  const other = env.director.takeControl(HA, SHUFFLE);
  assert.equal(other.granted, true);
  assert.equal(other.holder, HA);
  assert.notEqual(other.leaseId, first.leaseId);
  assert.equal(other.expiresAt, new Date(T0 + 5000 + DEFAULT_TIMINGS.controlTtlMs).toISOString());
  await env.director.stop();
});

test("a lease lapses by itself, on its tick, and frees the lock", async () => {
  const env = setup();
  await connect(env);
  env.director.takeControl(CUBE, PULSE, 2000);
  await env.clock.advance(1900);
  assert.equal(env.director.output.mode, "control");
  await env.clock.advance(100);
  assert.equal(env.director.control, null);
  assert.equal(env.controls.at(-1), null);
  assert.equal(env.director.output.mode, "idle");
  assert.equal(env.director.takeControl(HA, PULSE).granted, true);
  await env.director.stop();
});

test("a repeated requestId answers as before and changes nothing: no renewal, no second reveal", async () => {
  const env = setup();
  await connect(env);
  const first = env.director.takeControl(CUBE, PULSE, 10_000, "r1");
  await env.clock.advance(4000);
  assert.deepEqual(env.director.takeControl(CUBE, PULSE, 10_000, "r1"), first);
  assert.equal(env.director.control.expiresAt, first.expiresAt, "not renewed");

  // A reveal whose answer was lost, asked again after it has played: the answer it had, and nothing on the wall.
  const reveal = env.director.takeControl(CUBE, REVEAL, undefined, "r2");
  assert.equal(reveal.expiresAt, new Date(T0 + 4000 + REVEAL_MS).toISOString(), "a reveal's lease is its length");
  await env.clock.advance(REVEAL_MS + 100);
  assert.equal(env.director.control, null, "it ended its own lease");
  const published = env.controls.length;
  assert.deepEqual(env.director.takeControl(CUBE, REVEAL, undefined, "r2"), reveal);
  assert.equal(env.director.control, null);
  assert.equal(env.controls.length, published);
  // Without the id it is a new request, and plays.
  assert.notEqual(env.director.takeControl(CUBE, REVEAL).effectId, reveal.effectId);
  // An answer is forgotten after a minute: the id means a new request again.
  await env.clock.advance(DEFAULT_TIMINGS.requestMemoryMs);
  assert.notEqual(env.director.takeControl(CUBE, PULSE, 10_000, "r1").leaseId, first.leaseId);
  await env.director.stop();
});

test("a late release names a hold that is over, and an old reveal's end leaves a newer effect alone", async () => {
  const env = setup();
  await connect(env);
  const first = env.director.takeControl(CUBE, PULSE, 2000);
  await env.clock.advance(2500);
  const second = env.director.takeControl(CUBE, PULSE, 10_000);
  assert.notEqual(second.leaseId, first.leaseId);
  assert.deepEqual(env.director.releaseControl(CUBE, first.leaseId), { released: false });
  assert.equal(env.director.control.leaseId, second.leaseId);

  // A reveal, then a pulse before it has played: the reveal's end must not release the pulse.
  env.director.takeControl(CUBE, REVEAL);
  await env.clock.advance(1000);
  const pulse = env.director.takeControl(CUBE, PULSE, 10_000);
  await env.clock.advance(REVEAL_MS);
  assert.equal(env.director.control?.effect.id, pulse.effectId);
  // Without a lease id the holder releases whatever it holds.
  assert.deepEqual(env.director.releaseControl(CUBE), { released: true });
  await env.director.stop();
});

test("a controller takes an idle wall, shows its palette along the order, and the wall is handed back", async () => {
  const env = setup();
  await connect(env);
  assert.equal(env.director.inControl, false);
  env.director.takeControl(CUBE, PULSE, 60_000);
  await env.clock.advance(0);
  assert.equal(env.director.inControl, true);
  await env.clock.advance(FADE_MS + STAGGER_MAX_MS + 200);
  const [a, b, c] = [panel(env, 0), panel(env, 1), panel(env, 2)];
  assert.ok(a[0] > 0 && a[1] === 0 && a[2] === 0, `red: ${a}`);
  assert.ok(b[1] > 0 && b[0] === 0 && b[2] === 0, `green: ${b}`);
  assert.ok(c[0] > 0 && c[1] === 0, `red again: ${c}`);
  env.director.releaseControl(CUBE);
  assert.equal(env.director.output.mode, "idle");
  await env.clock.advance(DEFAULT_TIMINGS.graceMs + 200);
  assert.equal(env.director.inControl, false);
  assert.equal(env.device.state.effect, "Northern Lights");
});

test("a controller's effect shows over a live session and gives the wall back to it, never handing it back", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  await env.clock.advance(FADE_MS + STAGGER_MAX_MS + 200);
  const purple = toLedRgb(parseColor(PURPLE));
  env.director.takeControl(CUBE, SHUFFLE, 60_000);
  assert.equal(env.director.output.mode, "control");
  await env.clock.advance(FADE_MS + STAGGER_MAX_MS + 200);
  for (const [, rgb] of lastFrame(env).lights) assert.equal(rgb[2], 0, `red and green only: ${rgb}`);
  env.director.releaseControl(CUBE);
  assert.equal(env.director.output.mode, "live");
  await env.clock.advance(FADE_MS + STAGGER_MAX_MS + 200);
  const first = lastFrame(env).lights[0][1];
  assert.ok(first[2] > first[1] && Math.abs(levelOf(first, purple) - 1) < 0.01, `purple again: ${first}`);
  assert.equal(env.director.inControl, true);
  assert.equal(env.device.calls.filter(([name]) => name === "selectEffect").length, 0);
  await env.director.stop();
});

test("a controller takes back a wall the plugin had yielded", async () => {
  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  await env.clock.advance(3000);
  env.director.onDeviceEvent({ effect: "Flames" });
  assert.equal(env.director.output.mode, "yielded");
  assert.equal(env.director.inControl, false);
  assert.equal(env.director.takeControl(CUBE, PULSE, 60_000).shown, true);
  await env.clock.advance(0);
  assert.equal(env.director.inControl, true);
  assert.equal(env.director.output.mode, "control");
  await env.director.stop();
});

test("takeControl is refused while driving or control by others is off, and switching either off ends a hold", async () => {
  const paused = setup({ settings: { enabled: false } });
  await connect(paused);
  assert.deepEqual(paused.director.takeControl(CUBE, PULSE), { ...REFUSED, reason: "paused", holder: null });
  const closed = setup({ settings: { allowControl: false } });
  await connect(closed);
  assert.deepEqual(closed.director.takeControl(CUBE, PULSE), { ...REFUSED, reason: "not-allowed", holder: null });
  assert.equal(closed.director.control, null);

  const env = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(env);
  env.director.takeControl(CUBE, PULSE, 60_000);
  assert.equal(env.director.output.mode, "control");
  env.storage.map.set("settings", { ...DEFAULT_SETTINGS, allowControl: false });
  env.director.update();
  assert.equal(env.director.control, null);
  assert.equal(env.controls.at(-1), null);
  assert.equal(env.director.output.mode, "live");
  await env.director.stop();
});

test("a lock is held even when the wall can't show it: shown says which", async () => {
  // Not connected: granted, not shown, and it shows once the wall is there within the lease.
  const env = setup();
  env.director.start();
  const answer = env.director.takeControl(CUBE, PULSE, 60_000);
  assert.equal(answer.granted, true);
  assert.equal(answer.shown, false);
  env.director.setLink(env.link);
  await env.clock.advance(0);
  assert.equal(env.director.inControl, true);
  assert.equal(env.director.output.mode, "control");
  await env.director.stop();

  // Static fallback: frames every 1.5 s can't animate, so it isn't called shown.
  const still = setup({ sessions: [liveSession("s1", "a1", T0)] });
  still.device.fail.enterExtControl = new NanoleafError("rejected", "not supported", 400);
  await connect(still);
  assert.equal(still.director.controlMode, "static");
  const held = still.director.takeControl(CUBE, PULSE, 60_000);
  assert.equal(held.granted, true);
  assert.equal(held.shown, false);
  await still.director.stop();
});

test("a reveal covered by a schedule alert, a preview or a slow takeover is dropped: it ends on time, unseen", async () => {
  const purple = toLedRgb(parseColor(PURPLE));
  const settle = FADE_MS + STAGGER_MAX_MS + 200;

  // Under a schedule alert: the reveal's lease ends by its own clock, and the live scene shows once both are over.
  const alerted = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(alerted);
  await alerted.clock.advance(settle);
  const reveal = alerted.director.takeControl(CUBE, REVEAL);
  alerted.director.alert("a2");
  // The lease ends on the first tick past its length.
  await alerted.clock.advance(REVEAL_MS + 100);
  assert.equal(alerted.director.control, null);
  assert.equal(alerted.director.output.mode, "live");
  await alerted.clock.advance(ALERT_MS + settle);
  const first = lastFrame(alerted).lights[0][1];
  assert.ok(first[2] > first[1] && Math.abs(levelOf(first, purple) - 1) < 0.01, `the live scene: ${first}`);
  assert.equal(alerted.controls.filter((c) => c?.effect.id === reveal.effectId).length, 1, "played once");
  await alerted.director.stop();

  // Under an interface preview: the same.
  const previewed = setup({ sessions: [liveSession("s1", "a1", T0)] });
  await connect(previewed);
  previewed.director.preview({ mode: "order", ttlMs: 10_000 });
  previewed.director.takeControl(CUBE, REVEAL);
  assert.equal(previewed.director.output.mode, "preview");
  await previewed.clock.advance(REVEAL_MS + 100);
  assert.equal(previewed.director.control, null);
  assert.equal(previewed.director.output.mode, "preview");
  await previewed.director.stop();

  // A takeover that hasn't finished when the reveal ends: nothing waits for it.
  const slow = setup();
  slow.director.start();
  slow.director.setLink(slow.link);
  slow.device.hang.info = true;
  slow.director.takeControl(CUBE, REVEAL);
  await slow.clock.advance(REVEAL_MS + 100);
  assert.equal(slow.director.control, null);
  assert.equal(slow.director.output.mode, "idle");
  assert.equal(slow.streams.length, 0, "the wall never showed it");
});

test("the control state is published once per change", async () => {
  const env = setup();
  await connect(env);
  env.director.takeControl(CUBE, PULSE, 10_000, "r1");
  env.director.takeControl(CUBE, PULSE, 10_000, "r1");
  await env.clock.advance(3000);
  assert.equal(env.controls.length, 1);
  env.director.releaseControl(CUBE);
  env.director.releaseControl(CUBE);
  assert.deepEqual(env.controls.map((c) => c?.holder ?? null), [CUBE, null]);
  await env.director.stop();
});

test("DEFAULT_TIMINGS match DESIGN.md", () => {
  assert.equal(DEFAULT_TIMINGS.controlTtlMs, 30_000);
  assert.equal(DEFAULT_TIMINGS.requestMemoryMs, 60_000);
  assert.equal(DEFAULT_TIMINGS.tickMs, 100);
  assert.equal(DEFAULT_TIMINGS.keepAliveMs, 1000);
  assert.equal(DEFAULT_TIMINGS.graceMs, 1500);
  assert.equal(DEFAULT_TIMINGS.ownWriteMs, 2000);
  assert.equal(DEFAULT_TIMINGS.staticIntervalMs, 1500);
  assert.equal(DEFAULT_TIMINGS.pollMs, 15_000);
  assert.equal(DEFAULT_TIMINGS.previewTtlMs, 4000);
  assert.equal(DEFAULT_TIMINGS.alertWaitMs, 5000);
  assert.equal(DEFAULT_TIMINGS.overrideMs, 3000);
  assert.equal(DEFAULT_TIMINGS.brightnessThrottleMs, 150);
  assert.equal(DEFAULT_TIMINGS.stopTimeoutMs, 3000);
});
