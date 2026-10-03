import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cssRgb,
  DEVICE_GAMMA,
  deviceDrive,
  deviceRgb,
  lightOpacity,
  MIN_DRIVE,
  mix,
  parseColor,
  toLedRgb,
  WARM_WHITE,
} from "../shared/color.ts";

test("hex colours parse in every length, any case, with alpha dropped", () => {
  assert.deepEqual(parseColor("#7C3AED"), [124, 58, 237]);
  assert.deepEqual(parseColor("#7c3aed"), [124, 58, 237]);
  assert.deepEqual(parseColor("#f80"), [255, 136, 0]);
  assert.deepEqual(parseColor("#f808"), [255, 136, 0]);
  assert.deepEqual(parseColor("#7c3aed80"), [124, 58, 237]);
  assert.deepEqual(parseColor("  #000000  "), [0, 0, 0]);
});

test("rgb() and rgba() parse in comma and space syntax, numbers and percentages", () => {
  assert.deepEqual(parseColor("rgb(255, 0, 0)"), [255, 0, 0]);
  assert.deepEqual(parseColor("rgba(16,32,48,0.5)"), [16, 32, 48]);
  assert.deepEqual(parseColor("rgb(16 32 48)"), [16, 32, 48]);
  assert.deepEqual(parseColor("rgb(16 32 48 / 50%)"), [16, 32, 48]);
  assert.deepEqual(parseColor("rgba(16 32 48 / .25)"), [16, 32, 48]);
  assert.deepEqual(parseColor("RGB(100%, 50%, 0%)"), [255, 128, 0]);
  assert.deepEqual(parseColor("rgb(12.6, 300, -5)"), [13, 255, 0]);
  assert.deepEqual(parseColor("rgb(  1  2  3  )"), [1, 2, 3]);
});

test("hsl() and hsla() parse with hue units and both syntaxes", () => {
  assert.deepEqual(parseColor("hsl(0, 100%, 50%)"), [255, 0, 0]);
  assert.deepEqual(parseColor("hsl(120 100% 50%)"), [0, 255, 0]);
  assert.deepEqual(parseColor("hsla(240, 100%, 50%, 0.3)"), [0, 0, 255]);
  assert.deepEqual(parseColor("hsl(240deg 100% 50% / 30%)"), [0, 0, 255]);
  assert.deepEqual(parseColor("hsl(0.5turn 100% 50%)"), [0, 255, 255]);
  assert.deepEqual(parseColor("hsl(200grad 100% 50%)"), [0, 255, 255]);
  assert.deepEqual(parseColor(`hsl(${Math.PI}rad 100% 50%)`), [0, 255, 255]);
  assert.deepEqual(parseColor("hsl(-120, 100%, 50%)"), [0, 0, 255]);
  assert.deepEqual(parseColor("hsl(480 100 50)"), [0, 255, 0]);
  assert.deepEqual(parseColor("hsl(30, 100%, 50%)"), [255, 128, 0]);
  assert.deepEqual(parseColor("hsl(0 0% 50%)"), [128, 128, 128]);
});

test("named colours parse: the basic sixteen, the listed extras and grey spellings", () => {
  const expected = {
    black: [0, 0, 0], silver: [192, 192, 192], gray: [128, 128, 128], white: [255, 255, 255],
    maroon: [128, 0, 0], red: [255, 0, 0], purple: [128, 0, 128], fuchsia: [255, 0, 255],
    green: [0, 128, 0], lime: [0, 255, 0], olive: [128, 128, 0], yellow: [255, 255, 0],
    navy: [0, 0, 128], blue: [0, 0, 255], teal: [0, 128, 128], aqua: [0, 255, 255],
    orange: [255, 165, 0], pink: [255, 192, 203], indigo: [75, 0, 130], violet: [238, 130, 238],
    gold: [255, 215, 0], crimson: [220, 20, 60], coral: [255, 127, 80], salmon: [250, 128, 114],
    turquoise: [64, 224, 208], tomato: [255, 99, 71], skyblue: [135, 206, 235], slateblue: [106, 90, 205],
    grey: [128, 128, 128], rebeccapurple: [102, 51, 153], cyan: [0, 255, 255], magenta: [255, 0, 255],
  };
  for (const [name, rgb] of Object.entries(expected)) assert.deepEqual(parseColor(name), rgb, name);
  assert.deepEqual(parseColor("Tomato"), [255, 99, 71]);
});

test("anything unparseable is null", () => {
  for (const bad of [
    "", "   ", "#", "#12", "#12345", "#1234567", "#ggg", "123456", "rgb(1, 2)", "rgb(1, 2, 3, 4, 5)",
    "rgb(1 2)", "rgb(1, 2 3)", "rgb(1 2 3 / 4 / 5)", "rgb(1, 2, 3 / 4)", "rgb(a, b, c)", "rgb(1, 2, 3", "rgb()",
    "hsl(foo, 1%, 2%)", "hsl(10px 50% 50%)", "hsl(1, 2%)", "cmyk(1, 2, 3, 4)", "notacolour", "transparent",
    "red blue", "rgb(1,,2,3)", "rgb(1 2 3 /)",
  ]) {
    assert.equal(parseColor(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseColor(undefined), null);
  assert.equal(parseColor(null), null);
});

test("toLedRgb scales the brightest channel to 255 and turns black into warm white", () => {
  assert.deepEqual(toLedRgb([124, 58, 237]), [133, 62, 255]);
  assert.deepEqual(toLedRgb([0, 0, 128]), [0, 0, 255]);
  assert.deepEqual(toLedRgb([10, 20, 5]), [128, 255, 64]);
  assert.deepEqual(toLedRgb([255, 1, 2]), [255, 1, 2]);
  assert.deepEqual(toLedRgb([0, 0, 0]), WARM_WHITE);
  assert.deepEqual(WARM_WHITE, [255, 214, 170]);
  assert.ok(Object.isFrozen(WARM_WHITE));
});

test("mix blends linearly, rounds, and clamps t", () => {
  const a = [0, 100, 255];
  const b = [255, 0, 55];
  assert.equal(mix(a, b, 0), a);
  assert.equal(mix(a, b, 1), b);
  assert.deepEqual(mix(a, b, 0.5), [128, 50, 155]);
  assert.deepEqual(mix(a, b, 0.25), [64, 75, 205]);
  assert.deepEqual(mix(a, b, -1), a);
  assert.deepEqual(mix(a, b, 2), b);
  assert.deepEqual(mix(a, b, Number.NaN), a);
});

test("cssRgb uses the space syntax, with an optional alpha", () => {
  assert.equal(cssRgb([1, 2, 3]), "rgb(1 2 3)");
  assert.equal(cssRgb([124, 58, 237], 0.15), "rgb(124 58 237 / 0.15)");
  assert.equal(cssRgb([124, 58, 237], 2), "rgb(124 58 237 / 1)");
  assert.equal(cssRgb([300, -1, 12.4]), "rgb(255 0 12)");
});

test("deviceDrive: no second curve, and any lit level is lifted to at least MIN_DRIVE", () => {
  // The controller most likely maps RGB perceptually itself (nanoleaf-api.md §11): no 2.2 gamma on top.
  assert.equal(DEVICE_GAMMA, 1);
  assert.equal(MIN_DRIVE, 0.03);
  assert.equal(deviceDrive(0), 0);
  assert.equal(deviceDrive(-0.2), 0);
  assert.equal(deviceDrive(Number.NaN), 0);
  assert.equal(deviceDrive(1), 1);
  assert.equal(deviceDrive(1.5), 1);
  assert.equal(deviceDrive(1e-9), MIN_DRIVE + (1 - MIN_DRIVE) * 1e-9);
  assert.ok(Math.abs(deviceDrive(0.5) - (MIN_DRIVE + (1 - MIN_DRIVE) * 0.5)) < 1e-12);
  // Lifted, not clamped: dim levels stay apart, so a pulse's trough still moves.
  let last = 0;
  for (let level = 0.001; level <= 1; level += 0.001) {
    const drive = deviceDrive(level);
    assert.ok(drive > last && drive >= MIN_DRIVE, `${level}`);
    last = drive;
  }
});

test("lightOpacity is what the interface draws: the wall's drive, so 0 stays 0 and a dim light shows", () => {
  assert.equal(lightOpacity(0), 0);
  assert.equal(lightOpacity(1), 1);
  for (const level of [0.001, 0.028, 0.08, 0.35, 0.77]) assert.equal(lightOpacity(level), deviceDrive(level));
  assert.ok(lightOpacity(0.08) > 0.1, "the faint track reads as faint, not as nothing");
});

test("deviceRgb: full level is the LED colour; off is black; out of range levels clamp", () => {
  assert.deepEqual(deviceRgb({ rgb: [255, 128, 0], level: 1 }), [255, 128, 0]);
  assert.deepEqual(deviceRgb({ rgb: [255, 128, 0], level: 0 }), [0, 0, 0]);
  assert.deepEqual(deviceRgb({ rgb: [255, 255, 255], level: 3 }), [255, 255, 255]);
  assert.deepEqual(deviceRgb({ rgb: [255, 255, 255], level: -1 }), [0, 0, 0]);
  assert.deepEqual(deviceRgb({ rgb: [0, 0, 0], level: 1 }), [0, 0, 0]);
  // Linear in the lifted drive: 255 · 0.515 = 131.3 → 131, and 128 follows it from its ratio.
  assert.deepEqual(deviceRgb({ rgb: [255, 128, 0], level: 0.5 }), [131, 66, 0]);
});

test("deviceRgb: a dim light stays visible and keeps its hue", () => {
  // The faint track (0.08) on warm white and on orange (#F97316 as an LED colour).
  assert.deepEqual(deviceRgb({ rgb: WARM_WHITE, level: 0.08 }), [27, 23, 18]);
  assert.deepEqual(deviceRgb({ rgb: [255, 118, 23], level: 0.08 }), [27, 12, 2]);
  // The dimmest lit light: its brightest channel at 8, and no channel the colour has rounds away.
  assert.deepEqual(deviceRgb({ rgb: [255, 118, 23], level: 1e-6 }), [8, 4, 1]);
  assert.deepEqual(deviceRgb({ rgb: [61, 135, 255], level: 1e-6 }), [2, 4, 8]);
  assert.deepEqual(deviceRgb({ rgb: [255, 0, 0], level: 1e-6 }), [8, 0, 0]);
  // A colour mixed mid-crossfade is dimmer than full scale; it still gets the floor.
  assert.deepEqual(deviceRgb({ rgb: [128, 0, 128], level: 0.01 }), [8, 0, 8]);
  // Across colours and dim levels, each channel is its share of the brightest one, within rounding.
  const colours = [WARM_WHITE, [255, 118, 23], [61, 135, 255], [133, 62, 255], [255, 0, 90], [20, 255, 60]];
  for (const rgb of colours) {
    for (const level of [1e-4, 0.01, 0.028, 0.07, 0.08, 0.2]) {
      const out = deviceRgb({ rgb, level });
      const top = Math.max(...out);
      assert.ok(top >= 8, `${rgb} at ${level}: ${out}`);
      for (let i = 0; i < 3; i++) {
        const want = (rgb[i] / 255) * top;
        assert.ok(Math.abs(out[i] - want) <= 0.5 + 1e-9 || (rgb[i] > 0 && out[i] === 1), `${rgb} at ${level}: ${out}`);
        assert.equal(out[i] > 0, rgb[i] > 0, `${rgb} at ${level}: channel ${i} is lit exactly when the colour has it`);
      }
    }
  }
});
