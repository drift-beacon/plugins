import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTO_ORDERS,
  DEFAULT_ORDER,
  DEFAULT_SETTINGS,
  ORDER_MODES,
  readController,
  readHandback,
  readLayout,
  readOrder,
  readRawPanels,
  readSettings,
  sameLayout,
  SETTING_RANGES,
} from "../shared/storage.ts";

/** Values that are never a valid object of any kind. */
const GARBAGE = [undefined, null, 0, 1, Number.NaN, "", "settings", true, false, [], [1, 2], () => {}, Symbol("x")];
/** Values that are never a valid number. */
const NOT_NUMBERS = [undefined, null, "50", "", true, [], {}, Number.NaN, Infinity, -Infinity];
/** Values that are never a valid boolean. */
const NOT_BOOLEANS = [undefined, null, 0, 1, "true", "false", "", [], {}, Number.NaN];

test("defaults are the documented ones", () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    enabled: true,
    maxBrightness: 80,
    pinnedStyle: "pulse",
    pinnedLevel: 35,
    pinnedProgress: true,
    track: true,
    scheduleAlert: true,
    allowControl: true,
    idle: "restore",
    viewRotation: 0,
  });
  assert.deepEqual(DEFAULT_ORDER, { mode: "auto", auto: "path", ids: [], seed: 1 });
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  assert.ok(Object.isFrozen(DEFAULT_ORDER) && Object.isFrozen(DEFAULT_ORDER.ids));
  assert.deepEqual(SETTING_RANGES, { maxBrightness: { min: 5, max: 100 }, pinnedLevel: { min: 10, max: 80 } });
  assert.deepEqual([...ORDER_MODES].sort(), ["auto", "custom", "random"]);
  assert.deepEqual([...AUTO_ORDERS].sort(), ["bottom-up", "left-right", "path", "right-left", "top-down"]);
});

test("readSettings: garbage gives the defaults", () => {
  for (const raw of [...GARBAGE, {}, { unknown: 1 }]) {
    assert.deepEqual(readSettings(raw), DEFAULT_SETTINGS, String(raw));
  }
});

test("readSettings keeps valid values and drops unknown fields", () => {
  const valid = {
    enabled: false,
    maxBrightness: 42,
    pinnedStyle: "glow",
    pinnedLevel: 60,
    pinnedProgress: false,
    track: false,
    scheduleAlert: false,
    allowControl: false,
    idle: "off",
    viewRotation: 270,
  };
  assert.deepEqual(readSettings(valid), valid);
  assert.deepEqual(readSettings({ ...valid, token: "secret", extra: [1] }), valid);
});

test("readSettings: each bad field falls back on its own", () => {
  for (const bad of NOT_BOOLEANS) {
    const read = readSettings({ enabled: bad, pinnedProgress: bad, track: bad, maxBrightness: 50 });
    assert.equal(read.enabled, true);
    assert.equal(read.pinnedProgress, true);
    assert.equal(read.track, true);
    assert.equal(read.maxBrightness, 50, "a bad field leaves the good ones alone");
  }
  for (const bad of NOT_NUMBERS) {
    const read = readSettings({ maxBrightness: bad, pinnedLevel: bad, viewRotation: bad, idle: "off" });
    assert.equal(read.maxBrightness, 80, String(bad));
    assert.equal(read.pinnedLevel, 35, String(bad));
    assert.equal(read.viewRotation, 0, String(bad));
    assert.equal(read.idle, "off");
  }
  for (const bad of ["Pulse", "GLOW", "flash", "", null, 1, ["glow"]]) {
    assert.equal(readSettings({ pinnedStyle: bad }).pinnedStyle, "pulse");
  }
  for (const bad of ["Off", "restore ", "dark", null, 0, {}]) assert.equal(readSettings({ idle: bad }).idle, "restore");
});

test("readSettings clamps and rounds numbers into their ranges", () => {
  const brightness = (value) => readSettings({ maxBrightness: value }).maxBrightness;
  const inputs = [0, 4.4, 5, 55.5, 99.6, 100, 101, 1e9, -1e9, -0];
  assert.deepEqual(inputs.map(brightness), [5, 5, 5, 56, 100, 100, 100, 100, 5, 5]);
  const level = (value) => readSettings({ pinnedLevel: value }).pinnedLevel;
  assert.deepEqual([0, 9.6, 10, 33.4, 80, 80.4, 81, 200, -5].map(level), [10, 10, 10, 33, 80, 80, 80, 80, 10]);
});

test("readSettings snaps viewRotation to a multiple of 30 in [0, 360)", () => {
  const rotation = (value) => readSettings({ viewRotation: value }).viewRotation;
  const cases = [
    [0, 0],
    [-0, 0],
    [14.9, 0],
    [15, 30],
    [29, 30],
    [44, 30],
    [46, 60],
    [330, 330],
    [344, 330],
    [346, 0],
    [360, 0],
    [390, 30],
    [3600, 0],
    [-15, 0],
    [-30, 330],
    [-90, 270],
    [-721, 0],
    [1e12, 270],
  ];
  for (const [input, expected] of cases) {
    assert.equal(rotation(input), expected, `${input}`);
    assert.ok(Object.is(rotation(input), expected), `${input} is not -0`);
  }
});

test("readOrder: garbage gives the default order", () => {
  for (const raw of [...GARBAGE, {}]) assert.deepEqual(readOrder(raw), DEFAULT_ORDER, String(raw));
});

test("readOrder validates each field", () => {
  const valid = { mode: "custom", auto: "top-down", ids: [3, 1, 2], seed: 42 };
  assert.deepEqual(readOrder(valid), valid);
  for (const mode of ORDER_MODES) assert.equal(readOrder({ mode }).mode, mode);
  for (const auto of AUTO_ORDERS) assert.equal(readOrder({ auto }).auto, auto);
  for (const bad of ["shuffle", "Auto", "", null, 3]) assert.equal(readOrder({ mode: bad }).mode, "auto");
  for (const bad of ["diagonal", "Path", "", null, {}]) assert.equal(readOrder({ auto: bad }).auto, "path");
});

test("readOrder keeps unique non-negative integer ids, first copy first", () => {
  const ids = (value) => readOrder({ mode: "custom", ids: value }).ids;
  assert.deepEqual(ids([5, 3, 5, 1.5, "4", null, Number.NaN, Infinity, -2, 7, 3, 0, -0, [8], { id: 9 }]), [5, 3, 7, 0]);
  assert.ok(Object.is(ids([-0])[0], 0));
  for (const bad of [undefined, null, "1,2,3", 12, { 0: 1, length: 1 }]) assert.deepEqual(ids(bad), []);
  const input = [1, 2];
  const read = readOrder({ ids: input });
  assert.notEqual(read.ids, input, "a fresh array");
});

test("readOrder turns the seed into a uint32", () => {
  const seed = (value) => readOrder({ seed: value }).seed;
  assert.deepEqual([0, 1, 42, 3.9, -3.9, -1, 2 ** 32, 2 ** 32 + 5, 4294967295].map(seed), [
    0, 1, 42, 3, 4294967293, 4294967295, 0, 5, 4294967295,
  ]);
  for (const bad of NOT_NUMBERS) assert.equal(seed(bad), 1, String(bad));
});

test("readController needs a host, a valid port and a token", () => {
  const valid = { host: "192.168.1.40", port: 16021, token: "abc", id: "S123", name: "Shapes 6297", model: "NL42" };
  assert.deepEqual(readController(valid), valid);
  assert.deepEqual(readController({ ...valid, host: "  wall.local ", id: 12, name: "", model: null, extra: true }), {
    host: "wall.local",
    port: 16021,
    token: "abc",
    id: null,
    name: null,
    model: null,
  });
  for (const raw of GARBAGE) assert.equal(readController(raw), null);
  for (const host of [undefined, null, "", "   ", 42]) assert.equal(readController({ ...valid, host }), null);
  for (const token of [undefined, null, "", " ", 42]) assert.equal(readController({ ...valid, token }), null);
  for (const port of [undefined, null, 0, -1, 65536, 80.5, "16021", Number.NaN, Infinity]) {
    assert.equal(readController({ ...valid, port }), null, String(port));
  }
  assert.equal(readController({ ...valid, port: 1 }).port, 1);
  assert.equal(readController({ ...valid, port: 65535 }).port, 65535);
});

test("readRawPanels drops malformed entries and repeated ids", () => {
  const raw = [
    { id: 10, x: 1, y: 2, o: 480, shapeType: 8 },
    { id: 11, x: -5.5, y: 0, o: -60, shapeType: 9 },
    { id: 10, x: 9, y: 9, o: 0, shapeType: 7 },
    { id: 12, x: 0, y: 0 },
    { id: 13, x: 0, y: 0, o: Number.NaN, shapeType: 2.5 },
    { id: -1, x: 0, y: 0, o: 0, shapeType: 7 },
    { id: 1.5, x: 0, y: 0, o: 0, shapeType: 7 },
    { id: "14", x: 0, y: 0, o: 0, shapeType: 7 },
    { id: 15, x: "0", y: 0, o: 0, shapeType: 7 },
    { id: 16, x: 0, y: Infinity, o: 0, shapeType: 7 },
    { id: 17, x: 0, o: 0, shapeType: 7 },
    null,
    7,
    [],
  ];
  assert.deepEqual(readRawPanels(raw), [
    { id: 10, x: 1, y: 2, o: 120, shapeType: 8 },
    { id: 11, x: -5.5, y: 0, o: 300, shapeType: 9 },
    { id: 12, x: 0, y: 0, o: 0, shapeType: 0 },
    { id: 13, x: 0, y: 0, o: 0, shapeType: 0 },
  ]);
  assert.deepEqual(readRawPanels([{ panelId: 3, x: 1, y: 1, o: 360, shapeType: 12 }], "panelId"), [
    { id: 3, x: 1, y: 1, o: 0, shapeType: 12 },
  ]);
  for (const bad of GARBAGE) assert.deepEqual(readRawPanels(bad), []);
});

test("readLayout needs a controller id and a panel list", () => {
  const valid = {
    controllerId: "S123",
    globalOrientation: 59,
    panels: [{ id: 49632, x: 59, y: 56, o: 0, shapeType: 8 }],
    fetchedAt: "2026-09-30T12:00:00.000Z",
  };
  assert.deepEqual(readLayout(valid), valid);
  for (const raw of GARBAGE) assert.equal(readLayout(raw), null);
  for (const controllerId of [undefined, null, "", 5]) assert.equal(readLayout({ ...valid, controllerId }), null);
  for (const panels of [undefined, null, {}, "panels"]) assert.equal(readLayout({ ...valid, panels }), null);
  assert.deepEqual(readLayout({ controllerId: "S123", panels: [] }), {
    controllerId: "S123",
    globalOrientation: 0,
    panels: [],
    fetchedAt: "1970-01-01T00:00:00.000Z",
  });
  assert.equal(readLayout({ ...valid, globalOrientation: 419 }).globalOrientation, 59);
  assert.equal(readLayout({ ...valid, globalOrientation: -1 }).globalOrientation, 359);
  assert.equal(readLayout({ ...valid, globalOrientation: "59" }).globalOrientation, 0);
  const noisy = readLayout({ ...valid, panels: [...valid.panels, valid.panels[0], { id: 2 }, null] });
  assert.deepEqual(noisy.panels, valid.panels);
});

test("readHandback needs the controller, power and brightness; the rest is optional", () => {
  const valid = {
    controllerId: "S123",
    on: true,
    brightness: 64,
    effect: "*Solid*",
    colorMode: "hs",
    hue: 40,
    sat: 60,
    ct: 5000,
    staticAnimData: null,
    takenAt: "2026-09-30T12:00:00.000Z",
  };
  assert.deepEqual(readHandback(valid), valid);
  for (const raw of GARBAGE) assert.equal(readHandback(raw), null);
  assert.equal(readHandback({ ...valid, controllerId: "" }), null);
  for (const on of NOT_BOOLEANS) assert.equal(readHandback({ ...valid, on }), null);
  for (const brightness of NOT_NUMBERS) assert.equal(readHandback({ ...valid, brightness }), null);
  assert.deepEqual(readHandback({ controllerId: "S123", on: false, brightness: 150 }), {
    controllerId: "S123",
    on: false,
    brightness: 100,
    effect: null,
    colorMode: null,
    hue: null,
    sat: null,
    ct: null,
    staticAnimData: null,
    takenAt: "1970-01-01T00:00:00.000Z",
  });
  const clamped = readHandback({
    ...valid,
    brightness: -4,
    effect: "",
    colorMode: "rgb",
    hue: 400.4,
    sat: -1,
    ct: 100,
    staticAnimData: "3 1 1 255 0 0 0 5",
  });
  const keys = ["brightness", "effect", "colorMode", "hue", "sat", "ct", "staticAnimData"];
  const fields = (read) => keys.map((key) => read[key]);
  assert.deepEqual(fields(clamped), [0, null, null, 360, 0, 1200, "3 1 1 255 0 0 0 5"]);
  const wrong = readHandback({
    ...valid,
    effect: 5,
    colorMode: null,
    hue: "40",
    sat: Number.NaN,
    ct: {},
    staticAnimData: 1,
  });
  assert.deepEqual(fields(wrong), [64, null, null, null, null, null, null]);
  for (const colorMode of ["effect", "hs", "ct"]) {
    assert.equal(readHandback({ ...valid, colorMode }).colorMode, colorMode);
  }
  assert.equal(readHandback({ ...valid, ct: 9000 }).ct, 6500);
});

test("sameLayout compares the wall, not when it was read", () => {
  const panels = [
    { id: 1, x: 0, y: 0, o: 0, shapeType: 8 },
    { id: 2, x: 67, y: 0, o: 60, shapeType: 9 },
  ];
  const a = { controllerId: "S123", globalOrientation: 59, panels, fetchedAt: "2026-09-30T12:00:00.000Z" };
  const same = (patch) => sameLayout(a, { ...a, ...patch });
  assert.equal(sameLayout(a, a), true);
  assert.equal(same({ fetchedAt: "2026-10-01T00:00:00.000Z" }), true);
  assert.equal(same({ panels: [...panels].reverse() }), true, "panel order doesn't matter");
  assert.equal(same({ globalOrientation: 419 }), true, "419° is 59°");
  assert.equal(same({ panels: [panels[0], { ...panels[1], o: 420 }] }), true, "420° is 60°");
  assert.equal(same({ globalOrientation: 60 }), false);
  assert.equal(same({ controllerId: "S999" }), false);
  assert.equal(same({ panels: [panels[0]] }), false);
  assert.equal(same({ panels: [...panels, { id: 3, x: 0, y: 78, o: 60, shapeType: 8 }] }), false);
  for (const key of ["x", "y", "o", "shapeType"]) {
    assert.equal(same({ panels: [panels[0], { ...panels[1], [key]: panels[1][key] + 1 }] }), false, key);
  }
  assert.equal(same({ panels: [panels[0], { ...panels[1], id: 3 }] }), false);
  assert.equal(same({ panels: [panels[0], panels[0]] }), false, "a repeated id is not the other panel");
  assert.equal(sameLayout({ ...a, panels: [panels[0], panels[0]] }, a), false);
  assert.equal(sameLayout(null, null), true);
  assert.equal(sameLayout(undefined, null), true);
  assert.equal(sameLayout(a, null), false);
  assert.equal(sameLayout(null, a), false);
});

test("storage values survive a JSON round trip unchanged", () => {
  const settings = readSettings({ maxBrightness: 33, viewRotation: 90, pinnedStyle: "glow" });
  assert.deepEqual(readSettings(JSON.parse(JSON.stringify(settings))), settings);
  const order = readOrder({ mode: "random", ids: [4, 5], seed: 99 });
  assert.deepEqual(readOrder(JSON.parse(JSON.stringify(order))), order);
  const panels = [{ id: 1, x: 2, y: 3, o: 60, shapeType: 7 }];
  const layout = readLayout({ controllerId: "c", globalOrientation: 30, panels });
  assert.equal(sameLayout(readLayout(JSON.parse(JSON.stringify(layout))), layout), true);
});
