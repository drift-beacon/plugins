import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { readdirSync } from "node:fs";
import { lightOpacity } from "../shared/color.ts";
import { layoutFromPanelLayout, placeLayout } from "../shared/geometry.ts";
import { resolveOrder } from "../shared/order.ts";
import { initialRenderState, orderSweepMs, renderFrame, withPreview } from "../shared/render.ts";
import { OFF_SCENE, progressPercent } from "../shared/scene.ts";
import {
  BADGE_BASE,
  badgeSlots,
  dropSnap,
  fitBadges,
  MIN_TEXT_PX,
  minBadgeSize,
  swapIds,
} from "../ui/src/components/wall/badges.ts";
import {
  customOrder,
  leavesCustom,
  orderForAuto,
  orderForMode,
  orderForShuffle,
} from "../ui/src/components/wall/orderModes.ts";
import { listPointing } from "../ui/src/components/wall/pointing.ts";
import { refusedText, scrubberReadout, stageLabel } from "../ui/src/components/wall/readout.ts";
import {
  layoutStage,
  MAX_ZOOM,
  MIN_TARGET,
  smallestTarget,
  stageHeight,
  stagePadding,
  zoomFor,
} from "../ui/src/components/wall/stageLayout.ts";
import { inkOn, withAlpha } from "../ui/src/lib/color.ts";
import { createWallLease, LEASE_MS, RENEW_MS, THROTTLE_MS } from "../ui/src/lib/lease.ts";
import { floorGlow, panelOpacity } from "../ui/src/lib/light.ts";
import { nextSeed, panelName } from "../ui/src/lib/panels.ts";
import { stepRenderState } from "../ui/src/lib/renderState.ts";
import { rovingStep } from "../ui/src/lib/roving.ts";
import { wallShowing } from "../ui/src/lib/showing.ts";
import { insetPolygon, roundedPath, squarePath } from "../ui/src/lib/svg.ts";

const fixture = (name) => {
  const info = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
  return layoutFromPanelLayout(info.panelLayout, info.serialNo ?? name, "2026-09-30T00:00:00.000Z");
};

describe("wall lease (preview requests)", () => {
  let sent;
  let lease;
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
    sent = [];
    lease = createWallLease(async (request) => {
      sent.push({ at: Date.now(), ...request });
    });
  });
  afterEach(() => mock.timers.reset());

  test("a standing request is sent at once and renewed every 1.5 s with a 4 s lease", () => {
    lease.show({ mode: "fill", fraction: 0.35 });
    assert.deepEqual(sent, [{ at: 1_000_000, mode: "fill", fraction: 0.35, ttlMs: LEASE_MS }]);
    for (let i = 0; i < 3; i++) mock.timers.tick(RENEW_MS);
    assert.equal(sent.length, 4);
    assert.ok(sent.every((s) => s.mode === "fill" && s.ttlMs === LEASE_MS));
    assert.deepEqual(
      sent.map((s) => s.at - 1_000_000),
      [0, RENEW_MS, RENEW_MS * 2, RENEW_MS * 3],
    );
  });

  test("showing the same standing request again is a no-op (renewal already has it)", () => {
    lease.show({ mode: "order" });
    mock.timers.tick(500);
    lease.show({ mode: "order" });
    assert.equal(sent.length, 1);
  });

  test("clearing sends none once, and only when something was showing", () => {
    lease.show(null);
    assert.equal(sent.length, 0);
    lease.show({ mode: "order" });
    mock.timers.tick(THROTTLE_MS);
    lease.show(null);
    lease.show(null);
    assert.deepEqual(
      sent.map((s) => s.mode),
      ["order", "none"],
    );
    for (let i = 0; i < 2; i++) mock.timers.tick(RENEW_MS);
    assert.equal(sent.length, 2, "no renewals after clearing");
  });

  test("requests are throttled to one per 120 ms and the latest one lands", () => {
    lease.show({ mode: "fill", fraction: 0.1 });
    lease.show({ mode: "fill", fraction: 0.2 });
    lease.show({ mode: "fill", fraction: 0.3 });
    mock.timers.tick(50);
    lease.show({ mode: "fill", fraction: 0.4 });
    assert.equal(sent.length, 1);
    mock.timers.tick(THROTTLE_MS - 50);
    assert.deepEqual(
      sent.map((s) => s.fraction),
      [0.1, 0.4],
    );
    assert.equal(sent[1].at - sent[0].at, THROTTLE_MS);
  });

  test("a timed request leases exactly its time and lapses without a none", () => {
    lease.show({ mode: "identify", panelIds: [7] }, 1400);
    assert.equal(sent[0].ttlMs, 1400);
    for (let i = 0; i < 3; i++) mock.timers.tick(RENEW_MS);
    assert.equal(sent.length, 1);
  });

  test("a timed request longer than a lease is renewed with what is left, never under 500 ms", () => {
    lease.show({ mode: "order" }, 5000);
    mock.timers.tick(RENEW_MS);
    mock.timers.tick(RENEW_MS);
    mock.timers.tick(RENEW_MS);
    assert.deepEqual(
      sent.map((s) => s.ttlMs),
      [LEASE_MS, 3500, 2000, 500],
    );
    mock.timers.tick(RENEW_MS);
    assert.equal(sent.length, 4);
  });

  test("release clears the wall if something is showing, and stops renewing", () => {
    lease.show({ mode: "order" });
    lease.release();
    assert.deepEqual(
      sent.map((s) => s.mode),
      ["order", "none"],
    );
    for (let i = 0; i < 2; i++) mock.timers.tick(RENEW_MS);
    assert.equal(sent.length, 2);
    lease.release();
    assert.equal(sent.length, 2);
  });

  test("resend sends what is showing again at once (main may have lost it), and nothing when nothing shows", () => {
    lease.resend();
    assert.equal(sent.length, 0);
    lease.show({ mode: "order" });
    mock.timers.tick(700);
    lease.resend();
    assert.deepEqual(
      sent.map((s) => [s.at - 1_000_000, s.mode, s.ttlMs]),
      [
        [0, "order", LEASE_MS],
        [700, "order", LEASE_MS],
      ],
    );
    // Within the throttle it waits its turn, and the renewals carry on as before.
    lease.resend();
    assert.equal(sent.length, 2);
    mock.timers.tick(THROTTLE_MS);
    assert.equal(sent.length, 3);
    mock.timers.tick(RENEW_MS - 700 - THROTTLE_MS);
    assert.equal(sent.at(-1).at - 1_000_000, RENEW_MS);
    // A timed one is sent again with what is left of it; once cleared there is nothing to send.
    mock.timers.tick(THROTTLE_MS);
    lease.show({ mode: "identify", panelIds: [7] }, 2000);
    mock.timers.tick(1000);
    lease.resend();
    assert.deepEqual([sent.at(-1).mode, sent.at(-1).ttlMs], ["identify", 1000]);
    mock.timers.tick(THROTTLE_MS);
    lease.show(null);
    assert.equal(sent.at(-1).mode, "none");
    const count = sent.length;
    mock.timers.tick(THROTTLE_MS);
    lease.resend();
    assert.equal(sent.length, count);
  });

  test("a failing request is swallowed", async () => {
    const quiet = createWallLease(async () => {
      throw new Error("main isn't running");
    });
    assert.doesNotThrow(() => quiet.show({ mode: "order" }));
    await Promise.resolve();
  });
});

describe("svg helpers", () => {
  test("insetPolygon moves every edge of a regular hexagon in by the given amount", () => {
    const r = 40;
    const hex = Array.from({ length: 6 }, (_, k) => [
      100 + r * Math.cos((Math.PI / 3) * k),
      100 + r * Math.sin((Math.PI / 3) * k),
    ]);
    const inradius = (r * Math.sqrt(3)) / 2;
    const inner = insetPolygon(hex, [100, 100], inradius, 3);
    for (let k = 0; k < 6; k++) {
      const [ax, ay] = inner[k];
      const [bx, by] = inner[(k + 1) % 6];
      const mid = Math.hypot((ax + bx) / 2 - 100, (ay + by) / 2 - 100);
      assert.ok(Math.abs(mid - (inradius - 3)) < 1e-9);
    }
  });

  test("roundedPath is closed with one curve per corner, and clamps the radius to short edges", () => {
    const d = roundedPath(
      [
        [0, 0],
        [10, 0],
        [5, 8],
      ],
      100,
    );
    assert.match(d, /^M.*Z$/);
    assert.equal(d.match(/Q/g).length, 3);
    // Clamped to half of the shorter edge beside each corner: at (0,0) that's half of the 9.43 edge back to (5,8).
    assert.ok(d.startsWith("M2.5 4Q0 0 "), d);
    assert.equal(roundedPath([[0, 0]], 4), "");
    assert.match(squarePath([10, 10], 8, 2), /^M.*Z$/);
  });
});

describe("colour and naming helpers", () => {
  test("withAlpha handles any CSS colour, falling back to color-mix", () => {
    assert.equal(withAlpha("#ff8800", 0.15), "rgb(255 136 0 / 0.15)");
    assert.equal(withAlpha("hsl(0 100% 50%)", 0.5), "rgb(255 0 0 / 0.5)");
    assert.equal(withAlpha("var(--x)", 0.2), "color-mix(in srgb, var(--x) 20%, transparent)");
  });

  test("inkOn picks dark text on light colours and white on dark ones", () => {
    assert.equal(inkOn([255, 214, 170]), "#0b0b0e");
    assert.equal(inkOn([96, 165, 250]), "#0b0b0e");
    assert.equal(inkOn([30, 30, 60]), "#ffffff");
    assert.equal(inkOn([124, 58, 237]), "#ffffff");
  });

  test("nextSeed never repeats the previous seed and stays a positive 31-bit integer", () => {
    const rolls = [0, 0, 0.5];
    const random = () => rolls.shift() ?? 0.25;
    assert.equal(nextSeed(1, random), 1 + Math.floor(0.5 * 0x7ffffffe));
    for (let i = 0; i < 200; i++) {
      const seed = nextSeed(42);
      assert.ok(Number.isInteger(seed) && seed > 0 && seed <= 0x7fffffff && seed !== 42);
    }
  });

  test("panels are named by shape and id", () => {
    assert.equal(panelName({ shapeType: 7, id: 32797 }), "Hexagon 32797");
    assert.equal(panelName({ shapeType: 9, id: 15767 }), "Mini triangle 15767");
  });
});

describe("stage layout", () => {
  for (const name of ["theduck", "wings"]) {
    for (const rotation of [0, 30, 90]) {
      test(`${name} at ${rotation}° fits its stage at phone and desktop widths`, () => {
        const placed = placeLayout(fixture(name), rotation);
        for (const width of [340, 480, 760]) {
          const height = stageHeight(placed, width, 540);
          assert.ok(height >= 240 && height <= 540, `height ${height}`);
          const stage = layoutStage(placed, width, height);
          const pad = stagePadding(width);
          assert.ok(stage.scale > 0 && stage.scale <= 1.45);
          assert.equal(stage.panels.length, placed.panels.length);
          assert.equal(stage.byId.size, placed.panels.length);
          for (const p of stage.panels) {
            assert.ok(p.path.startsWith("M") && p.hit.startsWith("M"));
            assert.ok(p.center[0] >= pad - 1e-6 && p.center[0] <= width - pad + 1e-6, `x ${p.center[0]}`);
            assert.ok(p.center[1] >= pad - 1e-6 && p.center[1] <= height - pad + 1e-6, `y ${p.center[1]}`);
            assert.ok(p.inradius > 0);
          }
          assert.ok(stage.others.some((o) => o.role === "controller"));
          assert.ok(stage.floor.cy <= height);
        }
      });
    }
  }

  test("a small wall in a wide column stays life-sized and centred", () => {
    const placed = placeLayout(fixture("theduck"), 0);
    const stage = layoutStage(placed, 1200, 400);
    assert.equal(stage.scale, 1.45);
    const { minX, maxX } = placed.bounds;
    const left = minX * stage.scale + stage.tx;
    const right = maxX * stage.scale + stage.tx;
    assert.ok(Math.abs(left - (1200 - right)) < 1e-6);
  });

  test("the fit maps layout to pixels like fitView: y flips", () => {
    const placed = placeLayout(fixture("wings"), 0);
    const stage = layoutStage(placed, 500, stageHeight(placed, 500, 600));
    const p = placed.panels[0];
    const s = stage.byId.get(p.id);
    assert.ok(Math.abs(s.center[0] - (p.center[0] * stage.scale + stage.tx)) < 1e-9);
    assert.ok(Math.abs(s.center[1] - (-p.center[1] * stage.scale + stage.ty)) < 1e-9);
  });
});

/* ---- Review fixes (wall group) ---- */

const stageAt = (name, width, rotation = 0) => {
  const placed = placeLayout(fixture(name), rotation);
  return { placed, stage: layoutStage(placed, width, stageHeight(placed, width, 506)) };
};

describe("badges on big walls (legible, apart, zoomable)", () => {
  for (const width of [310, 342, 358, 642, 1000]) {
    test(`big mixed at ${width} px: numbers render at 11 px or more and visible badges never overlap`, () => {
      const { stage } = stageAt("big", width);
      const fits = fitBadges(stage, stage.panels.length);
      assert.equal(fits.size, stage.panels.length);
      const shown = [];
      for (const p of stage.panels) {
        const fit = fits.get(p.id);
        assert.ok(fit.font * fit.scale >= MIN_TEXT_PX - 1e-9, `text ${fit.font * fit.scale}`);
        assert.ok(fit.size >= minBadgeSize(stage.panels.length) && fit.size <= 32);
        assert.equal(fit.scale, fit.size / BADGE_BASE);
        // Nudged at most ~0.6 inradius (3 px minimum) off its panel's centre: it still reads as that panel's number.
        const off = Math.hypot(fit.at[0] - p.center[0], fit.at[1] - p.center[1]);
        assert.ok(off <= Math.max(3, p.inradius * 0.6) + 1e-6, `offset ${off}`);
        if (!fit.hidden) shown.push(fit);
      }
      for (let i = 0; i < shown.length; i++) {
        for (let j = i + 1; j < shown.length; j++) {
          const a = shown[i];
          const b = shown[j];
          const d = Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]);
          assert.ok(d >= (a.size + b.size) / 2 - Math.min(a.size, b.size) * 0.2 - 1e-6, `overlap ${d}`);
        }
      }
    });
  }

  test("where there is no room at all, the smaller panel's number waits for hover instead of covering another", () => {
    for (const width of [200, 240]) {
      const { stage } = stageAt("big", width);
      const fits = fitBadges(stage, stage.panels.length);
      const hidden = stage.panels.filter((p) => fits.get(p.id).hidden);
      const shown = stage.panels.filter((p) => !fits.get(p.id).hidden);
      assert.ok(hidden.length > 0, `a ${width} px big wall has to hide some numbers`);
      for (const p of hidden) {
        const a = fits.get(p.id);
        const blocker = shown.find((q) => {
          const b = fits.get(q.id);
          return q.inradius >= p.inradius && Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]) < (a.size + b.size) / 2;
        });
        assert.ok(blocker, `${p.kind} ${p.id} is hidden only behind a panel at least as big`);
      }
    }
    const { stage } = stageAt("big", 240);
    const fits = fitBadges(stage, stage.panels.length);
    assert.ok(stage.panels.every((p) => !fits.get(p.id).hidden || p.kind === "mini-triangle"));
  });

  test("two- and three-digit sequences get room for their digits", () => {
    assert.equal(minBadgeSize(9), 16);
    assert.equal(minBadgeSize(32), 18);
    assert.equal(minBadgeSize(120), 22);
  });

  test("a phone-width big wall offers zoom that makes every panel a 32 px target; small walls don't", () => {
    for (const width of [310, 342, 358]) {
      const { placed, stage } = stageAt("big", width);
      const z = zoomFor(stage);
      assert.ok(smallestTarget(stage) < MIN_TARGET, `targets at ${width} px`);
      assert.ok(z > 1 && z <= MAX_ZOOM);
      const zoomed = layoutStage(placed, Math.round(width * z), Math.round(stage.height * z));
      assert.ok(smallestTarget(zoomed) >= MIN_TARGET, `zoomed ${smallestTarget(zoomed)}`);
    }
    assert.equal(zoomFor(stageAt("big", 642).stage), 1);
    assert.equal(zoomFor(stageAt("theduck", 342).stage), 1);
    assert.equal(zoomFor(stageAt("wings", 310).stage), 1);
  });
});

describe("drag-swap drop (ui-5)", () => {
  test("the dropped number lands where it was let go instead of flying in again from its old panel", () => {
    const order = [10, 20, 30, 40];
    // Dragging panel 10 (number 1) over panel 40 (number 4): number 4 previews the swap on panel 10.
    const hover = badgeSlots(order, { id: 10, target: 40 }, null, false);
    assert.deepEqual(
      hover.map((s) => [s.label, s.spot]),
      [
        [1, 10],
        [2, 20],
        [3, 30],
        [4, 10],
      ],
    );
    const snap = dropSnap({ id: 10, target: 40 });
    const drop = badgeSlots(swapIds(order, 10, 40), null, snap, false);
    const one = drop.find((s) => s.label === 1);
    const four = drop.find((s) => s.label === 4);
    assert.equal(one.spot, 40, "number 1 now labels the drop panel");
    assert.equal(one.instant, true, "and is already there (the ghost was): no second flight");
    assert.equal(four.spot, 10, "number 4 stays where the hover preview slid it");
    assert.equal(four.instant, false);
    assert.equal(drop.find((s) => s.label === 2).instant, false);
  });
});

describe("render state steps (ui-4)", () => {
  const order = [1, 2, 3, 4, 5, 6, 7, 8];
  const sweep = () => ({ mode: "order", rgb: null });

  test("a second sweep request restarts the sweep, so it ends on the full wall", () => {
    let state = stepRenderState(initialRenderState(OFF_SCENE, 0), OFF_SCENE, sweep(), true, 0);
    state = stepRenderState(state, OFF_SCENE, sweep(), true, 900);
    assert.equal(state.previewAt, 900);
    const end = 900 + orderSweepMs(order.length) - 80;
    const levels = [...renderFrame(state, order, end).values()].map((l) => l.level);
    assert.ok(
      levels.every((l) => l > 0.99),
      levels.map((l) => l.toFixed(2)).join(" "),
    );
  });

  test("the same request again (a re-render, a scene tick) keeps the sweep's phase and the state itself", () => {
    const preview = sweep();
    const state = stepRenderState(initialRenderState(OFF_SCENE, 0), OFF_SCENE, preview, true, 0);
    assert.equal(stepRenderState(state, OFF_SCENE, preview, false, 900), state);
    // A new fill fraction still updates in place (scrubbing never re-fades).
    const fill = stepRenderState(state, OFF_SCENE, { mode: "fill", fraction: 0.2, rgb: null }, true, 1000);
    const again = stepRenderState(fill, OFF_SCENE, { mode: "fill", fraction: 0.3, rgb: null }, true, 1100);
    assert.equal(again.previewAt, fill.previewAt);
    assert.equal(withPreview(again, null, 1200).preview, null);
  });
});

describe("order modes keep a hand-made order (ux-2)", () => {
  const panels = placeLayout(fixture("theduck"), 0).panels;
  const base = { mode: "auto", auto: "path", ids: [], seed: 1 };
  const handmade = [...resolveOrder(base, panels)].reverse();

  test("Custom → Auto → Custom brings the tapped order back", () => {
    const mine = customOrder(base, handmade);
    const auto = orderForMode(mine, "auto", resolveOrder(mine, panels));
    assert.equal(auto.mode, "auto");
    assert.deepEqual(auto.ids, handmade, "auto keeps the ids it ignores");
    assert.notDeepEqual(resolveOrder(auto, panels), handmade, "and shows its own order");
    const back = orderForMode(auto, "custom", resolveOrder(auto, panels));
    assert.deepEqual(resolveOrder(back, panels), handmade);
    assert.ok(leavesCustom(mine, "auto") && leavesCustom(mine, "random"));
    assert.ok(!leavesCustom(auto, "random") && !leavesCustom(mine, "custom"));
  });

  test("Random, a re-roll and another auto sweep keep it too", () => {
    const mine = customOrder(base, handmade);
    let order = orderForMode(mine, "random", resolveOrder(mine, panels));
    order = orderForShuffle(order, 77);
    order = orderForAuto(order, "left-right");
    assert.deepEqual(order.ids, handmade);
    assert.equal(order.seed, 77);
    assert.deepEqual(resolveOrder(orderForMode(order, "custom", []), panels), handmade);
  });

  test("with no hand-made order yet, Custom freezes the order showing now", () => {
    const showing = resolveOrder({ ...base, auto: "top-down" }, panels);
    const custom = orderForMode({ ...base, auto: "top-down" }, "custom", showing);
    assert.deepEqual(custom.ids, showing);
    assert.equal(orderForMode(custom, "custom", []), custom, "choosing the mode it's in changes nothing");
  });
});

describe("list hover on the wall (ui-2)", () => {
  test("a standing identify is let go when the wall can't be driven, and forgotten when a preview takes over", () => {
    assert.equal(listPointing({ canWall: false, busy: false, listFocus: 5, pointing: true }), "release");
    assert.equal(listPointing({ canWall: false, busy: false, listFocus: 5, pointing: false }), "none");
    assert.equal(listPointing({ canWall: true, busy: true, listFocus: 5, pointing: true }), "forget");
    assert.equal(listPointing({ canWall: true, busy: true, listFocus: 5, pointing: false }), "none");
  });

  test("a focused row points its panel out; losing it lets go after a grace", () => {
    assert.equal(listPointing({ canWall: true, busy: false, listFocus: 5, pointing: false }), "show");
    assert.equal(listPointing({ canWall: true, busy: false, listFocus: null, pointing: true }), "release-soon");
    assert.equal(listPointing({ canWall: true, busy: false, listFocus: null, pointing: false }), "none");
  });
});

describe("keyboard and copy", () => {
  test("radio groups rove with the arrows, wrapping, and jump with Home and End (ux-15)", () => {
    assert.equal(rovingStep("ArrowRight", 0, 3), 1);
    assert.equal(rovingStep("ArrowDown", 2, 3), 0);
    assert.equal(rovingStep("ArrowLeft", 0, 3), 2);
    assert.equal(rovingStep("ArrowUp", 1, 5), 0);
    assert.equal(rovingStep("Home", 3, 5), 0);
    assert.equal(rovingStep("End", 0, 5), 4);
    assert.equal(rovingStep("Enter", 0, 5), null);
    assert.equal(rovingStep("ArrowRight", 0, 0), null);
  });

  test("the scrubber rounds like the Now card: progressPercent (ux-5)", () => {
    for (const f of [0.435, 0.525, 0.875, 0.004, 0.996, 1.4, -0.2]) {
      assert.equal(scrubberReadout(null, f, 7).percent, progressPercent(f), `now ${f}`);
      assert.equal(scrubberReadout(f, null, 7).value, `${progressPercent(f)}%`, `preview ${f}`);
    }
    assert.equal(scrubberReadout(null, 0.435, 7).value, "44%");
    assert.equal(scrubberReadout(null, 0.435, 7).caption, "Now · panel 4 of 7 filling");
    assert.equal(scrubberReadout(1, null, 7).caption, "all 7 panels full");
    assert.deepEqual(scrubberReadout(null, null, 7), {
      percent: 0,
      value: null,
      caption: null,
    });
  });

  test("a refused order or rotation save says what didn't save and why, instead of snapping back silently", () => {
    assert.equal(refusedText("the order", new Error("Storage is full")), "Couldn't save the order: Storage is full");
    assert.equal(refusedText("the rotation", "offline"), "Couldn't save the rotation: offline");
  });

  test("instructional text in the wall editor meets WCAG AA in both themes (ux-12)", () => {
    const lum = (hex) => {
      const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
      const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const tokens = (css) =>
      Object.fromEntries([...css.matchAll(/--db-([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
    // Hints are text-default-500 (theme.css: --db-muted) on the card (--db-surface) or the stage.
    const theme = readFileSync(new URL("../../theme.css", import.meta.url), "utf8");
    const dark = tokens(theme.slice(0, theme.indexOf("}")));
    // The SDK's light fallback, what a light app sends.
    const light = { muted: "#71717a", surface: "#ffffff" };
    // In a light theme the stage keeps dark tokens of its own (wall.css `.wall-stage`), the theme's dark defaults.
    const wallCss = readFileSync(new URL("../ui/src/components/wall/wall.css", import.meta.url), "utf8");
    const island = tokens(wallCss.slice(wallCss.indexOf(".wall-stage {"), wallCss.indexOf("color-scheme: dark")));
    assert.equal(island.muted, dark.muted);
    assert.equal(island.surface, dark.surface);
    for (const [name, { muted, surface }] of Object.entries({ dark, light, island })) {
      assert.ok(ratio(muted, surface) >= 4.5, `${name}: ${muted} on ${surface} is ${ratio(muted, surface).toFixed(2)}`);
    }
    // Small text in default-400 is for decorative eyebrows only (text-[10px] uppercase), never for instructions.
    const dir = new URL("../ui/src/components/wall/", import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
      const source = readFileSync(new URL(file, dir), "utf8");
      for (const line of source.split("\n")) {
        if (line.includes("text-default-400") && /text-(xs|sm)\b/.test(line)) assert.fail(`${file}: ${line.trim()}`);
      }
    }
  });

  test("the stage's chrome never hard-codes white on the editor card: light themes need tokens (theme)", () => {
    // White overlays (bg-white/…) read only on the dark stage; the editor and list sit on the theme's card.
    for (const file of ["OrderEditor.tsx", "OrderList.tsx", "DraftPanel.tsx", "MiniWall.tsx"]) {
      const source = readFileSync(new URL(`../ui/src/components/wall/${file}`, import.meta.url), "utf8");
      assert.doesNotMatch(source, /\b(bg|text|ring|border)-(white|black)\b/, file);
    }
    const stage = readFileSync(new URL("../ui/src/components/wall/WallStage.tsx", import.meta.url), "utf8");
    assert.match(stage, /className="wall-stage /);
  });
});

describe("what the drawing claims (decision 5, ux-6)", () => {
  const model = (patch) => ({
    controller: { host: "10.0.0.2", port: 16021, name: "The Duck", model: "NL42" },
    settings: { enabled: true },
    mainStatus: "running",
    connection: { status: "connected", name: "The Duck" },
    output: { mode: "live", activityId: "a", fraction: 0.4, inControl: true, detail: null, since: "" },
    ...patch,
  });

  test("the wall shows the scene only while main is in control", () => {
    assert.deepEqual(wallShowing(model({})), { showing: true, reason: null });
    const cases = [
      [{ output: null }, "The plugin isn't running"],
      [{ output: null, mainStatus: "starting" }, "The plugin is starting"],
      [{ controller: null, output: null }, "Not paired yet"],
      [
        { connection: { status: "unreachable", name: "The Duck" }, output: { mode: "disconnected", inControl: false } },
        "Can't reach The Duck",
      ],
      [
        {
          connection: { status: "unauthorized", name: "The Duck" },
          output: { mode: "disconnected", inControl: false },
        },
        "The Duck needs pairing again",
      ],
      [{ output: { mode: "busy", inControl: false } }, "Someone else is driving it"],
      [{ output: { mode: "yielded", inControl: false } }, "Changed somewhere else"],
      [{ output: { mode: "idle", inControl: false, detail: null } }, "Showing its own scene"],
    ];
    for (const [patch, reason] of cases) assert.deepEqual(wallShowing(model(patch)), { showing: false, reason });
  });

  test("the drawing's label says 'would' when the wall isn't showing it", () => {
    const shown = stageLabel({ panels: 7, activity: "Deep work", fraction: 0.435, showing: wallShowing(model({})) });
    assert.equal(shown, "Drawing of your wall: 7 panels, glowing in the colour of Deep work, 44% of the goal filled");
    const offline = stageLabel({
      panels: 7,
      activity: "Deep work",
      fraction: 0.435,
      showing: wallShowing(model({ output: null })),
    });
    assert.match(offline, /would glow in the colour of Deep work, but isn't showing it: The plugin isn't running/);
    assert.doesNotMatch(offline, /glowing/);
    assert.equal(
      stageLabel({ panels: 1, activity: null, fraction: null, showing: wallShowing(model({})) }),
      "Drawing of your wall: 1 panel, not lit by the plugin right now",
    );
  });
});

describe("drawing opacity matches the wall (decision 1)", () => {
  test("a panel's light is drawn at lightOpacity(level); dark stays dark", () => {
    assert.equal(panelOpacity(undefined), 0);
    assert.equal(panelOpacity({ rgb: [255, 0, 0], level: 0 }), 0);
    for (const level of [0.001, 0.06, 0.08, 0.35, 0.5, 1]) {
      const opacity = panelOpacity({ rgb: [255, 0, 0], level });
      assert.ok(Math.abs(opacity - lightOpacity(level)) <= 0.0005, `level ${level}`);
      assert.ok(opacity > 0);
    }
  });

  test("the floor glow takes the lit panels' colour, weighted by how bright each is drawn", () => {
    const lights = new Map([
      [1, { rgb: [255, 0, 0], level: 1 }],
      [2, { rgb: [0, 0, 255], level: 0 }],
    ]);
    const glow = floorGlow(lights, [1, 2]);
    assert.deepEqual(glow.rgb, [255, 0, 0]);
    assert.ok(glow.opacity > 0 && glow.opacity <= 0.5);
    assert.deepEqual(floorGlow(new Map(), [1, 2]), { rgb: null, opacity: 0 });
  });
});
