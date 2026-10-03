import assert from "node:assert/strict";
import { test } from "node:test";
import { OFF_SCENE } from "../shared/scene.ts";
import { DEFAULT_SETTINGS } from "../shared/storage.ts";
import { brightnessFeedback, onWall, sentence, wallStatus } from "../ui/src/components/status.ts";

const LIVE = {
  kind: "live",
  key: "live:s1",
  activityId: "deep-work",
  cssColor: "#38bdf8",
  rgb: [56, 189, 248],
  progress: null,
  level: 1,
  style: "glow",
  track: true,
};
const PINNED = { ...LIVE, kind: "pinned", key: "pinned:guitar", activityId: "guitar", level: 0.35, style: "pulse" };

const OUTPUT = { mode: "live", activityId: "deep-work", fraction: null, inControl: true, detail: null, since: "" };
const LAYOUT = {
  controllerId: "S1",
  globalOrientation: 0,
  fetchedAt: "",
  panels: [{ id: 1, x: 0, y: 0, o: 0, shapeType: 8 }],
};

/** A model with main running, the controller connected and main driving the wall. */
function model(overrides = {}) {
  return {
    userId: "u",
    activities: [],
    sessions: [],
    settings: DEFAULT_SETTINGS,
    order: { mode: "auto", auto: "path", ids: [], seed: 1 },
    layout: LAYOUT,
    controller: { host: "192.168.1.40", port: 16021, name: "The Duck", model: "NL42" },
    connection: { status: "connected", name: "The Duck", host: "192.168.1.40", port: 16021 },
    output: OUTPUT,
    mainStatus: "running",
    mainStatusReason: null,
    supportsGoals: true,
    ...overrides,
  };
}

test("status: Live and Pinned only while main drives the wall", () => {
  assert.equal(wallStatus(model(), LIVE).label, "Live");
  const pinned = model({ output: { ...OUTPUT, mode: "pinned", activityId: "guitar" } });
  assert.equal(wallStatus(pinned, PINNED).label, "Pinned · Pulse");
  // A session just started: main hasn't taken the wall yet.
  const idle = { ...OUTPUT, mode: "idle", activityId: null, inControl: false };
  assert.deepEqual(wallStatus(model({ output: idle }), LIVE), { label: "Starting", tone: "muted", dot: "steady" });
  // Main wants it but says why it can't.
  const stuck = { ...OUTPUT, inControl: false, detail: "The controller reports no Shapes panels" };
  assert.equal(wallStatus(model({ output: stuck }), LIVE).label, "Not showing");
  assert.equal(wallStatus(model({ output: { ...idle, detail: null } }), OFF_SCENE).label, "Idle");
});

test("status: main's status comes first, and not hearing it yet is neutral, never danger", () => {
  assert.deepEqual(wallStatus(model({ mainStatus: "connecting", output: null, connection: null }), LIVE), {
    label: "Connecting",
    tone: "muted",
    dot: "steady",
  });
  assert.equal(wallStatus(model({ mainStatus: "starting" }), LIVE).tone, "muted");
  assert.equal(wallStatus(model({ mainStatus: "unavailable", output: null }), LIVE).tone, "danger");
  assert.equal(wallStatus(model({ controller: null }), LIVE).label, "Not paired");
  assert.equal(wallStatus(model({ settings: { ...DEFAULT_SETTINGS, enabled: false } }), OFF_SCENE).label, "Paused");
  assert.equal(wallStatus(model({ connection: { status: "unreachable" } }), LIVE).label, "Offline");
});

test("status: the Now card claims the wall only while main is in control", () => {
  assert.deepEqual(onWall(model()), { showing: true, reason: null });
  const unreachable = { status: "unreachable", name: "The Duck" };
  const disconnected = { ...OUTPUT, mode: "disconnected", inControl: false };
  const offline = onWall(model({ connection: unreachable, output: disconnected }));
  assert.equal(offline.showing, false);
  assert.ok(offline.reason);
  assert.equal(onWall(model({ output: null, mainStatus: "unavailable" })).showing, false);
  assert.equal(onWall(model({ controller: null, output: null })).showing, false);
  // Not heard yet: it says so rather than that the plugin isn't running.
  assert.deepEqual(onWall(model({ mainStatus: "connecting", output: null, connection: null })), {
    showing: false,
    reason: "Connecting to Drift Beacon",
  });
});

test("status: Max brightness adjusts what shows, previews when nothing does, and says when it can't", () => {
  assert.equal(brightnessFeedback(model(), LIVE), "adjust");
  const idle = { ...OUTPUT, mode: "idle", activityId: null, inControl: false };
  assert.equal(brightnessFeedback(model({ output: idle }), OFF_SCENE), "preview");
  // The preview the slider starts puts main in control; the hint doesn't flip mid-drag.
  assert.equal(brightnessFeedback(model({ output: { ...OUTPUT, mode: "preview" } }), OFF_SCENE), "preview");
  assert.equal(brightnessFeedback(model({ output: { ...OUTPUT, mode: "yielded", inControl: false } }), LIVE), "none");
  assert.equal(brightnessFeedback(model({ output: { ...OUTPUT, mode: "busy", inControl: false } }), LIVE), "none");
  assert.equal(brightnessFeedback(model({ mainStatus: "unavailable", output: null }), LIVE), "none");
  assert.equal(brightnessFeedback(model({ connection: { status: "unreachable" } }), LIVE), "none");
  assert.equal(brightnessFeedback(model({ settings: { ...DEFAULT_SETTINGS, enabled: false } }), OFF_SCENE), "none");
  assert.equal(brightnessFeedback(model({ layout: null, output: idle }), OFF_SCENE), "none");
});

test("status: platform reasons become sentences", () => {
  assert.equal(sentence("Waiting for Drift Beacon"), "Waiting for Drift Beacon.");
  assert.equal(sentence(" It stopped. "), "It stopped.");
  assert.equal(sentence("Why?"), "Why?");
  assert.equal(sentence("Trying…"), "Trying…");
  assert.equal(sentence(""), "");
});
