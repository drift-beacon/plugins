import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceRgb, WARM_WHITE } from "../shared/color.ts";
import { mulberry32 } from "../shared/order.ts";
import { decideScene, OFF_SCENE } from "../shared/scene.ts";
import { DEFAULT_SETTINGS } from "../shared/storage.ts";
import {
  ADJUST_FADE_MS,
  ALERT_BEAT_MS,
  ALERT_BEATS_MS,
  ALERT_IN_MS,
  ALERT_LOW,
  ALERT_MS,
  ALERT_QUEUE,
  advance,
  alerting,
  EDGE_BOOST,
  EDGE_MS,
  easeInOutCubic,
  FADE_MS,
  fillingPosition,
  fromDark,
  IDENTIFY_DIM,
  initialRenderState,
  isAnimating,
  withAlert,
  LEAP,
  orderSweepMs,
  PREVIEW_FADE_MS,
  PULSE_LOW,
  PULSE_MS,
  renderFrame,
  sceneLight,
  SHIMMER_MS,
  STAGGER_MAX_MS,
  STAGGER_MS,
  TRACK,
  withPreview,
} from "../shared/render.ts";

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const GREEN = [0, 255, 0];
const ORDER = [10, 11, 12, 13, 14];

function progress(fraction) {
  if (fraction == null) return null;
  return { goal: { type: "duration", seconds: 100 }, period: "day", current: fraction * 100, target: 100, fraction };
}

function live(fraction = null, { track = false, key = "live:s1", rgb = RED } = {}) {
  return {
    kind: "live",
    key,
    activityId: "a",
    cssColor: "#ff0000",
    rgb,
    progress: progress(fraction),
    level: 1,
    style: "glow",
    track,
  };
}

function pinned(style, { level = 0.35, fraction = null, track = false, rgb = BLUE } = {}) {
  return {
    kind: "pinned",
    key: "pinned:b",
    activityId: "b",
    cssColor: "#0000ff",
    rgb,
    progress: progress(fraction),
    level,
    style,
    track,
  };
}

function close(actual, expected, message, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `${message ?? ""} ${actual} ≈ ${expected}`);
}

function closeAll(actual, expected, message) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => close(value, expected[i], `${message ?? ""}[${i}]`));
}

function levels(state, t, order = ORDER, opts) {
  const frame = renderFrame(state, order, t, opts);
  return order.map((id) => frame.get(id).level);
}

function colours(state, t, order = ORDER, opts) {
  const frame = renderFrame(state, order, t, opts);
  return order.map((id) => frame.get(id).rgb);
}

/** What a frame shows: each panel's level, and its colour where it is lit (a dark panel's colour shows nowhere). */
function shown(state, t, order = ORDER, opts) {
  const frame = renderFrame(state, order, t, opts);
  return order.map((id) => {
    const light = frame.get(id);
    return light.level > 0 ? [light.level, light.rgb] : [0, null];
  });
}

/* ---- Scene light ---- */

test("35% of a 5-panel goal: 1, 0.75, then dark; with the track the rest sit at TRACK", () => {
  const off = initialRenderState(live(0.35), 0);
  closeAll(levels(off, 0), [1, 0.75, 0, 0, 0]);
  assert.deepEqual(colours(off, 0), [RED, RED, RED, RED, RED]);
  const on = initialRenderState(live(0.35, { track: true }), 0);
  closeAll(levels(on, 0), [1, TRACK + (1 - TRACK) * 0.75, TRACK, TRACK, TRACK]);
});

test("the filling panel breathes by up to EDGE_BOOST, capped at 1, and not with reduced motion", () => {
  const state = initialRenderState(live(0.35), 0);
  closeAll(levels(state, EDGE_MS / 2), [1, 0.75 + EDGE_BOOST, 0, 0, 0]);
  closeAll(levels(state, EDGE_MS), [1, 0.75, 0, 0, 0]);
  closeAll(levels(state, EDGE_MS / 2, ORDER, { reducedMotion: true }), [1, 0.75, 0, 0, 0]);
  const almost = initialRenderState(live(0.199), 0);
  close(levels(almost, EDGE_MS / 2)[0], 1, "capped");
  // At 40% panel 2 is next and breathes from the track floor.
  const edge = initialRenderState(live(0.4, { track: true }), 0);
  close(levels(edge, EDGE_MS / 2)[2], TRACK + EDGE_BOOST);
});

test("without progress every panel is full; at or over the goal too, with no breathing", () => {
  assert.deepEqual(levels(initialRenderState(live(null), 0), 1234), [1, 1, 1, 1, 1]);
  assert.deepEqual(levels(initialRenderState(live(1), 0), EDGE_MS / 2), [1, 1, 1, 1, 1]);
  assert.deepEqual(levels(initialRenderState(live(1.4, { track: true }), 0), EDGE_MS / 2), [1, 1, 1, 1, 1]);
  assert.deepEqual(levels(initialRenderState(live(0), 0), EDGE_MS / 2), [0, 0, 0, 0, 0]);
  closeAll(levels(initialRenderState(live(0, { track: true }), 0), EDGE_MS / 2), [TRACK, TRACK, TRACK, TRACK, TRACK]);
});

test("sceneLight: off is dark warm white; pinned glow scales by the pinned level", () => {
  assert.deepEqual(sceneLight(OFF_SCENE, 0, 5, 0), { rgb: WARM_WHITE, level: 0 });
  const glow = pinned("glow", { fraction: 0.5 });
  const got = [0, 1, 2, 3, 4].map((k) => sceneLight(glow, k, 5, 777).level);
  closeAll(got, [0.35, 0.35, 0.35 * 0.5, 0, 0]);
  assert.equal(sceneLight(glow, 0, 5, 0).rgb, BLUE);
  closeAll([0, 4].map((k) => sceneLight(pinned("glow"), k, 5, 0).level), [0.35, 0.35]);
});

test("a pinned goal with nothing done yet shows its track even with the track off: a pin never holds it dark", () => {
  const positions = [0, 1, 2, 3, 4];
  const bare = pinned("glow", { fraction: 0, track: false });
  closeAll(positions.map((k) => sceneLight(bare, k, 5, 0).level), Array(5).fill(0.35 * TRACK));
  const started = pinned("glow", { fraction: 0.4, track: false });
  closeAll(positions.map((k) => sceneLight(started, k, 5, 0).level), [0.35, 0.35, 0, 0, 0]);
  // Leaving nothing behind fades, even for a step under LEAP, so the bare track never drops out at once.
  const state = advance(initialRenderState(bare, 0), pinned("glow", { fraction: LEAP / 2, track: false }), 1000);
  assert.equal(state.adjust, true);
  closeAll(levels(state, 1000), Array(5).fill(0.35 * TRACK));
  // A live session is never at nothing for long (a count goal counts it at once): it stays as the setting says.
  assert.deepEqual(levels(initialRenderState(live(0), 0), 0), [0, 0, 0, 0, 0]);
});

test("pinned pulse stays between PULSE_LOW·level·fill and level·fill, repeats every PULSE_MS, and travels", () => {
  const scene = pinned("pulse", { level: 0.5, fraction: 0.7, track: true });
  const n = 5;
  const fills = [1, 1, 1, TRACK + (1 - TRACK) * 0.5, TRACK];
  for (let k = 0; k < n; k++) {
    let min = Infinity;
    let max = -Infinity;
    for (let t = 0; t < PULSE_MS; t += 5) {
      const level = sceneLight(scene, k, n, t).level;
      min = Math.min(min, level);
      max = Math.max(max, level);
      close(sceneLight(scene, k, n, t + PULSE_MS).level, level, "periodic", 1e-9);
    }
    close(min, PULSE_LOW * 0.5 * fills[k], `min ${k}`, 1e-4);
    close(max, 0.5 * fills[k], `max ${k}`, 1e-4);
  }
  // A wave: at t = 0 the first panel is at its trough while later ones are already rising.
  close(sceneLight(scene, 0, n, 0).level, PULSE_LOW * 0.5);
  assert.ok(sceneLight(scene, 1, n, 0).level > sceneLight(scene, 0, n, 0).level);
  // Reduced motion: a steady 60%.
  for (const t of [0, 1000, 2345]) {
    close(sceneLight(scene, 0, n, t, { reducedMotion: true }).level, 0.5 * 0.6);
  }
});

/* ---- Crossfades ---- */

test("crossfade: starts on the previous scene and ends on the new one", () => {
  const start = initialRenderState(live(null, { rgb: RED }), 0);
  const state = advance(start, live(null, { key: "live:s2", rgb: BLUE }), 1000);
  assert.equal(state.previous, start.scene);
  assert.equal(state.changedAt, 1000);
  assert.deepEqual(colours(state, 1000), [RED, RED, RED, RED, RED]);
  assert.deepEqual(levels(state, 1000), [1, 1, 1, 1, 1]);
  const end = 1000 + FADE_MS + (ORDER.length - 1) * STAGGER_MS;
  assert.deepEqual(colours(state, end), [BLUE, BLUE, BLUE, BLUE, BLUE]);
  // Mid-fade between two lit scenes the colour is mixed.
  const mid = colours(state, 1000 + FADE_MS / 2)[0];
  assert.deepEqual(mid, [128, 0, 128]);
});

test("crossfade: staggered along the order, earlier positions first, delay capped", () => {
  const order = Array.from({ length: 16 }, (_, i) => 100 + i);
  const state = advance(initialRenderState(OFF_SCENE, 0), live(null), 1000);
  const mid = levels(state, 1000 + 400, order);
  for (let k = 1; k < 9; k++) assert.ok(mid[k] < mid[k - 1], `position ${k} lags ${k - 1}`);
  // Positions at or past the cap (12·45 ≥ 540 ms) move together.
  assert.equal(mid[12], mid[15]);
  const late = levels(state, 1000 + FADE_MS, order);
  close(late[0], 1, "first finished");
  close(late[12], easeInOutCubic((FADE_MS - STAGGER_MAX_MS) / FADE_MS), "capped one still fading");
  close(late[3], easeInOutCubic((FADE_MS - 3 * STAGGER_MS) / FADE_MS));
});

test("crossfade: no fade through grey to or from an off scene", () => {
  const on = advance(initialRenderState(OFF_SCENE, 0), live(null, { rgb: GREEN }), 1000);
  for (const t of [1000, 1100, 1300, 1600, 2000]) {
    assert.deepEqual(colours(on, t), Array(5).fill(GREEN), `on at ${t}`);
  }
  const offAgain = advance(initialRenderState(live(null, { rgb: GREEN }), 0), OFF_SCENE, 1000);
  for (const t of [1100, 1300, 1600]) {
    assert.deepEqual(colours(offAgain, t), Array(5).fill(GREEN), `off at ${t}`);
  }
  closeAll(levels(offAgain, 3000), [0, 0, 0, 0, 0]);
  // An unlit panel of a progress scene also takes the other side's colour.
  const fill = advance(initialRenderState(live(0.2, { rgb: RED }), 0), live(1, { key: "live:s2", rgb: BLUE }), 1000);
  assert.deepEqual(colours(fill, 1000 + FADE_MS / 2)[4], BLUE);
});

test("crossfade with reduced motion: one 150 ms fade, no stagger", () => {
  const state = advance(initialRenderState(OFF_SCENE, 0), live(null), 1000);
  const opts = { reducedMotion: true };
  closeAll(levels(state, 1075, ORDER, opts), [0.5, 0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(levels(state, 1150, ORDER, opts), [1, 1, 1, 1, 1]);
});

test("same key: a new colour swaps, a leap adjusts, and a live duration goal's creep updates in place", () => {
  const start = initialRenderState(live(0.2), 0);
  const recoloured = advance(start, live(0.2, { rgb: BLUE }), 500);
  assert.equal(recoloured.previous, start.scene);
  assert.equal(recoloured.adjust, false, "the full staggered crossfade");
  // A 1 h goal creeps by 1/3600 a second: no fade, the new fraction shows at once.
  const hour = (fraction) => ({
    ...live(),
    progress: { ...progress(fraction), current: 3600 * fraction, target: 3600 },
  });
  const creeping = initialRenderState(hour(0.2), 0);
  const crept = advance(creeping, hour(0.2 + 1 / 3600), 1000);
  assert.equal(crept.previous, null);
  assert.equal(crept.changedAt, 0);
  assert.equal(crept.scene.progress.fraction, 0.2 + 1 / 3600);
  assert.equal(advance(creeping, hour(0.2 + LEAP * 0.99), 1000).previous, null);
  // A step of LEAP or more (a session edited, another member's finished) fades, briefly and unstaggered.
  const leapt = advance(start, live(0.3), 500);
  assert.equal(leapt.previous, start.scene);
  assert.equal(leapt.adjust, true);
  assert.deepEqual(levels(leapt, 500), levels(start, 500), "starts where it was");
  const settled = initialRenderState(live(0.3), 0);
  assert.deepEqual(levels(leapt, 500 + ADJUST_FADE_MS), levels(settled, 500 + ADJUST_FADE_MS));
});

test("same key, shown differently: style, level, track, progress shown and the goal crossfade briefly", () => {
  const base = pinned("glow", { level: 0.8, fraction: 0.4, track: true });
  const counted = (current) => ({
    ...base,
    progress: { goal: { type: "count", count: 5 }, period: "day", current, target: 5, fraction: current / 5 },
  });
  const changes = [
    ["style", base, pinned("pulse", { level: 0.8, fraction: 0.4, track: true })],
    ["level", base, pinned("glow", { level: 0.5, fraction: 0.4, track: true })],
    ["track", base, pinned("glow", { level: 0.8, fraction: 0.4, track: false })],
    ["progress hidden", base, pinned("glow", { level: 0.8, fraction: null, track: true })],
    ["progress shown", pinned("glow", { level: 0.8, fraction: null, track: true }), base],
    ["goal", base, { ...base, progress: { ...progress(0.4), goal: { type: "duration", seconds: 200 }, target: 200 } }],
    ["a count step", counted(2), counted(3)],
  ];
  for (const [what, before, after] of changes) {
    const from = initialRenderState(before, 0);
    const state = advance(from, after, 1000);
    assert.equal(state.previous, from.scene, what);
    assert.equal(state.adjust, true, what);
    assert.deepEqual(levels(state, 1000), levels(from, 1000), `${what}: no jump`);
    // One fade for every panel at once (no stagger), done after ADJUST_FADE_MS.
    const t = 1000 + ADJUST_FADE_MS / 2;
    const a = levels(from, t);
    const b = levels(initialRenderState(after, 0), t);
    closeAll(levels(state, t), a.map((x, i) => x + (b[i] - x) * 0.5), `${what}: halfway`);
    const end = 1000 + ADJUST_FADE_MS;
    closeAll(levels(state, end), levels(initialRenderState(after, 0), end), `${what}: done`);
    assert.equal(isAnimating(state, end + 1), after.style === "pulse", `${what}: over`);
  }
});

/* ---- State ---- */

test("advance returns the same object when nothing changed, and prunes finished work", () => {
  const start = initialRenderState(live(0.5), 0);
  assert.equal(advance(start, start.scene, 100), start);
  assert.equal(advance(start, live(0.5), 100), start, "equal by value");
  const fading = advance(start, OFF_SCENE, 1000);
  assert.notEqual(fading, start);
  assert.equal(advance(fading, OFF_SCENE, 1000 + FADE_MS + STAGGER_MAX_MS), fading, "not finished yet");
  const done = advance(fading, OFF_SCENE, 1001 + FADE_MS + STAGGER_MAX_MS);
  assert.equal(done.previous, null);
  assert.equal(done.scene, fading.scene);
  assert.equal(advance(done, OFF_SCENE, 99999), done);
});

test("goal met fires once on crossing 1, live or pinned, never on the initial state, and fades away", () => {
  const initial = initialRenderState(live(1.2), 0);
  assert.deepEqual(initial.moments, []);
  assert.deepEqual(advance(initial, live(1.3), 100).moments, []);

  let state = initialRenderState(live(0.9), 0);
  state = advance(state, live(0.99), 1000);
  assert.deepEqual(state.moments, []);
  state = advance(state, live(1), 2000);
  assert.deepEqual(state.moments, [{ kind: "goal-met", at: 2000 }]);
  state = advance(state, live(1.1), 3000);
  assert.equal(state.moments.length, 1);
  state = advance(state, live(1.1), 2000 + SHIMMER_MS + 1);
  assert.deepEqual(state.moments, []);

  // A pinned goal met while it shows (a point marked, a session logged) celebrates too.
  const pin = advance(initialRenderState(pinned("glow", { fraction: 0.5 }), 0), pinned("glow", { fraction: 1 }), 10);
  assert.deepEqual(pin.moments, [{ kind: "goal-met", at: 10 }]);
  // Not for a new session whose goal was already met, nor for a duration goal never seen short of it.
  const again = advance(initialRenderState(live(1.2), 0), live(1.5, { key: "live:s2" }), 10);
  assert.deepEqual(again.moments, []);
  const unseen = advance(initialRenderState(OFF_SCENE, 0), live(1.5, { key: "live:s2" }), 10);
  assert.deepEqual(unseen.moments, []);
});

/** A scene of activity "a" with a count goal: `current` of `target` done, a live session counted in it. */
function counting(current, { kind = "live", key = "live:s3", target = 3 } = {}) {
  const scene = kind === "live" ? live(null, { key }) : { ...pinned("glow"), key: "pinned:a" };
  const goal = { type: "count", count: target };
  return { ...scene, activityId: "a", progress: { goal, period: "day", current, target, fraction: current / target } };
}

test("a count goal met by starting its final session shimmers, whatever showed before", () => {
  const MET = [{ kind: "goal-met", at: 1000 }];
  // Pinned at 2 of 3; the third session starts: a new key, and the goal is met with it.
  const pinnedFirst = initialRenderState(counting(2, { kind: "pinned" }), 0);
  const fromPin = advance(pinnedFirst, counting(3), 1000);
  assert.equal(fromPin.previous, pinnedFirst.scene);
  assert.deepEqual(fromPin.moments, MET);
  // From an idle wall: the live session is the one counted, so the goal stood at 2 of 3 before it.
  assert.deepEqual(advance(initialRenderState(OFF_SCENE, 0), counting(3), 1000).moments, MET);
  // From another activity's session, too.
  const other = initialRenderState({ ...live(0.5, { key: "live:s9", rgb: GREEN }), activityId: "z" }, 0);
  assert.deepEqual(advance(other, counting(3), 1000).moments, MET);
  // A fourth session on a goal of 3 had it met already; so had the session after the one that met it.
  assert.deepEqual(advance(initialRenderState(OFF_SCENE, 0), counting(4), 1000).moments, []);
  const next = advance(initialRenderState(counting(3), 0), counting(4, { key: "live:s4" }), 1000);
  assert.deepEqual(next.moments, []);
  // The wave plays over the crossfade: nothing jumps at the change.
  assert.deepEqual(shown(fromPin, 1000), shown(pinnedFirst, 1000));
});

test("the last goal fraction per activity is remembered across other scenes, a few activities deep", () => {
  const goalOf = (id, fraction) => ({ ...pinned("glow", { fraction }), key: `pinned:${id}`, activityId: id });
  let state = initialRenderState(goalOf("a", 0.9), 0);
  state = advance(state, goalOf("b", 0.2), 1000);
  state = advance(state, OFF_SCENE, 2000);
  // Another member's session met "a"'s goal while it didn't show: the wall celebrates when it shows it again.
  state = advance(state, goalOf("a", 1.1), 3000);
  assert.deepEqual(state.moments, [{ kind: "goal-met", at: 3000 }]);
  for (let i = 0; i < 20; i++) state = advance(state, goalOf(`x${i}`, 0.5), 4000 + i * 10);
  assert.ok(state.goals.length <= 8, `${state.goals.length} remembered`);
  assert.deepEqual(state.goals[0], { activityId: "x19", fraction: 0.5 });
});

test("the goal-met wave whitens panels along the order, then leaves; a new scene fades it out with the old", () => {
  const state = advance(initialRenderState(live(0.95), 0), live(1), 1000);
  const n = ORDER.length;
  // s = dt/SHIMMER_MS·(n+5) − 3 is 2 here: position 2 is at the crest.
  const crest = 1000 + (5 / (n + 5)) * SHIMMER_MS;
  const frame = colours(state, crest);
  assert.deepEqual(frame[2], [255, 128, 128]);
  assert.ok(frame[0][1] < frame[1][1] && frame[1][1] < frame[2][1], "rising towards the crest");
  assert.deepEqual(levels(state, crest), [1, 1, 1, 1, 1]);
  assert.deepEqual(colours(state, crest, ORDER, { reducedMotion: true }), Array(5).fill(RED));
  // It starts and ends off the order, so no panel steps when it arrives or leaves.
  assert.deepEqual(colours(state, 1000), Array(5).fill(RED));
  assert.deepEqual(colours(state, 1000 + SHIMMER_MS), Array(5).fill(RED));
  assert.deepEqual(colours(state, 1000 + SHIMMER_MS + 1), Array(5).fill(RED));
  // A new scene drops the moment, and the wave goes out with the scene that met its goal.
  const ended = advance(state, OFF_SCENE, 1100);
  assert.deepEqual(ended.moments, []);
  assert.deepEqual(shown(ended, 1100), shown(state, 1100));
  assert.equal(isAnimating(ended, 1100 + FADE_MS + STAGGER_MAX_MS + 1), false);
});

test("withPreview: renewals keep the state; a start, a mode change or new identify panels restart its clock", () => {
  const start = initialRenderState(live(0.5), 0);
  const fill = withPreview(start, { mode: "fill", fraction: 0.3, rgb: null }, 100);
  assert.equal(fill.previewAt, 100);
  assert.equal(fill.previewFadeAt, 100);
  assert.equal(withPreview(fill, { mode: "fill", fraction: 0.3, rgb: null }, 500), fill, "same value");
  const scrubbed = withPreview(fill, { mode: "fill", fraction: 0.4, rgb: null }, 500);
  assert.equal(scrubbed.preview.fraction, 0.4);
  assert.equal(scrubbed.previewAt, 100, "scrubbing doesn't re-fade");
  assert.equal(scrubbed.previewFadeAt, 100);
  const identify = withPreview(scrubbed, { mode: "identify", panelIds: [11], rgb: null }, 600);
  assert.equal(identify.previewAt, 600);
  assert.equal(identify.previewFrom.preview, scrubbed.preview, "fades from the fill, not from the scene");
  assert.equal(withPreview(identify, { mode: "identify", panelIds: [11], rgb: null }, 700), identify);
  assert.equal(withPreview(identify, { mode: "identify", panelIds: [12], rgb: null }, 700).previewAt, 700);
  // A new colour fades but keeps the blink clock.
  const recoloured = withPreview(identify, { mode: "identify", panelIds: [11], rgb: RED }, 700);
  assert.equal(recoloured.previewAt, 600);
  assert.equal(recoloured.previewFadeAt, 700);
  const cleared = withPreview(identify, null, 800);
  assert.equal(cleared.preview, null);
  assert.equal(cleared.previewAt, 600, "an ended preview keeps its phase while it fades out");
  assert.equal(withPreview(cleared, null, 900), cleared);
  assert.equal(cleared.scene, start.scene);
});

/* ---- Previews ---- */

test("identify preview: listed panels full and blinking twice, the others dim, fading in over the scene", () => {
  const base = initialRenderState(live(null, { rgb: RED }), 0);
  const state = withPreview(base, { mode: "identify", panelIds: [12], rgb: GREEN }, 1000);
  assert.deepEqual(levels(state, 1000), [1, 1, 1, 1, 1], "starts from the scene");
  const half = levels(state, 1000 + PREVIEW_FADE_MS / 2);
  close(half[0], 1 + (IDENTIFY_DIM - 1) * 0.5);
  closeAll(levels(state, 1300), [IDENTIFY_DIM, IDENTIFY_DIM, 1, IDENTIFY_DIM, IDENTIFY_DIM]);
  assert.deepEqual(colours(state, 1300), Array(5).fill(GREEN));
  close(levels(state, 1450)[2], 0.35, "second dip");
  close(levels(state, 1250)[2], 0.35 + 0.65 * Math.abs(Math.cos((Math.PI * 250) / 300)));
  close(levels(state, 1700)[2], 1, "blinking is over");
  close(levels(state, 1450, ORDER, { reducedMotion: true })[2], 1, "no blinks with reduced motion");
  // The two dips inside the first 600 ms.
  let dips = 0;
  let prev = levels(state, 1000)[2];
  let falling = false;
  for (let t = 1001; t < 1600; t++) {
    const level = levels(state, t)[2];
    if (level > prev && falling) dips++;
    falling = level < prev;
    prev = level;
  }
  assert.equal(dips, 2);
});

test("fill preview: the live fill with the track and no breathing, in the scene's colour by default", () => {
  const base = initialRenderState(pinned("pulse"), 0);
  const state = withPreview(base, { mode: "fill", fraction: 0.35, rgb: null }, 0);
  const expected = [1, TRACK + (1 - TRACK) * 0.75, TRACK, TRACK, TRACK];
  closeAll(levels(state, PREVIEW_FADE_MS), expected);
  closeAll(levels(state, EDGE_MS / 2), expected);
  assert.deepEqual(colours(state, EDGE_MS / 2), Array(5).fill(BLUE));
  const offBase = withPreview(initialRenderState(OFF_SCENE, 0), { mode: "fill", fraction: 1, rgb: null }, 0);
  assert.deepEqual(colours(offBase, 50), Array(5).fill(WARM_WHITE), "no scene colour: warm white, no grey");
});

test("order preview: a sweep along the order that loops every P", () => {
  assert.equal(orderSweepMs(5), 1250);
  assert.equal(orderSweepMs(1), 1200);
  assert.equal(orderSweepMs(40), 4200);
  const state = withPreview(initialRenderState(OFF_SCENE, 0), { mode: "order", rgb: RED }, 0);
  const P = orderSweepMs(ORDER.length);
  closeAll(levels(state, P), [0.1, 0.1, 0.1, 0.1, 0.1]);
  closeAll(levels(state, P + P / 2), [1, 1, 1, 0.55, 0.1]);
  for (const t of [300, 777, 1100]) closeAll(levels(state, t + P), levels(state, t + 2 * P), `t=${t}`);
  // Earlier positions light first.
  const quarter = levels(state, P + P / 4);
  for (let k = 1; k < ORDER.length; k++) assert.ok(quarter[k] <= quarter[k - 1]);
});

test("an ended preview fades back to the scene over PREVIEW_FADE_MS instead of snapping", () => {
  const base = initialRenderState(live(null, { rgb: RED }), 0);
  const request = { mode: "fill", fraction: 0, rgb: GREEN };
  const showing = withPreview(base, request, 0);
  closeAll(levels(showing, 1000), Array(5).fill(TRACK));
  const ended = withPreview(showing, null, 1000);
  assert.equal(ended.preview, null);
  assert.equal(ended.previewFrom.preview, showing.preview);
  closeAll(levels(ended, 1000), Array(5).fill(TRACK), "starts where the preview was");
  closeAll(levels(ended, 1000 + PREVIEW_FADE_MS / 2), Array(5).fill(TRACK + (1 - TRACK) * 0.5));
  assert.deepEqual(levels(ended, 1000 + PREVIEW_FADE_MS), [1, 1, 1, 1, 1]);
  assert.deepEqual(colours(ended, 1000 + PREVIEW_FADE_MS), Array(5).fill(RED));
  assert.equal(isAnimating(ended, 1100), true);
  assert.equal(isAnimating(ended, 1000 + PREVIEW_FADE_MS), false);
  // advance keeps it while it fades, then drops it.
  assert.equal(advance(ended, ended.scene, 1100), ended);
  assert.equal(advance(ended, ended.scene, 1000 + PREVIEW_FADE_MS).previewFrom, null);
  // One that ends before it had faded in goes back from where it got to, never up first.
  const brief = withPreview(showing, null, PREVIEW_FADE_MS / 2);
  close(levels(showing, PREVIEW_FADE_MS / 2)[0], 1 + (TRACK - 1) * 0.5);
  close(levels(brief, PREVIEW_FADE_MS / 2)[0], 1 + (TRACK - 1) * 0.5);
  for (let t = PREVIEW_FADE_MS / 2; t <= PREVIEW_FADE_MS * 2; t += 10) {
    assert.ok(levels(brief, t + 10)[4] >= levels(brief, t)[4], `only back up to the scene at ${t}`);
  }
  // A preview shown again while one fades out picks up from where the fade-out got to.
  const again = withPreview(ended, request, 1060);
  assert.equal(again.previewAt, 1060);
  assert.deepEqual(shown(again, 1060), shown(ended, 1060));
  closeAll(levels(again, 1060 + PREVIEW_FADE_MS), Array(5).fill(TRACK));
});

/* ---- Frames and animation ---- */

test("frames cover exactly the ordered panels and are deterministic", () => {
  const state = advance(initialRenderState(pinned("pulse", { fraction: 0.6 }), 0), live(0.3), 500);
  assert.equal(renderFrame(state, [], 700).size, 0);
  const frame = renderFrame(state, [3, 1, 2], 700);
  assert.deepEqual([...frame.keys()], [3, 1, 2]);
  assert.deepEqual(renderFrame(state, [3, 1, 2], 700), frame);
  for (const light of frame.values()) assert.ok(light.level >= 0 && light.level <= 1);
});

test("fillingPosition names the panel that is filling", () => {
  assert.equal(fillingPosition(progress(0.35), 5), 1);
  assert.equal(fillingPosition(progress(0.999), 5), 4);
  assert.equal(fillingPosition(progress(0), 5), null);
  assert.equal(fillingPosition(progress(1), 5), null);
  assert.equal(fillingPosition(null, 5), null);
  assert.equal(fillingPosition(progress(0.5), 0), null);
});

test("isAnimating: crossfades, moments, previews, pulses and part-way live goals", () => {
  assert.equal(isAnimating(initialRenderState(live(null), 0), 10), false);
  assert.equal(isAnimating(initialRenderState(live(1), 0), 10), false);
  assert.equal(isAnimating(initialRenderState(live(0), 0), 10), false);
  assert.equal(isAnimating(initialRenderState(live(0.5), 0), 10), true);
  assert.equal(isAnimating(initialRenderState(pinned("pulse"), 0), 10), true);
  assert.equal(isAnimating(initialRenderState(pinned("glow", { fraction: 0.5 }), 0), 10), false);
  assert.equal(isAnimating(initialRenderState(OFF_SCENE, 0), 10), false);
  const fading = advance(initialRenderState(OFF_SCENE, 0), live(null), 1000);
  assert.equal(isAnimating(fading, 1500), true);
  assert.equal(isAnimating(fading, 1000 + FADE_MS + STAGGER_MAX_MS + 1), false, "finished, even before pruning");
  const met = advance(initialRenderState(live(0.9), 0), live(1), 1000);
  assert.equal(isAnimating(met, 1000 + SHIMMER_MS / 2), true);
  assert.equal(isAnimating(met, 1000 + SHIMMER_MS + 1), false);
  const previewing = withPreview(initialRenderState(OFF_SCENE, 0), { mode: "order", rgb: null }, 0);
  assert.equal(isAnimating(previewing, 99999), true);
});

/* ---- On the wall (device colours) ---- */

const NOW = new Date(2026, 8, 30, 12, 0).getTime();
/** An orange activity (#F97316) with a 1 h daily goal, pinned by "me". */
const ORANGE = {
  id: "a",
  name: "Practice",
  trackingType: "span",
  color: "#F97316",
  iconPath: null,
  archived: false,
  goal: { type: "duration", seconds: 3600 },
  period: "day",
  pinnedBy: ["me"],
};
const span = (id, status, from, to) => ({
  id,
  activityId: "a",
  type: "span",
  status,
  memberIds: ["me"],
  startedAt: new Date(NOW - from * 60000),
  endedAt: to === null ? null : new Date(NOW - to * 60000),
});

/** Wall colours for `sessions` under `settings`: decideScene, renderFrame, then deviceRgb, as main sends them. */
function wall(sessions, settings, t, order = [1, 2, 3, 4, 5]) {
  const scene = decideScene({ userId: "me", activities: [ORANGE], sessions, settings, now: NOW });
  const frame = renderFrame(initialRenderState(scene, NOW), order, t);
  return order.map((id) => deviceRgb(frame.get(id)));
}

/** Whether a device colour is lit, bright enough to see, and in the activity's hue (255:118:23, within rounding). */
function orangeOn(rgb) {
  const top = rgb[0];
  return top >= 8 && rgb[1] > 0 && rgb[2] > 0 && Math.abs(rgb[1] - (118 / 255) * top) <= 0.5 &&
    Math.abs(rgb[2] - (23 / 255) * top) <= 1;
}

test("35% of a 5-panel goal on the wall: full, three quarters, then a faint track that shows in the colour", () => {
  // 21 min of a 1 h goal, default settings (faint track on), at the breathing panel's trough.
  const t = Math.ceil(NOW / EDGE_MS) * EDGE_MS;
  const live = [span("s1", "live", 21, null)];
  const track = [27, 12, 2];
  assert.deepEqual(wall(live, DEFAULT_SETTINGS, t), [[255, 118, 23], [198, 92, 18], track, track, track]);
  for (const rgb of wall(live, DEFAULT_SETTINGS, t)) assert.ok(orangeOn(rgb), `${rgb}`);
  // With the track off the rest is dark, so the switch shows on the wall.
  assert.deepEqual(wall(live, { ...DEFAULT_SETTINGS, track: false }, t).slice(2), [[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  // The first session of the day, at 0 minutes: the whole track glows instead of the wall going dark.
  for (const rgb of wall([span("s1", "live", 0, null)], DEFAULT_SETTINGS, t)) assert.ok(orangeOn(rgb), `${rgb}`);
});

test("the default pinned glow and pulse stay visible on the wall, track and trough included, in the colour", () => {
  const done = [span("s0", "completed", 60, 39)];
  const glow = wall(done, { ...DEFAULT_SETTINGS, pinnedStyle: "glow" }, NOW);
  assert.deepEqual(glow, [[94, 43, 8], [74, 34, 7], [15, 7, 1], [15, 7, 1], [15, 7, 1]]);
  // The pulse at the wall's 10 Hz over a period: every panel lit and orange all the way down to its trough.
  let trough = 255;
  const seen = new Set();
  for (let t = NOW; t < NOW + PULSE_MS; t += 100) {
    const frame = wall(done, DEFAULT_SETTINGS, t);
    for (const rgb of frame) {
      assert.ok(orangeOn(rgb), `${rgb} at ${t - NOW}`);
      trough = Math.min(trough, rgb[0]);
    }
    seen.add(frame[0].join());
  }
  assert.ok(trough >= 8, `trough ${trough}`);
  assert.ok(seen.size >= 15, `the first panel takes ${seen.size} steps over a period`);
  // A pinned goal at 0% (a new day) keeps a visible track rather than a black wall, even with the track off.
  for (const rgb of wall([], DEFAULT_SETTINGS, NOW + 1000)) assert.ok(orangeOn(rgb), `${rgb}`);
  for (const rgb of wall([], { ...DEFAULT_SETTINGS, pinnedStyle: "glow", track: false }, NOW)) {
    assert.ok(orangeOn(rgb), `${rgb}`);
  }
  // The lowest pinned level still reads.
  for (const rgb of wall(done, { ...DEFAULT_SETTINGS, pinnedStyle: "glow", pinnedLevel: 10 }, NOW)) {
    assert.ok(orangeOn(rgb), `${rgb}`);
  }
});

/* ---- Interruptions ---- */

const TWELVE = Array.from({ length: 12 }, (_, i) => 100 + i);

test("stop, then start again 800 ms later: the new fade starts from what is lit, never from the old scene", () => {
  const a = live(null, { key: "live:s1", rgb: RED });
  const b = live(null, { key: "live:s2", rgb: BLUE });
  const stopping = advance(initialRenderState(a, 0), OFF_SCENE, 1000);
  const starting = advance(stopping, b, 1800);
  assert.deepEqual(shown(starting, 1800, TWELVE), shown(stopping, 1800, TWELVE));
  assert.deepEqual(shown(starting, 1799, TWELVE), shown(stopping, 1799, TWELVE));
  // At the wall's 10 Hz every step is a fade's step: at most two eased fades' worth (1.5/FADE_MS per ms each).
  const limit = 2 * (1.5 / FADE_MS) * 100;
  for (let t = 1000; t <= 1800 + FADE_MS + STAGGER_MAX_MS; t += 100) {
    const now = levels(starting, t, TWELVE);
    const next = levels(starting, t + 100, TWELVE);
    now.forEach((level, k) => assert.ok(Math.abs(next[k] - level) <= limit, `${k} at ${t}: ${level} → ${next[k]}`));
  }
  assert.deepEqual(levels(starting, 1800 + FADE_MS + STAGGER_MAX_MS, TWELVE), Array(12).fill(1));
  assert.deepEqual(colours(starting, 1800 + FADE_MS + STAGGER_MAX_MS, TWELVE), Array(12).fill(BLUE));
});

test("a colour switched again mid-crossfade blends on from the mix, never back to the first colour", () => {
  const state0 = initialRenderState(live(null, { key: "live:s1", rgb: RED }), 0);
  const state1 = advance(state0, live(null, { key: "live:s2", rgb: GREEN }), 1000);
  const state2 = advance(state1, live(null, { key: "live:s3", rgb: BLUE }), 1300);
  assert.deepEqual(shown(state2, 1300, TWELVE), shown(state1, 1300, TWELVE));
  let red = colours(state2, 1300, TWELVE)[0][0];
  assert.ok(red < 255);
  for (let t = 1310; t <= 3000; t += 10) {
    const next = colours(state2, t, TWELVE)[0][0];
    assert.ok(next <= red, `red goes one way at ${t}: ${red} → ${next}`);
    red = next;
  }
  assert.deepEqual(colours(state2, 3000, TWELVE), Array(12).fill(BLUE));
});

test("any change, at any moment, leaves the frame at that moment exactly as it was", () => {
  // Scenes, previews and times from a seeded generator: swaps, adjustments, goals met, previews started, replaced,
  // recoloured and cleared, landing in the middle of each other's fades (fill scrubbing aside, which is instant).
  const colourList = [RED, GREEN, BLUE, [255, 118, 23]];
  for (let seed = 1; seed <= 60; seed++) {
    const random = mulberry32(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const scene = () => {
      if (random() < 0.15) return OFF_SCENE;
      const kind = random() < 0.5 ? "live" : "pinned";
      const fraction = random() < 0.2 ? null : Math.floor(random() * 12) / 10;
      const activityId = pick(["a", "b", "c"]);
      const count = random() < 0.5;
      return {
        kind,
        key: kind === "live" ? pick(["live:s1", "live:s2"]) : `pinned:${activityId}`,
        activityId,
        cssColor: "",
        rgb: pick(colourList),
        progress: fraction === null ? null : {
          goal: count ? { type: "count", count: 5 } : { type: "duration", seconds: 100 },
          period: "day",
          current: fraction * (count ? 5 : 100),
          target: count ? 5 : 100,
          fraction,
        },
        level: kind === "live" ? 1 : pick([0.35, 0.8]),
        style: pick(["glow", "pulse"]),
        track: random() < 0.5,
      };
    };
    const preview = () => {
      const x = random();
      if (x < 0.3) return null;
      if (x < 0.55) return { mode: "identify", panelIds: [pick(TWELVE)], rgb: random() < 0.5 ? null : RED };
      if (x < 0.8) return { mode: "fill", fraction: Math.floor(random() * 10) / 10, rgb: null };
      return { mode: "order", rgb: random() < 0.5 ? null : GREEN };
    };
    const opts = random() < 0.25 ? { reducedMotion: true } : undefined;
    let t = 1000;
    let state = initialRenderState(scene(), t);
    for (let step = 0; step < 40; step++) {
      t += 100 + Math.floor(random() * (random() < 0.7 ? 250 : 2000));
      const before = shown(state, t, TWELVE, opts);
      let next;
      if (random() < 0.6) next = advance(state, scene(), t);
      else {
        const request = preview();
        if (request?.mode === "fill" && state.preview?.mode === "fill") continue;
        next = withPreview(state, request, t);
      }
      assert.deepEqual(shown(next, t, TWELVE, opts), before, `seed ${seed}, step ${step}`);
      state = next;
    }
  }
});

test("changes piling up faster than they fade stay bounded, and settle once they stop", () => {
  let state = initialRenderState(pinned("glow", { level: 0.1 }), 0);
  for (let i = 1; i <= 70; i++) state = advance(state, pinned("glow", { level: (10 + i) / 100 }), i * 16);
  let depth = 0;
  for (let layer = state; layer.from; layer = layer.from) depth++;
  assert.ok(depth <= 8, `${depth} layers deep`);
  // A slider dragged at 60 Hz moves the light smoothly, never by more than a slider step or so between frames.
  for (let t = 16; t < 70 * 16 + 400; t += 16) {
    const step = Math.abs(levels(state, t + 16)[0] - levels(state, t)[0]);
    assert.ok(step < 0.05, `${step} at ${t}`);
  }
  const settled = advance(state, state.scene, 70 * 16 + FADE_MS + STAGGER_MAX_MS + 1);
  assert.equal(settled.previous, null);
  assert.equal(settled.from, null);
  closeAll(levels(settled, 99999), Array(5).fill(0.8));
});

/* ---- Replacing previews ---- */

test("identify on another panel moves the highlight; the rest stays dimmed, never flashing the scene", () => {
  const base = initialRenderState(live(null, { rgb: RED }), 0);
  const first = withPreview(base, { mode: "identify", panelIds: [11], rgb: null }, 0);
  const second = withPreview(first, { mode: "identify", panelIds: [12], rgb: null }, 1000);
  assert.deepEqual(shown(second, 1000), shown(first, 1000));
  for (let t = 1000; t <= 1000 + 2 * PREVIEW_FADE_MS; t += 5) {
    const [a, b, c, d, e] = levels(second, t);
    for (const other of [a, d, e]) close(other, IDENTIFY_DIM, `the others at ${t}`);
    assert.ok(b <= 1 && c <= 1);
  }
  close(levels(second, 1000 + PREVIEW_FADE_MS)[1], IDENTIFY_DIM, "the old highlight dims");
  assert.equal(second.previewAt, 1000, "the new panel blinks from the start");
});

test("switching from the goal scrubber to Play order fades between them, not through the scene", () => {
  const base = initialRenderState(live(null, { rgb: RED }), 0);
  const fill = withPreview(base, { mode: "fill", fraction: 0.25, rgb: null }, 0);
  closeAll(levels(fill, 1000), [1, TRACK + (1 - TRACK) * 0.25, TRACK, TRACK, TRACK]);
  const order = withPreview(fill, { mode: "order", rgb: null }, 1000);
  assert.deepEqual(shown(order, 1000), shown(fill, 1000));
  for (let t = 1000; t <= 1000 + PREVIEW_FADE_MS; t += 5) {
    for (const level of levels(order, t).slice(2)) assert.ok(level < 0.2, `unfilled panels stay low at ${t}: ${level}`);
  }
});

test("a preview's new colour fades in; its blinks and sweep keep their phase", () => {
  const base = initialRenderState(OFF_SCENE, 0);
  const green = withPreview(base, { mode: "order", rgb: GREEN }, 0);
  const red = withPreview(green, { mode: "order", rgb: RED }, 1000);
  assert.deepEqual(shown(red, 1000), shown(green, 1000));
  assert.deepEqual(levels(red, 1100), levels(green, 1100), "same sweep");
  const half = colours(red, 1000 + PREVIEW_FADE_MS / 2)[0];
  assert.ok(half[0] > 0 && half[1] > 0, `mixed halfway: ${half}`);
  assert.deepEqual(colours(red, 1000 + PREVIEW_FADE_MS)[0], RED);
});

/* ---- Taking the wall ---- */

test("fromDark fades the scene and preview in from dark, keeping a goal just met and the goal memory", () => {
  const met = advance(initialRenderState(OFF_SCENE, 0), counting(3), 1000);
  const previewing = withPreview(met, { mode: "identify", panelIds: [12], rgb: null }, 1000);
  const taken = fromDark(previewing, 1050);
  assert.equal(taken.scene, met.scene);
  assert.equal(taken.previous, OFF_SCENE);
  assert.equal(taken.changedAt, 1050);
  assert.deepEqual(taken.moments, met.moments);
  assert.equal(taken.goals, met.goals);
  assert.equal(taken.preview, previewing.preview);
  assert.equal(taken.previewFadeAt, 1050);
  assert.deepEqual(levels(taken, 1050, ORDER, { reducedMotion: true }), [0, 0, 0, 0, 0], "starts dark");
  assert.deepEqual(levels(fromDark(met, 1050), 1050 + FADE_MS + STAGGER_MAX_MS + SHIMMER_MS), [1, 1, 1, 1, 1]);
});

/* ---- Schedule alerts ---- */

const ALERT_ORDER = [10, 11, 12, 13, 14];
const ALERT_RED = [255, 0, 0];
const ALERT_BLUE = [0, 0, 255];

test("a schedule alert swells every panel together, twice, from the scene and back to it", () => {
  const scene = { ...OFF_SCENE, kind: "pinned", key: "pinned:a", activityId: "a", rgb: ALERT_BLUE, level: 0.4 };
  const settled = initialRenderState(scene, 0);
  const state = withAlert(settled, ALERT_RED, 1000);
  const at = (t) => [...renderFrame(state, ALERT_ORDER, t).values()];
  const before = at(1000);
  // Nothing jumps as it starts: the frame is the scene's.
  assert.deepEqual(before, [...renderFrame(settled, ALERT_ORDER, 1000).values()]);
  // Each beat peaks half-way at full level in the alert's colour, the same on every panel (no stagger).
  for (const beat of [0, 1]) {
    const peak = at(1000 + beat * ALERT_BEAT_MS + ALERT_BEAT_MS / 2);
    for (const light of peak) assert.deepEqual(light, { rgb: ALERT_RED, level: 1 });
  }
  // Between the beats it drops to its floor, whatever the scene's level.
  for (const light of at(1000 + ALERT_BEAT_MS)) assert.ok(Math.abs(light.level - ALERT_LOW) < 1e-9);
  // Rising through the fade-in, and noticed well within a second.
  assert.ok(at(1000 + ALERT_IN_MS)[0].level > 0.5);
  // Over: the scene again, and nothing left animating.
  assert.deepEqual(at(1000 + ALERT_MS), [...renderFrame(settled, ALERT_ORDER, 1000 + ALERT_MS).values()]);
  assert.equal(alerting(state, 1000 + ALERT_MS), true);
  assert.equal(alerting(state, 1000 + ALERT_MS + 1), false);
  assert.equal(isAnimating({ ...state, scene: { ...scene, style: "glow" } }, 1000 + ALERT_MS + 1), false);
  assert.equal(isAnimating({ ...state, scene: { ...scene, style: "glow" } }, 1500), true);
});

test("a schedule alert lights a dark wall in its own colour and leaves it dark", () => {
  const state = withAlert(initialRenderState(OFF_SCENE, 0), ALERT_RED, 0);
  for (const t of [50, 450, 900, 1350, 1900, 2250]) {
    for (const light of renderFrame(state, ALERT_ORDER, t).values()) {
      assert.deepEqual(light.rgb, ALERT_RED, `no warm white mixed in at ${t}`);
      assert.ok(light.level > 0);
    }
  }
  for (const light of renderFrame(state, ALERT_ORDER, ALERT_MS).values()) assert.equal(light.level, 0);
});

test("alerts that fire together play one after the other, covers a preview, and advance drops finished ones", () => {
  const base = withPreview(initialRenderState(OFF_SCENE, 0), { mode: "order", rgb: null }, 0);
  let state = withAlert(base, ALERT_RED, 1000);
  state = withAlert(state, ALERT_BLUE, 1010);
  assert.deepEqual(
    state.alerts.map((a) => a.at),
    [1000, 1000 + ALERT_BEATS_MS],
    "the second starts as the first one's beats end",
  );
  const light = (t) => renderFrame(state, ALERT_ORDER, t).get(10);
  assert.deepEqual(light(1000 + ALERT_BEAT_MS / 2), { rgb: ALERT_RED, level: 1 }, "over the preview's sweep");
  assert.deepEqual(light(1000 + ALERT_BEATS_MS + ALERT_BEAT_MS / 2), { rgb: ALERT_BLUE, level: 1 });
  // A full queue drops what comes next.
  let full = state;
  for (let i = state.alerts.length; i < ALERT_QUEUE; i++) full = withAlert(full, ALERT_RED, 1020);
  assert.equal(full.alerts.length, ALERT_QUEUE);
  assert.equal(withAlert(full, ALERT_RED, 1030), full);
  // advance keeps running alerts across a scene change and sheds them once over.
  const during = advance(state, { ...OFF_SCENE, kind: "live", key: "live:s", activityId: "a", rgb: ALERT_BLUE, level: 1 }, 1500);
  assert.equal(during.alerts.length, 2);
  const after = advance(during, during.scene, 1000 + ALERT_BEATS_MS + ALERT_MS + 1);
  assert.equal(after.alerts.length, 0);
  assert.equal(advance(after, after.scene, 99_999), after, "nothing changed: the same state");
});

test("reduced motion holds an alert steady instead of swelling", () => {
  const state = withAlert(initialRenderState(OFF_SCENE, 0), ALERT_RED, 0);
  const a = renderFrame(state, ALERT_ORDER, ALERT_BEAT_MS / 2, { reducedMotion: true }).get(10).level;
  const b = renderFrame(state, ALERT_ORDER, ALERT_BEAT_MS, { reducedMotion: true }).get(10).level;
  assert.equal(a, b);
});
