import assert from "node:assert/strict";
import { test } from "node:test";
import { lightOpacity } from "../shared/color.ts";
import { EDGE_MS, PULSE_LOW, PULSE_MS, REDUCED_PULSE, sceneLight } from "../shared/render.ts";
import { barBrightness, barFill, barMoves, pulseWave } from "../ui/src/components/bar-light.ts";

const progress = (fraction) => ({
  goal: { type: "count", count: 5 },
  period: null,
  current: fraction * 5,
  target: 5,
  fraction,
});
const PULSE = {
  kind: "pinned",
  key: "pinned:guitar",
  activityId: "guitar",
  cssColor: "#c084fc",
  rgb: [192, 132, 252],
  progress: null,
  level: 0.35,
  style: "pulse",
  track: true,
};
const LIVE = { ...PULSE, kind: "live", key: "live:s1", level: 1, style: "glow", progress: progress(0.35) };

const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message}: ${a} ≠ ${b}`);

test("bar: each segment is as full as its panel (the DESIGN 35%-of-5 example)", () => {
  assert.deepEqual(barFill(LIVE, 5).map((p) => Math.round(p * 100) / 100), [1, 0.75, 0, 0, 0]);
  assert.deepEqual(barFill(PULSE, 3), [1, 1, 1]);
  assert.deepEqual(barFill({ ...LIVE, progress: progress(1.4) }, 2), [1, 1]);
  assert.deepEqual(barFill(LIVE, 0), []);
});

test("bar: a pinned pulse is lit by the wall's own sceneLight at the absolute time, so it's in phase", () => {
  const n = 5;
  for (const t of [0, 1234, PULSE_MS / 2, 1_727_000_000_123]) {
    const bar = barBrightness(PULSE, n, t);
    for (let k = 0; k < n; k++) {
      const wall = sceneLight({ ...PULSE, progress: null, track: false }, k, n, t).level;
      close(bar[k], lightOpacity(wall), `segment ${k} at ${t}`);
    }
  }
  // The trough of the first panel is at every multiple of the period, whenever the bar mounted.
  close(barBrightness(PULSE, n, 42 * PULSE_MS)[0], lightOpacity(PULSE.level * PULSE_LOW), "trough");
  close(barBrightness(PULSE, n, 42 * PULSE_MS + PULSE_MS / 2)[0], lightOpacity(PULSE.level), "peak");
  // Reduced motion holds it steady, as the drawing does.
  close(barBrightness(PULSE, n, 1234, true)[2], lightOpacity(PULSE.level * REDUCED_PULSE), "reduced");
});

test("bar: the filling panel breathes in step with the wall's edge; the others hold", () => {
  const n = 5;
  const trough = barBrightness(LIVE, n, 10 * EDGE_MS);
  const crest = barBrightness(LIVE, n, 10 * EDGE_MS + EDGE_MS / 2);
  assert.equal(trough[0], lightOpacity(1));
  assert.equal(crest[0], lightOpacity(1));
  assert.ok(crest[1] > trough[1] + 0.2, "segment 2 (filling) brightens at the wall's crest");
  close(crest[1], lightOpacity(1), "crest");
  assert.deepEqual(barBrightness(LIVE, n, 1234, true), Array(n).fill(lightOpacity(1)));
});

test("bar: only a pulse or a part-way live goal moves", () => {
  assert.equal(barMoves(PULSE, 4), true);
  assert.equal(barMoves({ ...PULSE, style: "glow" }, 4), false);
  assert.equal(barMoves(LIVE, 4), true);
  assert.equal(barMoves({ ...LIVE, progress: null }, 4), false);
  assert.equal(barMoves({ ...LIVE, progress: progress(1) }, 4), false);
});

test("bar: the status dot pulses with the first panel", () => {
  close(pulseWave(PULSE, 7 * PULSE_MS), PULSE_LOW, "trough");
  close(pulseWave(PULSE, 7 * PULSE_MS + PULSE_MS / 2), 1, "peak");
  close(pulseWave(PULSE, 99, true), REDUCED_PULSE, "reduced");
  close(pulseWave({ ...PULSE, style: "glow" }, 99), 1, "glow");
});
