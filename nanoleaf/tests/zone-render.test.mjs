import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { layoutFromPanelLayout, placeLayout } from "../shared/geometry.ts";
import { fillSpans, mulberry32, resolveOrder } from "../shared/order.ts";
import {
  advance,
  ALERT_MS,
  FADE_MS,
  initialRenderState,
  renderFrame,
  STAGGER_MAX_MS,
  withAlert,
  withPreview,
} from "../shared/render.ts";
import { controlScene, OFF_SCENE } from "../shared/scene.ts";
import { DEFAULT_ORDER, DEFAULT_SETTINGS, readZones } from "../shared/storage.ts";
import { advanceZones, renderZones, updateZones, zoneScales, zonesBrightness } from "../shared/zone-render.ts";
import { combinedOrder, resolveZones, zoneFills } from "../shared/zones.ts";

const OWNER = { id: "sam", name: "Sam", role: "OWNER" };
const JO = { id: "jo", name: "Jo", role: "MEMBER" };
const RILEY = { id: "riley", name: "Riley", role: "MEMBER" };
const MEMBERS = [OWNER, JO, RILEY];
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const ORANGE = [255, 118, 23];

const layoutOf = (name) => {
  const data = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
  return layoutFromPanelLayout(data.panelLayout, data.serialNo, "2026-09-30T12:00:00.000Z");
};
/** A wall big enough to split three ways. */
const PLACED = placeLayout(layoutOf("big"), 0).panels;
const IDS = PLACED.map((p) => p.id);

function progress(fraction, count = false) {
  if (fraction === null) return null;
  return {
    goal: count ? { type: "count", count: 5 } : { type: "duration", seconds: 100 },
    period: "day",
    current: fraction * (count ? 5 : 100),
    target: count ? 5 : 100,
    fraction,
  };
}

function live(fraction = 0.4, { key = "live:s1", rgb = RED, activityId = "a" } = {}) {
  return { kind: "live", key, activityId, cssColor: "", rgb, progress: progress(fraction), level: 1, style: "glow", track: true };
}

function pinned(style = "glow", { rgb = BLUE, activityId = "b" } = {}) {
  return {
    kind: "pinned",
    key: `pinned:${activityId}`,
    activityId,
    cssColor: "",
    rgb,
    progress: null,
    level: 1,
    style,
    track: true,
  };
}

function effect(type, id = "fx1", startedAt = 0) {
  return { id, type, colors: [RED, GREEN, BLUE], periodMs: 2000, color: type === "reveal" ? ORANGE : null, startedAt };
}

const control = (type, leaseId = "l1", id = "fx1") => controlScene({ holder: "magic-cube", leaseId, effect: effect(type, id) });

/** A frame as a list in its own order: the panel order matters too. */
const entries = (frame) => [...frame.entries()];

/* ---- One zone is the engine as it was ---- */

test("a one-zone wall gives exactly today's frames over a seeded run of scenes, previews and alerts", () => {
  const colours = [RED, GREEN, BLUE, ORANGE];
  const walls = [
    ["theduck", 0, [undefined, DEFAULT_ORDER]],
    ["hexagons", 90, [[{ id: "wall", member: "jo" }], { mode: "auto", auto: "path", ids: [], seed: 1, sweepFill: "line" }]],
    ["big", 0, [[{ id: "wall", member: null }], { mode: "random", auto: "path", ids: [], seed: 4, sweepFill: "line" }]],
  ];
  for (const [name, rotation, [storedRaw, order]] of walls) {
    {
      const placed = placeLayout(layoutOf(name), rotation).panels;
      const IDS = placed.map((p) => p.id);
      const zones = resolveZones(readZones(storedRaw), IDS, MEMBERS, order);
      assert.equal(zones.length, 1);
      const fills = zoneFills(zones, placed);
      const today = resolveOrder(order, placed);
      const spans = fillSpans(order, placed, today);
      if (order === DEFAULT_ORDER) assert.ok(spans, "a line sweep, so spans are compared too");
      assert.deepEqual(combinedOrder(fills), today);
      for (let seed = 1; seed <= 25; seed++) {
        const random = mulberry32(seed);
        const pick = (list) => list[Math.floor(random() * list.length)];
        const scene = () => {
          const x = random();
          if (x < 0.1) return OFF_SCENE;
          if (x < 0.25) return control(pick(["pulse", "shuffle", "reveal"]), pick(["l1", "l2"]), pick(["fx1", "fx2"]));
          const kind = random() < 0.5 ? "live" : "pinned";
          const fraction = random() < 0.2 ? null : Math.floor(random() * 12) / 10;
          const activityId = pick(["a", "b", "c"]);
          const count = random() < 0.5;
          return {
            kind,
            key: kind === "live" ? pick(["live:s1", "live:s2"]) : `pinned:${activityId}`,
            activityId,
            cssColor: "",
            rgb: pick(colours),
            progress: fraction === null ? null : progress(fraction, count),
            level: 1,
            style: pick(["glow", "pulse"]),
            track: random() < 0.5,
          };
        };
        const preview = () => {
          const x = random();
          if (x < 0.25) return null;
          if (x < 0.45) return { mode: "identify", panelIds: [pick(IDS)], rgb: random() < 0.5 ? null : RED };
          if (x < 0.65) return { mode: "fill", fraction: Math.floor(random() * 10) / 10, rgb: null };
          if (x < 0.85) return { mode: "order", rgb: random() < 0.5 ? null : GREEN };
          return { mode: "draft", panelIds: IDS.filter(() => random() < 0.3), rgb: null };
        };
        const reducedMotion = random() < 0.2 ? true : undefined;
        let t = 1000;
        const first = scene();
        let state = initialRenderState(first, t);
        let states = advanceZones(null, [{ id: zones[0].id, scene: first }], t);
        const compare = (at, label) => {
          const wall = zonesBrightness(DEFAULT_SETTINGS, [{ id: zones[0].id, scene: state.scene }]);
          const scales = zoneScales(wall.needs, wall.brightness);
          const expected = renderFrame(state, today, at, { reducedMotion, spans });
          const actual = renderZones(states, fills, at, { reducedMotion, scales });
          assert.deepEqual(entries(actual), entries(expected), label);
        };
        for (let step = 0; step < 40; step++) {
          t += 50 + Math.floor(random() * (random() < 0.7 ? 300 : 2500));
          const x = random();
          if (x < 0.5) {
            const next = scene();
            state = advance(state, next, t);
            states = advanceZones(states, [{ id: zones[0].id, scene: next }], t);
          } else if (x < 0.85) {
            const request = preview();
            state = withPreview(state, request, t);
            states = updateZones(states, (s) => withPreview(s, request, t));
          } else {
            const rgb = pick(colours);
            state = withAlert(state, rgb, t);
            states = updateZones(states, (s) => withAlert(s, rgb, t));
          }
          assert.deepEqual(states.get(zones[0].id), state, `state, seed ${seed}, step ${step}`);
          compare(t, `seed ${seed}, step ${step}`);
          compare(t + Math.floor(random() * 700), `seed ${seed}, step ${step}, later`);
        }
      }
    }
  }
});

test("one zone's brightness is today's and its scale is exactly 1", () => {
  const settings = { ...DEFAULT_SETTINGS, maxBrightness: 73, pinnedBrightness: 21 };
  // Today: a pin shows at Pinned brightness unless a preview runs; everything else at Session brightness.
  const cases = [
    [live(), {}, 73],
    [pinned(), {}, 21],
    [pinned("pulse"), { alert: true }, 21],
    [pinned(), { preview: true }, 73],
    [OFF_SCENE, {}, 73],
    [OFF_SCENE, { alert: true }, 73],
    [OFF_SCENE, { preview: true }, 73],
    [control("pulse"), {}, 73],
  ];
  for (const [scene, flags, brightness] of cases) {
    const wall = zonesBrightness(settings, [{ id: "wall", scene, ...flags }]);
    assert.equal(wall.brightness, brightness, `${scene.key} ${JSON.stringify(flags)}`);
    // Once the controller is at it, exactly 1.
    assert.ok(Object.is(zoneScales(wall.needs, wall.brightness).get("wall"), 1));
  }
});

/* ---- Two zones ---- */

const TWO = resolveZones(
  [
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: IDS.slice(0, 5) },
  ],
  IDS,
  MEMBERS,
  DEFAULT_ORDER,
);
const TWO_FILLS = zoneFills(TWO, PLACED);

test("each zone draws its own scene over its own fill, merged in the wall's order", () => {
  const states = advanceZones(
    null,
    [
      { id: "wall", scene: pinned() },
      { id: "z1", scene: live(0.4) },
    ],
    0,
  );
  const frame = renderZones(states, TWO_FILLS, 500);
  assert.deepEqual([...frame.keys()], combinedOrder(TWO_FILLS));
  const [wallFill, joFill] = TWO_FILLS;
  const wall = renderFrame(states.get("wall"), wallFill.order, 500, { spans: wallFill.spans });
  const jo = renderFrame(states.get("z1"), joFill.order, 500, { spans: joFill.spans });
  for (const [id, light] of wall) assert.deepEqual(frame.get(id), light);
  for (const [id, light] of jo) assert.deepEqual(frame.get(id), light);
});

test("another plugin's effect runs along the whole wall: one zone after another, as one order", () => {
  for (const type of ["pulse", "shuffle", "reveal"]) {
    const scene = control(type);
    const states = advanceZones(
      null,
      TWO.map((z) => ({ id: z.id, scene })),
      0,
    );
    const whole = initialRenderState(scene, 0);
    const order = combinedOrder(TWO_FILLS);
    for (const t of [0, 300, 900, 1700, 2600]) {
      assert.deepEqual(entries(renderZones(states, TWO_FILLS, t)), entries(renderFrame(whole, order, t)), `${type} ${t}`);
    }
  }
});

test("a zone appearing or going leaves the other zones' lights exactly as they were", () => {
  const three = (panels) =>
    resolveZones(
      [
        { id: "wall", member: "sam" },
        { id: "z1", member: "jo", panels: IDS.slice(0, 5) },
        { id: "z2", member: "riley", panels },
      ],
      IDS,
      MEMBERS,
      DEFAULT_ORDER,
    );
  // Mid-fade in both zones, so any reset would show.
  let states = advanceZones(
    null,
    [
      { id: "wall", scene: pinned("pulse") },
      { id: "z1", scene: live(0.2) },
    ],
    0,
  );
  states = advanceZones(
    states,
    [
      { id: "wall", scene: live(0.7, { key: "live:s9", rgb: GREEN }) },
      { id: "z1", scene: live(0.6, { key: "live:s2", rgb: BLUE }) },
    ],
    1000,
  );
  const t = 1300;
  const before = renderZones(states, TWO_FILLS, t);
  const joBefore = TWO_FILLS[1].order.map((id) => before.get(id));

  // Riley's zone appears and takes some of the first zone's panels: Jo's zone is untouched.
  const added = three(IDS.slice(20, 26));
  const addedFills = zoneFills(added, PLACED);
  const withRiley = advanceZones(
    states,
    [
      { id: "wall", scene: states.get("wall").scene },
      { id: "z1", scene: states.get("z1").scene },
      { id: "z2", scene: live(0.5, { key: "live:s3", rgb: ORANGE }) },
    ],
    t,
  );
  assert.equal(withRiley.get("z1"), states.get("z1"), "the same state object");
  assert.equal(withRiley.get("wall"), states.get("wall"));
  // Its fill is the same; only where it sits along the wall moved, which only another plugin's effect reads.
  assert.deepEqual([addedFills[1].order, addedFills[1].spans], [TWO_FILLS[1].order, TWO_FILLS[1].spans]);
  const after = renderZones(withRiley, addedFills, t);
  assert.deepEqual(TWO_FILLS[1].order.map((id) => after.get(id)), joBefore);
  // The new zone fades in from dark, beside lit zones.
  for (const id of addedFills[2].order) assert.equal(after.get(id).level, 0, `panel ${id} starts dark`);
  const settled = renderZones(withRiley, addedFills, t + FADE_MS + STAGGER_MAX_MS + 1);
  assert.ok(addedFills[2].order.some((id) => settled.get(id).level > 0));

  // Riley's zone goes again (its panels back to the first zone): Jo's zone is still untouched.
  const gone = advanceZones(
    withRiley,
    [
      { id: "wall", scene: withRiley.get("wall").scene },
      { id: "z1", scene: withRiley.get("z1").scene },
    ],
    t + 100,
  );
  assert.deepEqual([...gone.keys()], ["wall", "z1"]);
  assert.equal(gone.get("z1"), withRiley.get("z1"));
  const back = renderZones(gone, TWO_FILLS, t + 100);
  const still = renderZones(withRiley, addedFills, t + 100);
  for (const id of TWO_FILLS[1].order) assert.deepEqual(back.get(id), still.get(id));
});

test("advanceZones and updateZones return the same states when nothing changed", () => {
  const scenes = [
    { id: "wall", scene: pinned() },
    { id: "z1", scene: live(null) },
  ];
  const states = advanceZones(null, scenes, 0);
  const later = FADE_MS + STAGGER_MAX_MS + 10;
  const settled = advanceZones(states, scenes, later);
  assert.equal(advanceZones(settled, scenes, later + 100), settled);
  assert.equal(updateZones(settled, (s) => s), settled);
  // Reordered zones are a change.
  assert.notEqual(advanceZones(settled, [...scenes].reverse(), later + 100), settled);
});

test("alerts and previews are per zone: one zone's alert or preview leaves the other zone as it was", () => {
  const states = advanceZones(
    null,
    [
      { id: "wall", scene: pinned() },
      { id: "z1", scene: live(0.4) },
    ],
    0,
  );
  const quiet = renderZones(states, TWO_FILLS, 400);
  const flashed = updateZones(states, (s, id) => (id === "z1" ? withAlert(s, GREEN, 100) : s));
  assert.equal(flashed.get("wall"), states.get("wall"));
  const frame = renderZones(flashed, TWO_FILLS, 400);
  for (const id of TWO_FILLS[0].order) assert.deepEqual(frame.get(id), quiet.get(id));
  assert.ok(TWO_FILLS[1].order.every((id) => frame.get(id).rgb !== quiet.get(id).rgb), "Jo's zone flashes");
  const after = renderZones(flashed, TWO_FILLS, 100 + ALERT_MS + 1);
  for (const id of TWO_FILLS[1].order) assert.deepEqual(after.get(id), renderZones(states, TWO_FILLS, 100 + ALERT_MS + 1).get(id));

  const previewed = updateZones(states, (s, id) => (id === "wall" ? withPreview(s, { mode: "order", rgb: null }, 100) : s));
  const shown = renderZones(previewed, TWO_FILLS, 900);
  const plain = renderZones(states, TWO_FILLS, 900);
  for (const id of TWO_FILLS[1].order) assert.deepEqual(shown.get(id), plain.get(id));
});

test("only: one zone drawn, the others dark (missing)", () => {
  const states = advanceZones(
    null,
    [
      { id: "wall", scene: pinned() },
      { id: "z1", scene: live(1) },
    ],
    0,
  );
  const frame = renderZones(states, TWO_FILLS, 10, { only: "z1" });
  assert.deepEqual([...frame.keys()], TWO_FILLS[1].order);
  // A zone without a state, or with no panels, draws nothing.
  const missing = renderZones(new Map([["z1", states.get("z1")]]), TWO_FILLS, 10);
  assert.deepEqual([...missing.keys()], TWO_FILLS[1].order);
});

/* ---- Brightness across zones ---- */

test("the wall's brightness is the highest any zone needs, and each zone's need is its own", () => {
  const settings = { ...DEFAULT_SETTINGS, maxBrightness: 80, pinnedBrightness: 28 };
  const needs = (wall) => [wall.brightness, Object.fromEntries(wall.needs)];
  const both = zonesBrightness(settings, [
    { id: "wall", scene: pinned() },
    { id: "z1", scene: live() },
  ]);
  assert.deepEqual(needs(both), [80, { wall: 28, z1: 80 }]);
  // A pin beside an idle zone: the pin's brightness.
  const pins = zonesBrightness(settings, [
    { id: "wall", scene: pinned() },
    { id: "z1", scene: OFF_SCENE },
  ]);
  assert.deepEqual(needs(pins), [28, { wall: 28, z1: null }]);
  // A schedule flashing an idle zone beside a pin flashes at Session brightness.
  const flash = zonesBrightness(settings, [
    { id: "wall", scene: pinned() },
    { id: "z1", scene: OFF_SCENE, alert: true },
  ]);
  assert.deepEqual(needs(flash), [80, { wall: 28, z1: 80 }]);
  // A preview in the pinned zone shows at Session brightness.
  const preview = zonesBrightness(settings, [
    { id: "wall", scene: pinned(), preview: true },
    { id: "z1", scene: OFF_SCENE },
  ]);
  assert.deepEqual(needs(preview), [80, { wall: 80, z1: null }]);
  // Nothing showing anywhere: Session brightness, nobody needing any.
  assert.deepEqual(needs(zonesBrightness(settings, [{ id: "wall", scene: OFF_SCENE }])), [80, { wall: null }]);
});

test("scales are each zone's need over the brightness the controller is at, so a lagging write never flashes a zone", () => {
  const settings = { ...DEFAULT_SETTINGS, maxBrightness: 80, pinnedBrightness: 28 };
  const together = zonesBrightness(settings, [
    { id: "wall", scene: pinned() },
    { id: "z1", scene: live() },
  ]);
  assert.deepEqual(Object.fromEntries(zoneScales(together.needs, 80)), { wall: 0.35, z1: 1 });
  // The session ends: the target drops to 28, but the controller is still at 80 until the write lands.
  const after = zonesBrightness(settings, [
    { id: "wall", scene: pinned() },
    { id: "z1", scene: OFF_SCENE },
  ]);
  assert.equal(after.brightness, 28);
  assert.deepEqual(Object.fromEntries(zoneScales(after.needs, 80)), { wall: 0.35, z1: 1 });
  assert.deepEqual(Object.fromEntries(zoneScales(after.needs, 28)), { wall: 1, z1: 1 });
  // A need above what is applied (a write going up) is capped at 1; nothing applied yet scales nothing.
  assert.deepEqual(Object.fromEntries(zoneScales(together.needs, 28)), { wall: 1, z1: 1 });
  assert.deepEqual(Object.fromEntries(zoneScales(together.needs, 0)), { wall: 1, z1: 1 });
  // Pinned brightness above Session brightness: the live zone is the dimmer one.
  const bright = zonesBrightness({ ...settings, pinnedBrightness: 100 }, [
    { id: "wall", scene: pinned() },
    { id: "z1", scene: live() },
  ]);
  assert.deepEqual([bright.brightness, Object.fromEntries(zoneScales(bright.needs, 100))], [100, { wall: 1, z1: 0.8 }]);
});

test("a zone's scale multiplies its levels; dark stays dark", () => {
  const states = advanceZones(
    null,
    [
      { id: "wall", scene: pinned() },
      { id: "z1", scene: live(0.5) },
    ],
    0,
  );
  const plain = renderZones(states, TWO_FILLS, 2000);
  const scaled = renderZones(states, TWO_FILLS, 2000, { scales: new Map([["wall", 0.35]]) });
  for (const id of TWO_FILLS[0].order) {
    assert.equal(scaled.get(id).level, plain.get(id).level * 0.35);
    assert.deepEqual(scaled.get(id).rgb, plain.get(id).rgb);
  }
  for (const id of TWO_FILLS[1].order) assert.deepEqual(scaled.get(id), plain.get(id));
  const off = advanceZones(null, [{ id: "wall", scene: OFF_SCENE }], 0);
  const dark = renderZones(off, TWO_FILLS, 10, { scales: new Map([["wall", 0.5]]) });
  for (const light of dark.values()) assert.equal(light.level, 0);
});
