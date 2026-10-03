import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTROL_PULSE_LOW,
  DEFAULT_PERIOD_MS,
  effectDuration,
  effectLight,
  MAX_COLORS,
  prepareEffect,
  readEffect,
  REVEAL_BEAT_LOW,
  REVEAL_BEAT_MS,
  REVEAL_LOCK_MS,
  REVEAL_MS,
  revealLockAt,
  sameSpec,
  SHUFFLE_FADE_MS,
  SHUFFLE_LOW,
} from "../shared/effects.ts";
import {
  ADJUST_FADE_MS,
  advance,
  ALERT_BEAT_MS,
  FADE_MS,
  initialRenderState,
  isAnimating,
  renderFrame,
  STAGGER_MAX_MS,
  withAlert,
  withPreview,
} from "../shared/render.ts";
import { controlScene, decideScene, OFF_SCENE } from "../shared/scene.ts";
import { DEFAULT_SETTINGS } from "../shared/storage.ts";

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const T0 = 1_000_000;
const ORDER = [10, 11, 12, 13, 14, 15, 16, 17, 18];
const N = ORDER.length;

const effect = (type, extra = {}) => ({
  id: `e-${type}`,
  type,
  colors: [RED, GREEN, BLUE],
  periodMs: DEFAULT_PERIOD_MS[type],
  color: type === "reveal" ? BLUE : null,
  startedAt: T0,
  ...extra,
});
const lease = (fx, leaseId = "l1") => ({ holder: "magic-cube", leaseId, effect: fx });
const scene = (fx, leaseId) => controlScene(lease(fx, leaseId));
const light = (fx, k, dt, n = N, reduced = false) => effectLight(prepareEffect(fx, n, T0 + dt, reduced), k);
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const inPalette = (rgb, colors) => colors.some((c) => same(c, rgb));

const liveScene = {
  kind: "live",
  key: "live:s1",
  activityId: "a",
  cssColor: "#ff00ff",
  rgb: [255, 0, 255],
  progress: null,
  level: 1,
  style: "glow",
  track: false,
};

/* ---- Reading a request ---- */

test("readEffect: CSS colours become LED colours, the period defaults per type, and bad requests say why", () => {
  assert.deepEqual(readEffect({ type: "pulse", colors: ["#800000", "nonsense", "rgb(0 0 255)"] }), {
    type: "pulse",
    colors: [RED, BLUE],
    periodMs: 4000,
    color: null,
  });
  assert.equal(readEffect({ type: "shuffle", colors: ["red"] }).periodMs, 900);
  assert.equal(readEffect({ type: "shuffle", colors: ["red"], periodMs: 50 }).periodMs, 400);
  assert.deepEqual(readEffect({ type: "reveal", colors: ["red"], color: "#00f" }).color, BLUE);
  assert.match(readEffect({ type: "strobe", colors: ["red"] }), /effect\.type/);
  assert.match(readEffect({ type: "pulse", colors: ["nope"] }), /at least one/);
  assert.match(readEffect({ type: "pulse", colors: Array(MAX_COLORS + 1).fill("red") }), /at most 12/);
  assert.match(readEffect({ type: "reveal", colors: ["red"] }), /effect\.color/);
});

test("sameSpec compares what an effect looks like, not when it started", () => {
  const a = readEffect({ type: "pulse", colors: ["red", "blue"] });
  assert.ok(sameSpec(a, readEffect({ type: "pulse", colors: ["#f00", "#00f"] })));
  assert.ok(!sameSpec(a, readEffect({ type: "pulse", colors: ["blue", "red"] })));
  assert.ok(!sameSpec(a, readEffect({ type: "shuffle", colors: ["red", "blue"] })));
  assert.ok(!sameSpec(a, readEffect({ type: "pulse", colors: ["red", "blue"], periodMs: 3000 })));
  assert.equal(effectDuration("reveal"), REVEAL_MS);
  assert.equal(effectDuration("pulse"), null);
});

/* ---- The three effects ---- */

test("pulse spreads the palette along the order and travels as one wave, its trough still lit", () => {
  const fx = effect("pulse");
  for (let k = 0; k < N; k++) assert.deepEqual(light(fx, k, 1234).rgb, fx.colors[k % 3], `panel ${k}`);
  let min = 1;
  let max = 0;
  for (let dt = 0; dt < fx.periodMs; dt += 50) {
    const level = light(fx, 0, dt).level;
    min = Math.min(min, level);
    max = Math.max(max, level);
  }
  assert.ok(Math.abs(min - CONTROL_PULSE_LOW) < 0.01 && max > 0.99, `between the trough and full: ${min}–${max}`);
  // One whole period spans the wall: every panel is at a different point of it, which a pin's pulse (0.3) isn't.
  const levels = Array.from({ length: N }, (_, k) => light(fx, k, 1000).level);
  assert.ok(Math.max(...levels) - Math.min(...levels) > 0.7, `a full wave across the wall: ${levels}`);
  assert.equal(light(fx, 0, 500).level, light(fx, 0, 500 + fx.periodMs).level);
});

test("a one-colour pulse is one colour everywhere, still a travelling wave", () => {
  const fx = effect("pulse", { colors: [RED] });
  for (let k = 0; k < N; k++) assert.deepEqual(light(fx, k, 700).rgb, RED);
  assert.notEqual(light(fx, 0, 700).level, light(fx, 4, 700).level);
});

test("shuffle: every panel changes colour on its own, never to the colour it had, pulsing out of step", () => {
  const fx = effect("shuffle");
  const changes = [];
  for (let k = 0; k < N; k++) {
    let previous = null;
    let count = 0;
    for (let dt = SHUFFLE_FADE_MS; dt < 30_000; dt += 20) {
      const rgb = light(fx, k, dt).rgb;
      // Mid-crossfade it is a mix of two palette colours; settled, it is one of them.
      if (!inPalette(rgb, fx.colors)) continue;
      if (previous && !same(previous, rgb)) count++;
      previous = rgb;
    }
    changes.push(count);
    assert.ok(count > 15, `panel ${k} changed colour ${count} times in 30 s`);
  }
  assert.ok(new Set(changes).size > 1, `panels keep their own pace: ${changes}`);
  const levels = Array.from({ length: N }, (_, k) => light(fx, k, 400).level);
  assert.ok(new Set(levels.map((l) => l.toFixed(2))).size > N / 2, `out of step: ${levels}`);
  for (const level of levels) assert.ok(level >= SHUFFLE_LOW - 1e-9 && level <= 1);
});

test("shuffle never holds a colour for two steps in a row, with two colours or six", () => {
  for (const colors of [
    [RED, GREEN],
    [RED, GREEN, BLUE, [255, 255, 0], [0, 255, 255], [255, 0, 255]],
  ]) {
    const fx = effect("shuffle", { colors, periodMs: 1000 });
    for (let k = 0; k < 6; k++) {
      // A step lasts 600–1400 ms, so a settled colour seen for longer than that would be a repeat.
      let held = 0;
      let previous = null;
      for (let dt = 0; dt < 40_000; dt += 25) {
        const rgb = light(fx, k, dt).rgb;
        if (!inPalette(rgb, colors)) continue;
        held = previous && same(previous, rgb) ? held + 25 : 0;
        previous = rgb;
        assert.ok(held <= 1400, `panel ${k} of ${colors.length} colours held one for ${held} ms at ${dt}`);
      }
    }
  }
});

test("a one-colour shuffle is that colour everywhere, flickering out of step", () => {
  const fx = effect("shuffle", { colors: [GREEN] });
  for (let k = 0; k < N; k++) assert.deepEqual(light(fx, k, 1500).rgb, GREEN);
  assert.notEqual(light(fx, 0, 1500).level, light(fx, 1, 1500).level);
});

test("effects are deterministic, and another effect id shuffles differently", () => {
  const fx = effect("shuffle");
  const frame = (f, dt) => Array.from({ length: N }, (_, k) => light(f, k, dt));
  assert.deepEqual(frame(fx, 4321), frame({ ...fx }, 4321));
  assert.notDeepEqual(frame(fx, 4321), frame({ ...fx, id: "another" }, 4321));
});

test("reveal: panels lock to the winner one after another, the wall swells twice, then holds", () => {
  const fx = effect("reveal");
  for (let k = 1; k < N; k++) assert.ok(revealLockAt(k, N) > revealLockAt(k - 1, N));
  // Just after the first panel locked the last one is still shuffling.
  assert.deepEqual(light(fx, 0, 200).rgb, BLUE);
  assert.equal(light(fx, 0, 200).level, 1);
  assert.ok(revealLockAt(N - 1, N) > 200);
  // All locked by the end of the lock phase, on a wall of any size.
  for (const n of [1, 2, 9, 40]) {
    for (let k = 0; k < n; k++) {
      const at = light(fx, k, REVEAL_LOCK_MS, n);
      assert.deepEqual(at.rgb, BLUE, `panel ${k} of ${n}`);
      assert.equal(at.level, 1);
    }
  }
  // Two swells: down to the trough half a beat in, back to full at each beat.
  for (const beat of [0, 1]) {
    const trough = light(fx, 3, REVEAL_LOCK_MS + (beat + 0.5) * REVEAL_BEAT_MS).level;
    assert.ok(Math.abs(trough - REVEAL_BEAT_LOW) < 0.01, `trough ${beat}: ${trough}`);
    assert.ok(light(fx, 3, REVEAL_LOCK_MS + (beat + 1) * REVEAL_BEAT_MS).level > 0.99);
  }
  // The hold, and whatever comes after its lease would have ended: the winner at full.
  for (const dt of [REVEAL_MS - 300, REVEAL_MS, REVEAL_MS + 5000]) {
    assert.deepEqual(light(fx, 5, dt), { rgb: BLUE, level: 1 });
  }
});

test("reduced motion holds an effect steady: the palette spread, or the winner", () => {
  assert.deepEqual(light(effect("pulse"), 1, 900, N, true), { rgb: GREEN, level: 0.6 });
  assert.deepEqual(light(effect("shuffle"), 2, 900, N, true), { rgb: BLUE, level: 0.6 });
  assert.deepEqual(light(effect("reveal"), 7, 100, N, true), { rgb: BLUE, level: 1 });
});

/* ---- The control scene ---- */

test("decideScene: a held lock beats a live session and a pin, unless driving or control by others is off", () => {
  const session = {
    id: "s1",
    activityId: "a",
    type: "span",
    status: "live",
    memberIds: ["u1"],
    startedAt: new Date(T0),
    endedAt: null,
  };
  const activities = [{ id: "a", name: "a", trackingType: "span", color: "#f0f", iconPath: null, archived: false }];
  const input = { userId: "u1", activities, sessions: [session], now: T0, control: lease(effect("pulse")) };
  const decided = decideScene({ ...input, settings: DEFAULT_SETTINGS });
  assert.equal(decided.kind, "control");
  assert.equal(decided.key, "control:l1");
  assert.equal(decided.holder, "magic-cube");
  assert.equal(decided.activityId, null);
  assert.equal(decided.progress, null);
  assert.equal(decideScene({ ...input, settings: { ...DEFAULT_SETTINGS, allowControl: false } }).kind, "live");
  assert.equal(decideScene({ ...input, settings: { ...DEFAULT_SETTINGS, enabled: false } }).kind, "off");
  assert.equal(decideScene({ ...input, control: null, settings: DEFAULT_SETTINGS }).kind, "live");
});

/* ---- In the engine ---- */

const frameOf = (state, t) => [...renderFrame(state, ORDER, t).values()];

test("a controller's effect swaps in over the user's scene and back out, each frame continuous", () => {
  const settled = T0 + 10_000;
  let state = initialRenderState(liveScene, T0);
  const before = frameOf(state, settled);
  state = advance(state, scene(effect("pulse", { startedAt: settled })), settled);
  assert.deepEqual(frameOf(state, settled), before, "nothing jumps as it starts");
  const taken = settled + FADE_MS + STAGGER_MAX_MS + 10;
  for (const [k, l] of frameOf(state, taken).entries()) assert.deepEqual(l.rgb, [RED, GREEN, BLUE][k % 3]);
  assert.ok(isAnimating(advance(state, state.scene, taken), taken));
  // Released: back to the live scene, from what the effect showed at that moment.
  const released = taken + 3000;
  const during = frameOf(state, released);
  state = advance(state, liveScene, released);
  assert.deepEqual(frameOf(state, released), during);
  const after = frameOf(state, released + FADE_MS + STAGGER_MAX_MS + 10);
  for (const l of after) assert.deepEqual(l, { rgb: liveScene.rgb, level: 1 });
});

test("pulse to shuffle within one hold is a short adjustment, and the same effect again changes nothing", () => {
  const pulse = effect("pulse");
  let state = initialRenderState(scene(pulse), T0);
  assert.equal(advance(state, scene({ ...pulse }), T0 + 500), state, "an equal scene keeps the state");
  const at = T0 + 2000;
  const before = frameOf(state, at);
  state = advance(state, scene(effect("shuffle", { startedAt: at })), at);
  assert.equal(state.adjust, true);
  assert.deepEqual(frameOf(state, at), before);
  // Once the short fade is over the frame is the shuffle's alone.
  const later = at + ADJUST_FADE_MS + 1;
  const alone = frameOf(initialRenderState(scene(effect("shuffle", { startedAt: at })), at), later);
  assert.deepEqual(frameOf(state, later), alone);
  // Another hold is something else to show: the full staggered fade.
  assert.equal(advance(state, scene(effect("pulse"), "l2"), later).adjust, false);
});

test("the outgoing effect keeps its own clock through the fade, settled or interrupted", () => {
  const pulse = effect("pulse");
  const at = T0 + 1700;
  const pulseAt = (t) => frameOf(initialRenderState(scene(pulse), T0), t);
  // From a settled state: at the fade's first instant the frame is the pulse at its own phase, not restarted.
  let state = advance(initialRenderState(scene(pulse), T0), liveScene, at);
  assert.deepEqual(frameOf(state, at), pulseAt(at));
  const restarted = frameOf(initialRenderState(scene({ ...pulse, startedAt: at }), at), at);
  assert.notDeepEqual(frameOf(state, at), restarted);
  // Interrupted: a shuffle lands 100 ms into that fade, and then the live scene again 100 ms later.
  const second = at + 100;
  const mid = frameOf(state, second);
  state = advance(state, scene(effect("shuffle", { startedAt: second }), "l2"), second);
  assert.deepEqual(frameOf(state, second), mid);
  const third = second + 100;
  const again = frameOf(state, third);
  state = advance(state, liveScene, third);
  assert.deepEqual(frameOf(state, third), again);
});

test("a state built late draws the effect where it has got to: a page opened 2 s into a reveal", () => {
  const reveal = effect("reveal");
  const early = initialRenderState(scene(reveal), T0);
  const late = initialRenderState(scene(reveal), T0 + 2000);
  assert.deepEqual(frameOf(late, T0 + 2100), frameOf(early, T0 + 2100));
  for (const l of frameOf(late, T0 + 2100)) assert.deepEqual(l.rgb, BLUE, "past the lock: all on the winner");
});

test("a schedule alert and a preview draw over a controller's effect, whose clock goes on underneath", () => {
  const reveal = effect("reveal");
  let state = initialRenderState(scene(reveal), T0);
  state = withAlert(state, [255, 255, 0], T0);
  const peak = T0 + ALERT_BEAT_MS / 2;
  for (const l of frameOf(state, peak)) assert.ok(l.rgb[0] > 200 && l.rgb[1] > 200 && l.rgb[2] < 60, `alert: ${l.rgb}`);
  // Once the alert has gone the reveal is where it would have been anyway: it wasn't paused.
  const after = T0 + 2500;
  assert.deepEqual(frameOf(state, after), frameOf(initialRenderState(scene(reveal), T0), after));

  let previewed = withPreview(initialRenderState(scene(effect("pulse")), T0), { mode: "identify", panelIds: [12], rgb: null }, T0);
  const shown = renderFrame(previewed, ORDER, T0 + 2000);
  assert.equal(shown.get(12).level, 1);
  assert.ok(shown.get(10).level < 0.1, "the other panels are dimmed over the effect");
  previewed = withPreview(previewed, null, T0 + 2000);
  assert.deepEqual(frameOf(previewed, T0 + 3000), frameOf(initialRenderState(scene(effect("pulse")), T0), T0 + 3000));
});

test("off to a controller's effect and back fades without passing through grey", () => {
  const at = T0 + 100;
  const state = advance(initialRenderState(OFF_SCENE, T0), scene(effect("pulse", { startedAt: at })), at);
  for (const [k, l] of frameOf(state, at + 300).entries()) {
    if (l.level > 0) assert.deepEqual(l.rgb, [RED, GREEN, BLUE][k % 3], `panel ${k} fades in in its own colour`);
  }
});
