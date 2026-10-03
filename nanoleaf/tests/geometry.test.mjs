import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  adjacency,
  centroidOf,
  edgeNormals,
  fitView,
  layoutFromPanelLayout,
  MARKER_RADIUS,
  overlapArea,
  panelAt,
  placeLayout,
  pointInPolygon,
  polygonArea,
  rotatePoint,
  SHAPES,
  shapeCorners,
  shapeLabel,
  TOUCH_TOLERANCE,
} from "../shared/geometry.ts";

const FETCHED_AT = "2026-09-30T12:00:00.000Z";
const info = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const layoutOf = (name) => {
  const data = info(name);
  return layoutFromPanelLayout(data.panelLayout, data.serialNo, FETCHED_AT);
};
const close = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);

/**
 * The layouts with light panels, and the joins each one physically has.
 *
 * - theduck (real): a triangle (49632) carries a chain of five mini triangles, alternately pointing down and up
 *   (34671, 36406, 39807, 42632, 15767), that ends at a hexagon (32797). 6 joins, a path. 49632–34671 is an offset
 *   join (the mini sits on half of the triangle's edge); the hexagon meets 15767 edge to edge and touches 42632 only
 *   at a corner, which is not a join.
 * - wings (real): nine triangles in one chain, two wings meeting at 1837: 31270–20510–59975–37923–1837–25862–24968–
 *   923–34168. 8 joins; only 20510–59975 and 24968–923 are full edges, the other six are offset by half an edge.
 * - hexagons (synthesised): twelve hexagons in columns of 3, 4, 3 and 2. Within columns 2 + 3 + 2 + 1 = 8 joins;
 *   between neighbouring columns 3 + 3 + 2 rising and 3 + 3 + 2 falling. 24 joins.
 * - minis (synthesised): ten mini triangles in a zig-zag strip (along a row, up a diagonal, along the next row).
 *   9 joins, a path.
 * - big (synthesised, see generate.mjs): a flower of 7 hexagons (6 centre–ring + 6 ring–ring joins), 5 triangle rays
 *   each on half of a ring hexagon's outer edge, a ridge of 7 alternating triangles below (6 joins) that meets the
 *   flower's bottom hexagon, a hexagon at each end of the ridge (the right one also meets two flower hexagons) and 11
 *   mini triangle sparks. hexagon–hexagon 12 + 2 = 14; hexagon–triangle 5 rays + ridge under the flower + 2 ridge
 *   ends = 8; triangle–triangle 6; mini–triangle 6; mini–mini 4 (four pairs); hexagon–mini 2. 40 joins.
 */
const WALLS = {
  theduck: { panels: 7, hexagon: 1, triangle: 1, "mini-triangle": 5, joins: 6 },
  wings: { panels: 9, hexagon: 0, triangle: 9, "mini-triangle": 0, joins: 8 },
  hexagons: { panels: 12, hexagon: 12, triangle: 0, "mini-triangle": 0, joins: 24 },
  minis: { panels: 10, hexagon: 0, triangle: 0, "mini-triangle": 10, joins: 9 },
  big: { panels: 32, hexagon: 9, triangle: 12, "mini-triangle": 11, joins: 40 },
};
const BIG_JOINS = {
  "hexagon+hexagon": 14,
  "hexagon+triangle": 8,
  "triangle+triangle": 6,
  "mini-triangle+triangle": 6,
  "mini-triangle+mini-triangle": 4,
  "hexagon+mini-triangle": 2,
};

const joinCount = (graph) => [...graph.values()].reduce((sum, list) => sum + list.length, 0) / 2;

/** The same panel, shrunk by `by` units towards its centre (absorbs the device's rounding to integer centroids). */
const inset = (panel, by) => {
  const k = (panel.inradius - by) / panel.inradius;
  return panel.corners.map(([x, y]) => [
    panel.center[0] + (x - panel.center[0]) * k,
    panel.center[1] + (y - panel.center[1]) * k,
  ]);
};

/**
 * An independent join test: some edge of A and some edge of B run antiparallel, lie on (nearly) the same line and
 * overlap by more than one unit. It looks only at corners, not at centres or inradii.
 */
function shareEdge(a, b) {
  const edges = (panel) => panel.corners.map((corner, k) => [corner, panel.corners[(k + 1) % panel.corners.length]]);
  for (const [p0, p1] of edges(a)) {
    const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const ux = (p1[0] - p0[0]) / length;
    const uy = (p1[1] - p0[1]) / length;
    for (const [q0, q1] of edges(b)) {
      const qLength = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
      const vx = (q1[0] - q0[0]) / qLength;
      const vy = (q1[1] - q0[1]) / qLength;
      if (Math.abs(ux * vy - uy * vx) > 0.02 || ux * vx + uy * vy > 0) continue;
      const gap = Math.abs((q0[0] - p0[0]) * -uy + (q0[1] - p0[1]) * ux);
      if (gap > TOUCH_TOLERANCE) continue;
      const s0 = (q0[0] - p0[0]) * ux + (q0[1] - p0[1]) * uy;
      const s1 = (q1[0] - p0[0]) * ux + (q1[1] - p0[1]) * uy;
      const overlap = Math.min(length, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1));
      if (overlap > 1) return true;
    }
  }
  return false;
}

/** Distance from a point to a polygon's outline. */
function distanceToOutline([px, py], corners) {
  return Math.min(
    ...corners.map(([ax, ay], k) => {
      const [bx, by] = corners[(k + 1) % corners.length];
      const along = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2);
      const t = Math.max(0, Math.min(1, along));
      return Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay));
    }),
  );
}

function isConnected(graph) {
  const [first] = graph.keys();
  const seen = new Set([first]);
  const stack = [first];
  while (stack.length) for (const id of graph.get(stack.pop())) if (!seen.has(id) && seen.add(id)) stack.push(id);
  return seen.size === graph.size;
}

test("shape table: Shapes panels are lit; the controller and older shapes are not", () => {
  assert.deepEqual(SHAPES[7], { kind: "hexagon", side: 67, sides: 6, light: true });
  assert.deepEqual(SHAPES[8], { kind: "triangle", side: 134, sides: 3, light: true });
  assert.deepEqual(SHAPES[9], { kind: "mini-triangle", side: 67, sides: 3, light: true });
  assert.deepEqual(SHAPES[12], { kind: "controller", side: 0, sides: 0, light: false });
  assert.equal(SHAPES[0].side, 150);
  for (const type of [2, 3, 4]) assert.deepEqual([SHAPES[type].side, SHAPES[type].sides], [100, 4]);
  assert.equal(SHAPES[14].side, 134);
  assert.equal(SHAPES[15].sides, 0);
  for (const type of [0, 2, 3, 4, 12, 14, 15]) assert.equal(SHAPES[type].light, false);
  assert.equal(SHAPES[1], undefined);
});

test("shapeLabel names what the UI lists", () => {
  assert.equal(shapeLabel(7), "Hexagon");
  assert.equal(shapeLabel(8), "Triangle");
  assert.equal(shapeLabel(9), "Mini triangle");
  assert.equal(shapeLabel(12), "Controller");
  for (const type of [0, 2, 14, 15, 99, -1]) assert.equal(shapeLabel(type), "Unsupported");
});

test("hexagon corners are flat top and bottom at o = 0, with circumradius = side", () => {
  const corners = shapeCorners(7, [10, 20], 0);
  assert.equal(corners.length, 6);
  close(corners[0][0], 77);
  close(corners[0][1], 20);
  close(corners[1][1], corners[2][1]);
  close(corners[4][1], corners[5][1]);
  close(corners[1][1] - 20, (67 * Math.sqrt(3)) / 2);
  for (const [x, y] of corners) close(Math.hypot(x - 10, y - 20), 67);
  assert.ok(polygonArea(corners) > 0, "counter-clockwise");
  // A hexagon looks the same every 60°.
  const turned = shapeCorners(7, [10, 20], 60);
  for (const [x, y] of turned) assert.ok(corners.some(([cx, cy]) => Math.hypot(cx - x, cy - y) < 1e-9));
});

test("triangles point up at o ∈ {0, 120, 240} and down at {60, 180, 300}", () => {
  const top = (o) => Math.max(...shapeCorners(8, [0, 0], o).map(([, y]) => y));
  const bottom = (o) => Math.min(...shapeCorners(8, [0, 0], o).map(([, y]) => y));
  const R = 134 / Math.sqrt(3);
  for (const o of [0, 120, 240]) {
    close(top(o), R);
    close(bottom(o), -R / 2);
  }
  for (const o of [60, 180, 300]) {
    close(top(o), R / 2);
    close(bottom(o), -R);
  }
  const mini = shapeCorners(9, [0, 0], 0);
  close(mini[0][1], 67 / Math.sqrt(3));
  close(mini[0][0], 0);
  assert.ok(polygonArea(mini) > 0, "counter-clockwise");
  assert.equal(shapeCorners(12, [0, 0], 0), null);
  assert.equal(shapeCorners(15, [0, 0], 0), null);
  assert.equal(shapeCorners(42, [0, 0], 0), null);
});

test("rotatePoint turns counter-clockwise with Y up", () => {
  const [x, y] = rotatePoint([1, 0], 90);
  close(x, 0);
  close(y, 1);
  assert.deepEqual(rotatePoint([3, 4], 360), [3, 4]);
});

test("layoutFromPanelLayout reads every shape the controller sends", () => {
  const data = info("theduck");
  const fromPanelLayout = layoutFromPanelLayout(data.panelLayout, "S123", FETCHED_AT);
  assert.equal(fromPanelLayout.controllerId, "S123");
  assert.equal(fromPanelLayout.fetchedAt, FETCHED_AT);
  assert.equal(fromPanelLayout.globalOrientation, 59);
  assert.equal(fromPanelLayout.panels.length, 8);
  assert.deepEqual(fromPanelLayout.panels[0], { id: 49632, x: 59, y: 56, o: 0, shapeType: 8 });
  // A whole GET / answer, and the flattened { globalOrientation, positionData } form, give the same layout.
  assert.deepEqual(layoutFromPanelLayout(data, "S123", FETCHED_AT), fromPanelLayout);
  const flat = { globalOrientation: 59, positionData: data.panelLayout.layout.positionData };
  assert.deepEqual(layoutFromPanelLayout(flat, "S123", FETCHED_AT), fromPanelLayout);

  // sideLength 0, missing or nonsense makes no difference.
  const without = structuredClone(data.panelLayout);
  delete without.layout.sideLength;
  delete without.layout.numPanels;
  assert.deepEqual(layoutFromPanelLayout(without, "S123", FETCHED_AT), fromPanelLayout);

  const odd = layoutFromPanelLayout(
    {
      globalOrientation: { value: -300 },
      layout: {
        positionData: [
          { panelId: 5, x: 1, y: 2, o: 480, shapeType: 15 },
          { panelId: 6, x: 1, y: 2, o: -60 },
          { panelId: 5, x: 9, y: 9, o: 0, shapeType: 7 },
          { panelId: "7", x: 1, y: 2, o: 0, shapeType: 7 },
          { panelId: 8, x: null, y: 2, o: 0, shapeType: 7 },
          { panelId: 9.5, x: 1, y: 2, o: 0, shapeType: 7 },
          { panelId: 10, x: 3, y: Number.NaN, o: 0, shapeType: 7 },
          null,
          "panel",
        ],
      },
    },
    "host:16021",
    FETCHED_AT,
  );
  assert.equal(odd.globalOrientation, 60);
  assert.deepEqual(odd.panels, [
    { id: 5, x: 1, y: 2, o: 120, shapeType: 15 },
    { id: 6, x: 1, y: 2, o: 300, shapeType: 0 },
  ]);

  for (const garbage of [undefined, null, 42, "layout", [], {}, { layout: null }, { globalOrientation: "x" }]) {
    const layout = layoutFromPanelLayout(garbage, "c", FETCHED_AT);
    assert.deepEqual(layout, { controllerId: "c", globalOrientation: 0, panels: [], fetchedAt: FETCHED_AT });
  }
});

test("placeLayout keeps light panels, sorted by id, and files the controller under others", () => {
  for (const name of Object.keys(WALLS)) {
    const layout = layoutOf(name);
    const placed = placeLayout(layout);
    const expected = WALLS[name];
    assert.equal(placed.panels.length, expected.panels, name);
    for (const kind of ["hexagon", "triangle", "mini-triangle"]) {
      assert.equal(placed.panels.filter((panel) => panel.kind === kind).length, expected[kind], `${name} ${kind}`);
    }
    const ids = placed.panels.map((panel) => panel.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), `${name} sorted`);
    assert.ok(!ids.includes(0), `${name}: the controller is not a light panel`);
    assert.equal(placed.others.length, 1, name);
    const [controller] = placed.others;
    const { id, shapeType, role, corners } = controller;
    assert.deepEqual([id, shapeType, role, corners], [0, 12, "controller", null]);
    for (const panel of placed.panels) {
      const shape = SHAPES[panel.shapeType];
      assert.equal(panel.side, shape.side);
      assert.equal(panel.corners.length, shape.sides);
      close(panel.inradius, shape.sides === 6 ? (shape.side * Math.sqrt(3)) / 2 : shape.side / (2 * Math.sqrt(3)));
    }
  }
});

test("bounds cover every corner and the controller marker, and touch them", () => {
  for (const name of [...Object.keys(WALLS), "lasvegas", "spaceinvader"]) {
    for (const rotation of [0, 30, 90, 210]) {
      const placed = placeLayout(layoutOf(name), rotation);
      const points = [
        ...placed.panels.flatMap((panel) => panel.corners),
        ...placed.others.flatMap((other) =>
          other.corners ?? [
            [other.center[0] - MARKER_RADIUS, other.center[1] - MARKER_RADIUS],
            [other.center[0] + MARKER_RADIUS, other.center[1] + MARKER_RADIUS],
          ],
        ),
      ];
      const { minX, minY, maxX, maxY } = placed.bounds;
      for (const [x, y] of points) assert.ok(x >= minX && x <= maxX && y >= minY && y <= maxY, `${name} ${x},${y}`);
      assert.equal(minX, Math.min(...points.map(([x]) => x)));
      assert.equal(maxX, Math.max(...points.map(([x]) => x)));
      assert.equal(minY, Math.min(...points.map(([, y]) => y)));
      assert.equal(maxY, Math.max(...points.map(([, y]) => y)));
    }
  }
  assert.deepEqual(placeLayout({ controllerId: "c", globalOrientation: 0, panels: [], fetchedAt: FETCHED_AT }).bounds, {
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
  });
});

test("every fixture places edge to edge: connected, no overlaps, the joins the wall physically has", () => {
  for (const [name, expected] of Object.entries(WALLS)) {
    const { panels } = placeLayout(layoutOf(name));
    const graph = adjacency(panels);
    assert.deepEqual([...graph.keys()], panels.map((panel) => panel.id), `${name}: every panel is listed`);
    for (const [id, neighbours] of graph) {
      assert.ok(neighbours.length > 0, `${name}: panel ${id} touches another panel`);
      assert.deepEqual(neighbours, [...neighbours].sort((a, b) => a - b));
      for (const other of neighbours) assert.ok(graph.get(other).includes(id), `${name}: ${id}–${other} is symmetric`);
    }
    assert.ok(isConnected(graph), `${name} is one wall`);
    assert.equal(joinCount(graph), expected.joins, `${name} joins`);

    for (let i = 0; i < panels.length; i++) {
      for (let j = i + 1; j < panels.length; j++) {
        const [a, b] = [panels[i], panels[j]];
        // Centroids are rounded to integers, so shrink each panel by one unit before measuring the overlap.
        const area = overlapArea(inset(a, 1), inset(b, 1));
        assert.ok(area < 1, `${name}: ${a.id} and ${b.id} overlap by ${area.toFixed(2)} square units`);
        const joined = graph.get(a.id).includes(b.id);
        assert.equal(joined, shareEdge(a, b), `${name}: ${a.id}–${b.id} by corners alone`);
      }
    }
  }
});

test("joins sit well inside the ±3 unit tolerance, integer centroids and all", () => {
  for (const name of Object.keys(WALLS)) {
    const { panels } = placeLayout(layoutOf(name));
    const graph = adjacency(panels);
    const byId = new Map(panels.map((panel) => [panel.id, panel]));
    for (const [id, neighbours] of graph) {
      const a = byId.get(id);
      for (const other of neighbours) {
        const b = byId.get(other);
        const dx = b.center[0] - a.center[0];
        const dy = b.center[1] - a.center[1];
        const reach = a.inradius + b.inradius;
        const miss = Math.min(...edgeNormals(a).map(([nx, ny]) => Math.abs(dx * nx + dy * ny - reach)));
        assert.ok(miss <= 1.5, `${name}: ${id}–${other} misses by ${miss.toFixed(2)}`);
      }
    }
  }
});

test("theduck and wings join exactly as described", () => {
  const graphOf = (name) => Object.fromEntries(adjacency(placeLayout(layoutOf(name)).panels));
  assert.deepEqual(graphOf("theduck"), {
    15767: [32797, 42632],
    32797: [15767],
    34671: [36406, 49632],
    36406: [34671, 39807],
    39807: [36406, 42632],
    42632: [15767, 39807],
    49632: [34671],
  });
  const chain = [31270, 20510, 59975, 37923, 1837, 25862, 24968, 923, 34168];
  const wings = graphOf("wings");
  chain.forEach((id, k) => {
    const expected = [chain[k - 1], chain[k + 1]].filter((other) => other !== undefined).sort((a, b) => a - b);
    assert.deepEqual(wings[id], expected, `wings ${id}`);
  });
});

test("big joins by shape as described", () => {
  const { panels } = placeLayout(layoutOf("big"));
  const graph = adjacency(panels);
  const kind = new Map(panels.map((panel) => [panel.id, panel.kind]));
  const counts = {};
  for (const [id, neighbours] of graph) {
    for (const other of neighbours) {
      if (other < id) continue;
      const pair = [kind.get(id), kind.get(other)].sort().join("+");
      counts[pair] = (counts[pair] ?? 0) + 1;
    }
  }
  assert.deepEqual(counts, BIG_JOINS);
});

test("offset joins count, corner touches don't", () => {
  const layout = (panels) => ({ controllerId: "c", globalOrientation: 0, panels, fetchedAt: FETCHED_AT });
  const r = 134 / (2 * Math.sqrt(3));
  const mini = r / 2;
  const hexApothem = (67 * Math.sqrt(3)) / 2;
  const joined = (panels) => joinCount(adjacency(placeLayout(layout(panels)).panels));
  // Two triangles, up and down, sharing a full edge, then offset by half an edge, then by a whole edge (corner).
  for (const [offset, expected] of [[0, 1], [33.5, 1], [67, 1], [132, 1], [133.5, 0], [134, 0]]) {
    const panels = [
      { id: 1, x: 0, y: 0, o: 0, shapeType: 8 },
      { id: 2, x: offset, y: -2 * r, o: 60, shapeType: 8 },
    ];
    assert.equal(joined(panels), expected, `triangles offset by ${offset}`);
  }
  // A mini triangle on half of a triangle's edge; a hexagon edge to edge with a mini triangle, and corner to corner.
  assert.equal(joined([
    { id: 1, x: 0, y: 0, o: 0, shapeType: 8 },
    { id: 2, x: 33.5, y: -(r + mini), o: 60, shapeType: 9 },
  ]), 1);
  assert.equal(joined([
    { id: 1, x: 0, y: 0, o: 0, shapeType: 7 },
    { id: 2, x: 0, y: -(hexApothem + mini), o: 60, shapeType: 9 },
  ]), 1);
  assert.equal(joined([
    { id: 1, x: 0, y: 0, o: 0, shapeType: 7 },
    { id: 2, x: 67, y: -(hexApothem + mini), o: 60, shapeType: 9 },
  ]), 0);
  // A gap wider than the tolerance, and two panels on top of each other, are not joins.
  assert.equal(joined([
    { id: 1, x: 0, y: 0, o: 0, shapeType: 8 },
    { id: 2, x: 0, y: -2 * r - 4, o: 60, shapeType: 8 },
  ]), 0);
  assert.equal(joined([
    { id: 1, x: 0, y: 0, o: 0, shapeType: 8 },
    { id: 2, x: 0, y: 0, o: 0, shapeType: 8 },
  ]), 0);
});

test("the overlap check would catch a misplaced panel", () => {
  const { panels } = placeLayout(layoutOf("wings"));
  const [a, b] = panels;
  const moved = { ...b, center: a.center, corners: a.corners, inradius: a.inradius };
  assert.ok(overlapArea(inset(a, 1), inset(moved, 1)) > 1000);
  const square = (x, y) => [[x, y], [x + 2, y], [x + 2, y + 2], [x, y + 2]];
  close(overlapArea(square(0, 0), square(1, 1)), 1);
  close(overlapArea(square(0, 0), square(0, 0)), 4);
  assert.equal(overlapArea(square(0, 0), square(5, 5)), 0);
  assert.equal(overlapArea(square(0, 0), square(2, 0)), 0);
});

test("rotation keeps every join, and turns the drawing rigidly", () => {
  for (const name of Object.keys(WALLS)) {
    const layout = layoutOf(name);
    const base = placeLayout(layout);
    const expected = adjacency(base.panels);
    for (let rotation = 0; rotation < 360; rotation += 30) {
      const turned = placeLayout(layout, rotation);
      assert.deepEqual(adjacency(turned.panels), expected, `${name} at ${rotation}°`);
      turned.panels.forEach((panel, k) => {
        const [x, y] = rotatePoint(base.panels[k].center, rotation);
        close(panel.center[0], x, 1e-6);
        close(panel.center[1], y, 1e-6);
      });
    }
    // Any global orientation, even one the device would not report, keeps the joins too.
    for (const globalOrientation of [0, 17, 59, 123.5, 299]) {
      assert.deepEqual(adjacency(placeLayout({ ...layout, globalOrientation }).panels), expected, name);
    }
  }
});

test("global orientation turns the wall clockwise; view rotation turns it back", () => {
  const layout = {
    controllerId: "c",
    globalOrientation: 90,
    panels: [{ id: 1, x: 100, y: 0, o: 0, shapeType: 8 }],
    fetchedAt: FETCHED_AT,
  };
  const [panel] = placeLayout(layout).panels;
  close(panel.center[0], 0, 1e-9);
  close(panel.center[1], -100, 1e-9);
  // o = 0 pointed up; turned by −90° its apex points right.
  const apex = panel.corners.reduce((best, corner) => (corner[0] > best[0] ? corner : best));
  close(apex[1], panel.center[1], 1e-9);
  const [back] = placeLayout(layout, 90).panels;
  close(back.center[0], 100, 1e-9);
  close(back.center[1], 0, 1e-9);
});

test("synthesised fixtures look like real device answers", () => {
  for (const name of ["hexagons", "minis", "big"]) {
    const data = info(name);
    assert.equal(data.model, "NL42");
    assert.equal(typeof data.name, "string");
    assert.equal(typeof data.serialNo, "string");
    assert.equal(typeof data.firmwareVersion, "string");
    assert.equal(typeof data.state.on.value, "boolean");
    assert.ok(data.effects.effectsList.includes(data.effects.select));
    const { globalOrientation, layout } = data.panelLayout;
    assert.deepEqual(Object.keys(globalOrientation).sort(), ["max", "min", "value"]);
    assert.equal(layout.sideLength, 0);
    assert.equal(layout.numPanels, layout.positionData.length);
    const ids = new Set(layout.positionData.map((entry) => entry.panelId));
    assert.equal(ids.size, layout.positionData.length, `${name}: unique ids`);
    for (const entry of layout.positionData) {
      assert.deepEqual(Object.keys(entry), ["panelId", "x", "y", "o", "shapeType"]);
      for (const key of ["panelId", "x", "y", "o"]) assert.ok(Number.isInteger(entry[key]), `${name} ${key}`);
      assert.ok(entry.panelId >= 0 && entry.panelId <= 0xffff);
      assert.equal(entry.o % 60, 0);
      assert.ok([7, 8, 9, 12].includes(entry.shapeType));
      assert.equal(entry.panelId === 0, entry.shapeType === 12);
    }
  }
});

test("the controller sits just outside a free edge, clear of every panel", () => {
  for (const name of Object.keys(WALLS)) {
    const placed = placeLayout(layoutOf(name));
    const [controller] = placed.others;
    const hit = panelAt(placed, controller.center);
    assert.equal(hit, null, `${name}: the controller is not inside a panel`);
    const gap = Math.min(...placed.panels.map((panel) => distanceToOutline(controller.center, panel.corners)));
    assert.ok(gap > 5 && gap < 15, `${name}: ${gap.toFixed(1)} units out`);
  }
});

test("Elements and Light Panels layouts place as unsupported ghosts", () => {
  const vegas = placeLayout(layoutOf("lasvegas"));
  assert.equal(vegas.panels.length, 0);
  assert.equal(vegas.others.length, 103);
  assert.equal(vegas.others.filter((other) => other.role === "controller").length, 1);
  for (const other of vegas.others.filter((item) => item.role === "unsupported")) {
    assert.equal(other.shapeType, 15);
    assert.equal(other.corners, null);
  }
  for (const value of Object.values(vegas.bounds)) assert.ok(Number.isFinite(value));

  const invader = placeLayout(layoutOf("spaceinvader"));
  assert.equal(invader.panels.length, 0);
  assert.equal(invader.others.length, 9);
  for (const other of invader.others) {
    assert.equal(other.role, "unsupported");
    assert.equal(other.corners.length, 3);
    const [cx, cy] = other.center;
    for (const [x, y] of other.corners) close(Math.hypot(x - cx, y - cy), 150 / Math.sqrt(3), 1e-9);
  }
  assert.deepEqual(adjacency(invader.panels), new Map());
});

test("panelAt finds the panel under a point", () => {
  const placed = placeLayout(layoutOf("big"), 30);
  for (const panel of placed.panels) {
    assert.equal(panelAt(placed, panel.center)?.id, panel.id);
    const nearCorner = [
      panel.center[0] + (panel.corners[0][0] - panel.center[0]) * 0.9,
      panel.center[1] + (panel.corners[0][1] - panel.center[1]) * 0.9,
    ];
    assert.equal(panelAt(placed, nearCorner)?.id, panel.id);
  }
  assert.equal(panelAt(placed, [placed.bounds.maxX + 10, placed.bounds.maxY + 10]), null);
  assert.equal(pointInPolygon([0, 0], [[-1, -1], [1, -1], [1, 1], [-1, 1]]), true);
  assert.equal(pointInPolygon([2, 0], [[-1, -1], [1, -1], [1, 1], [-1, 1]]), false);
});

test("fitView centres the bounds in the viewport and flips Y", () => {
  const bounds = { minX: -100, minY: 0, maxX: 100, maxY: 50 };
  const { scale, tx, ty } = fitView(bounds, 400, 300, 20);
  close(scale, 1.8);
  const map = ([x, y]) => [x * scale + tx, -y * scale + ty];
  assert.deepEqual(map([0, 25]), [200, 150]);
  close(map([-100, 0])[0], 20);
  close(map([100, 0])[0], 380);
  assert.ok(map([0, 50])[1] < map([0, 0])[1], "up is up");
  const tall = fitView({ minX: 0, minY: 0, maxX: 10, maxY: 100 }, 400, 300, 0);
  close(tall.scale, 3);
  const point = fitView({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, 100, 100, 10);
  for (const value of Object.values(point)) assert.ok(Number.isFinite(value));
  assert.deepEqual([5 * point.scale + point.tx, -5 * point.scale + point.ty], [50, 50]);
  assert.equal(fitView(bounds, 10, 10, 20).scale, 0);
});

test("centroidOf averages centres", () => {
  assert.deepEqual(centroidOf([]), [0, 0]);
  assert.deepEqual(centroidOf([{ center: [0, 0] }, { center: [4, 2] }, { center: [2, 4] }]), [2, 2]);
});
