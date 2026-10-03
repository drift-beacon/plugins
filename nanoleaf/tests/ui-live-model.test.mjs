import assert from "node:assert/strict";
import { test } from "node:test";
import { readController, readLayout, readOrder, readSettings, sameLayout } from "../shared/storage.ts";
import { jsonEqual, loggedWrite, mainStatusOf, STATUS_WAIT_MS, stableReader } from "../ui/src/live-model.ts";

const LAYOUT = {
  controllerId: "S1",
  globalOrientation: 0,
  panels: [
    { id: 1, x: 0, y: 0, o: 0, shapeType: 8 },
    { id: 2, x: 134, y: 0, o: 60, shapeType: 8 },
  ],
  fetchedAt: "2026-09-30T10:00:00.000Z",
};

test("live model: a reader keeps its object while the value is equal, however often it is copied", () => {
  const read = stableReader(readSettings);
  const first = read({ enabled: true, viewRotation: 0 });
  assert.equal(read(structuredClone({ enabled: true, viewRotation: 0 })), first);
  const turned = read({ enabled: true, viewRotation: 30 });
  assert.notEqual(turned, first);
  assert.equal(turned.viewRotation, 30);
  assert.equal(read({ enabled: true, viewRotation: 30 }), turned);
});

test("live model: a layout re-read with the same panels keeps its object (sameLayout ignores fetchedAt)", () => {
  const read = stableReader(readLayout, sameLayout);
  const first = read(LAYOUT);
  assert.equal(read({ ...structuredClone(LAYOUT), fetchedAt: "2026-09-30T11:00:00.000Z" }), first);
  const moved = read({ ...LAYOUT, panels: [LAYOUT.panels[0], { ...LAYOUT.panels[1], x: 200 }] });
  assert.notEqual(moved, first);
  assert.equal(read(null), null);
});

test("live model: values compare as JSON", () => {
  assert.ok(jsonEqual({ a: [1, 2] }, { a: [1, 2] }));
  assert.ok(!jsonEqual({ a: [1, 2] }, { a: [2, 1] }));
  assert.ok(jsonEqual(null, null));
});

test("live model: a refused storage write is logged, still rejects for callers, and is never unhandled", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const logged = [];
    const refusal = new Error("Plugin storage is not available");
    // Fire and forget, as a control that can't show the failure would.
    void loggedWrite(Promise.reject(refusal), "settings", (...data) => logged.push(data));
    const shown = loggedWrite(Promise.reject(refusal), "panel order", (...data) => logged.push(data));
    await assert.rejects(shown, refusal);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(
      logged.map(([message]) => message),
      ["Nanoleaf: couldn't save the settings", "Nanoleaf: couldn't save the panel order"],
    );
    assert.equal(logged[0][1], refusal);
    await loggedWrite(Promise.resolve(), "settings", () => assert.fail("a write that lands isn't logged"));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("live model: an unavailable status the page opened with reads as connecting until confirmed", () => {
  const waiting = { state: "unavailable", reason: "Waiting for Drift Beacon" };
  assert.deepEqual(mainStatusOf(waiting, false), { state: "connecting", reason: null });
  assert.deepEqual(mainStatusOf(waiting, true), { state: "unavailable", reason: "Waiting for Drift Beacon" });
  assert.deepEqual(mainStatusOf({ state: "running" }, false), { state: "running", reason: null });
  assert.deepEqual(mainStatusOf({ state: "starting" }, false), { state: "starting", reason: null });
  assert.deepEqual(mainStatusOf({ state: "disabled", reason: "  Off here " }, false), {
    state: "disabled",
    reason: "Off here",
  });
  assert.deepEqual(mainStatusOf(undefined, false), { state: "unavailable", reason: null });
  assert.ok(STATUS_WAIT_MS >= 1500 && STATUS_WAIT_MS <= 5000);
});

// The real SDK UI client against a host that behaves like the app's UI host: a storage.set runs, the host
// pushes the whole storage (a structured clone, as postMessage delivers it), then answers.
test("live model: the host's echo of a settings write keeps layout, order and controller objects", async (t) => {
  const hostListeners = [];
  const uiListeners = [];
  const parent = { postMessage: (msg) => queueMicrotask(() => hostListeners.forEach((l) => l(structuredClone(msg)))) };
  globalThis.window = {
    parent,
    addEventListener: (type, listener) => type === "message" && uiListeners.push(listener),
    removeEventListener: () => {},
  };
  const toUi = (data) => uiListeners.forEach((l) => l({ source: parent, data: structuredClone(data) }));
  const storage = {
    settings: { enabled: true, viewRotation: 0 },
    layout: LAYOUT,
    order: { mode: "auto", auto: "path", ids: [], seed: 1 },
    controller: { host: "10.0.0.2", port: 16021, token: "t", name: "The Duck", model: "NL42" },
  };
  const waiting = { status: { state: "unavailable", reason: "Waiting for Drift Beacon" }, state: {} };
  hostListeners.push((msg) => {
    if (msg.type === "hello") {
      toUi({
        channel: "drift-beacon-plugin",
        type: "welcome",
        apiVersion: msg.apiVersion,
        plugin: { id: "nanoleaf", version: "0.2.0", apiPath: "/x" },
        user: { id: "u" },
        workspace: { id: "w" },
        config: {},
        data: { activities: [], categories: [], sessions: [] },
        storage,
        peers: { self: "nanoleaf", plugins: { nanoleaf: waiting } },
      });
    } else if (msg.type === "request" && msg.method === "storage.set") {
      storage[msg.params.key] = msg.params.value;
      toUi({ channel: "drift-beacon-plugin", type: "state", storage });
      toUi({ channel: "drift-beacon-plugin", type: "response", id: msg.id, result: null });
    }
  });

  const { connect } = await import("@drift-beacon/plugin/ui");
  const ctx = await connect({ timeoutMs: 2000 });
  // The SDK leaves each request's 10 s timeout timer running after the answer: mocked, it doesn't hold the test open.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Before the hub's first report the page sees the host's placeholder, which must not read as "not running".
  assert.equal(mainStatusOf(ctx.plugins.self.status, false).state, "connecting");

  const read = {
    settings: stableReader(readSettings),
    order: stableReader(readOrder),
    layout: stableReader(readLayout, sameLayout),
    controller: stableReader(readController),
  };
  const snapshot = () => ({
    raw: ctx.storage.get("layout"),
    settings: read.settings(ctx.storage.get("settings")),
    order: read.order(ctx.storage.get("order")),
    layout: read.layout(ctx.storage.get("layout")),
    controller: read.controller(ctx.storage.get("controller")),
  });
  const before = snapshot();
  let pushes = 0;
  ctx.onDataChange(() => pushes++);
  await ctx.storage.set("settings", { ...storage.settings, viewRotation: 30 });
  const after = snapshot();

  assert.ok(pushes >= 2, "the local write and the host's echo both notify");
  assert.notEqual(after.raw, before.raw, "the SDK hands out a fresh copy of every stored object on each push");
  assert.equal(after.layout, before.layout);
  assert.equal(after.order, before.order);
  assert.equal(after.controller, before.controller);
  assert.notEqual(after.settings, before.settings);
  assert.equal(after.settings.viewRotation, 30);

  // The hub's first report arrives: now the status is main's own.
  const running = { nanoleaf: { status: { state: "running" }, state: {} } };
  toUi({ channel: "drift-beacon-plugin", type: "state", peers: { self: "nanoleaf", plugins: running } });
  assert.equal(mainStatusOf(ctx.plugins.self.status, true).state, "running");
});
