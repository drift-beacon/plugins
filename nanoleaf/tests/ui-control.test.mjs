import assert from "node:assert/strict";
import { test } from "node:test";
import { controlScene } from "../shared/scene.ts";
import { DEFAULT_SETTINGS } from "../shared/storage.ts";
import { wallStatus } from "../ui/src/components/status.ts";
import { clockOffset, controlOnPageClock, holderName } from "../ui/src/lib/control.ts";
import { createMainChannel } from "../ui/src/live-model.ts";

/* ---- A controller's effect in the interface: the published `control` state on this page's clock ---- */

const EFFECT = { id: "e1", type: "reveal", colors: [[255, 0, 0]], periodMs: 600, color: [0, 0, 255], startedAt: 50_000 };
const CONTROL = { holder: "magic-cube", leaseId: "l1", effect: EFFECT, since: "", expiresAt: "" };

test("clock offset: main's time against the middle of the round trip", () => {
  // Sent at 1000, answered at 1200: main said 6100 half-way, when this page's clock read 1100.
  assert.equal(clockOffset(1000, 1200, 6100), 5000);
  assert.equal(clockOffset(1000, 1000, 400), -600);
});

test("the control state moves onto the page's clock, so an effect is drawn where the wall has got to", () => {
  // Main's clock is 5 s ahead: an effect it started at 50 000 started at 45 000 on this page's.
  const lease = controlOnPageClock(CONTROL, 5000);
  assert.deepEqual(lease, { holder: "magic-cube", leaseId: "l1", effect: { ...EFFECT, startedAt: 45_000 } });
  assert.equal(controlOnPageClock(CONTROL, 0).effect.startedAt, 50_000, "before the first answer: no shift");
  assert.equal(controlScene(lease).effect.startedAt, 45_000);
});

test("no lock, or a value this version doesn't understand, is no control", () => {
  for (const raw of [null, undefined, "x", {}, { ...CONTROL, holder: 1 }]) {
    assert.equal(controlOnPageClock(raw, 0), null);
  }
  for (const effect of [null, { ...EFFECT, type: "strobe" }, { ...EFFECT, colors: [] }, { ...EFFECT, colors: [[1, 2]] }]) {
    assert.equal(controlOnPageClock({ ...CONTROL, effect }, 0), null);
  }
});

test("the holder in words", () => {
  assert.equal(holderName("magic-cube"), "Magic Cube");
  assert.equal(holderName("integration"), "Home Assistant");
  assert.equal(holderName("nanoleaf_dev"), "Nanoleaf Dev");
  assert.equal(holderName(""), "Another plugin");
});

test("status: Controlled while main shows a controller's effect", () => {
  const model = {
    settings: DEFAULT_SETTINGS,
    controller: { host: "192.168.1.40", port: 16021, name: "The Duck", model: "NL42" },
    connection: { status: "connected" },
    output: { mode: "control", activityId: null, fraction: null, inControl: true, detail: null, since: "" },
    mainStatus: "running",
  };
  const scene = controlScene(controlOnPageClock(CONTROL, 0));
  assert.deepEqual(wallStatus(model, scene), { label: "Controlled", tone: "accent", dot: "pulse" });
});

test("channel: the offset comes from one clock request", async () => {
  let asked = null;
  const main = {
    request: async (name, input, options) => {
      asked = { name, input, options };
      return { now: Date.now() + 60_000 };
    },
    onMessage: () => () => {},
    onResync: () => () => {},
  };
  const offset = await createMainChannel(main).clockOffset();
  assert.equal(asked.name, "clock");
  assert.equal(asked.input, undefined);
  assert.ok(Math.abs(offset - 60_000) < 50, `about a minute ahead: ${offset}`);
});
