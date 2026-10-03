import assert from "node:assert/strict";
import { test } from "node:test";
import { address, elapsed, lightCount, panelLine } from "../ui/src/components/format.ts";
import { activityStyle, channels, tint } from "../ui/src/components/tint.ts";

test("format: which panel is filling, as the wall fills them", () => {
  // 35% of 5 panels: panel 1 full, panel 2 at 75% (the DESIGN example).
  assert.equal(panelLine(0.35, 5), "Panel 2 of 5 filling");
  assert.equal(panelLine(0, 5), "Panel 1 of 5 is next");
  assert.equal(panelLine(0.4, 5), "Panel 3 of 5 is next");
  assert.equal(panelLine(0.999, 5), "Panel 5 of 5 filling");
  assert.equal(panelLine(1, 5), "All 5 panels lit");
  assert.equal(panelLine(1.4, 5), "All 5 panels lit");
  assert.equal(panelLine(1, 1), "The panel is full");
  assert.equal(panelLine(-0.2, 3), "Panel 1 of 3 is next");
  assert.equal(panelLine(0.5, 0), "");
});

test("format: running time ticks in whole seconds", () => {
  assert.equal(elapsed(0), "0:00");
  assert.equal(elapsed(59_999), "0:59");
  assert.equal(elapsed(20 * 60_000 + 14_000), "20:14");
  assert.equal(elapsed(3_600_000 + 5 * 60_000 + 3_000), "1:05:03");
  assert.equal(elapsed(-5000), "0:00");
});

test("format: light panels only, and the default port left out", () => {
  const layout = {
    controllerId: "S1",
    globalOrientation: 0,
    fetchedAt: "",
    panels: [
      { id: 1, x: 0, y: 0, o: 0, shapeType: 7 },
      { id: 2, x: 0, y: 0, o: 0, shapeType: 8 },
      { id: 3, x: 0, y: 0, o: 0, shapeType: 9 },
      { id: 0, x: 0, y: 0, o: 0, shapeType: 12 },
      { id: 4, x: 0, y: 0, o: 0, shapeType: 2 },
    ],
  };
  assert.equal(lightCount(layout), 3);
  assert.equal(lightCount(null), 0);
  assert.equal(address("192.168.1.40", 16021), "192.168.1.40");
  assert.equal(address("192.168.1.40", null), "192.168.1.40");
  assert.equal(address("192.168.1.40", 8080), "192.168.1.40:8080");
});

test("tint: any activity colour at an alpha, with a neutral fallback", () => {
  assert.equal(tint("#38bdf8", 0.15), "rgb(56 189 248 / 0.15)");
  assert.equal(tint("rgb(251 146 60)", 0.5), "rgb(251 146 60 / 0.5)");
  assert.deepEqual([...channels("not a colour")], [161, 161, 170]);
  assert.deepEqual([...channels(null)], [161, 161, 170]);
  const style = activityStyle("#38bdf8");
  assert.equal(style.solid, "rgb(56 189 248 / 1)");
  assert.equal(style.wash, "linear-gradient(135deg, rgb(56 189 248 / 0.15), transparent 70%)");
  assert.equal(style.glow, "0 10px 30px -10px rgb(56 189 248 / 0.53)");
});
