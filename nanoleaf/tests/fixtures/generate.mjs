/**
 * Generates the synthesised Shapes layouts (hexagons.json, minis.json, big.json) as full `GET /` info objects, the
 * shape the real fixtures have. Run it once from the plugin folder: node tests/fixtures/generate.mjs
 *
 * Every Shapes wall sits on one triangular lattice of mini-triangle cells (side 67): a mini triangle is one cell, a
 * triangle four, a hexagon the six around a lattice point. Panels are built from cells here, independently of
 * shared/geometry.ts, so the geometry tests cross-check its corner conventions against this construction. Two panels
 * touch exactly when a cell of one shares an edge with a cell of the other; that is how the expected adjacency
 * counts in tests/geometry.test.mjs were derived. Centroids are rounded to integers, like the device reports them.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SIDE = 67;
const ROW = (SIDE * Math.sqrt(3)) / 2;
/** How far outside a panel edge the controller's centroid sits (measured on theduck.json and wings.json). */
const CONTROLLER_GAP = 10.4;

/** Lattice point P(a, b) = a·e1 + b·e2, with e1 = (67, 0) and e2 = (33.5, 58.02). */
const point = (a, b) => [a * SIDE + (b * SIDE) / 2, b * ROW];
const key = (a, b, s) => `${a},${b},${s}`;

/** A cell: "U" points up (corners P(a,b), P(a+1,b), P(a,b+1)); "D" points down (P(a+1,b), P(a+1,b+1), P(a,b+1)). */
function cellCentroid(a, b, s) {
  const [x, y] = point(a, b);
  const k = s === "U" ? 1 / 3 : 2 / 3;
  return [x + k * (SIDE + SIDE / 2), y + k * ROW];
}

/** The three cells across a cell's edges, with the outward normal (degrees) of each edge. */
function cellEdges(a, b, s) {
  return s === "U"
    ? [
        [key(a, b - 1, "D"), 270],
        [key(a, b, "D"), 30],
        [key(a - 1, b, "D"), 150],
      ]
    : [
        [key(a + 1, b, "U"), 330],
        [key(a, b + 1, "U"), 90],
        [key(a, b, "U"), 210],
      ];
}

/** Panel builders: cells, shape type and the orientations the device may report for it. */
const UP = [0, 120, 240];
const DOWN = [60, 180, 300];
export const shapes = {
  /** Mini triangle in cell (a, b, "U" | "D"). */
  mini: (a, b, s) => ({ shapeType: 9, cells: [[a, b, s]], orientations: s === "U" ? UP : DOWN }),
  /** Triangle pointing up with its bottom-left corner at P(a, b). */
  up: (a, b) => ({
    shapeType: 8,
    cells: [[a, b, "U"], [a + 1, b, "U"], [a, b + 1, "U"], [a, b, "D"]],
    orientations: UP,
  }),
  /** Triangle pointing down with corners P(a+2, b), P(a+2, b+2), P(a, b+2): the other half of up(a, b)'s rhombus. */
  down: (a, b) => ({
    shapeType: 8,
    cells: [[a + 1, b, "D"], [a, b + 1, "D"], [a + 1, b + 1, "U"], [a + 1, b + 1, "D"]],
    orientations: DOWN,
  }),
  /** Hexagon centred on P(a, b). */
  hex: (a, b) => ({
    shapeType: 7,
    cells: [[a, b, "U"], [a - 1, b, "U"], [a, b - 1, "U"], [a - 1, b, "D"], [a - 1, b - 1, "D"], [a, b - 1, "D"]],
    orientations: [0, 60, 120, 180, 240, 300],
  }),
};

/** Hexagon (q, r) of a flat-topped honeycomb: q steps 30° (100.5, 58), r steps 90° (0, 116). */
export const honeycomb = (q, r) => shapes.hex(q - r, q + 2 * r);

/** mulberry32: small, seeded, good enough for ids and orientations. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds a layout from panels and a controller spot (`controller: [panelIndex, normal]`: the controller sits outside
 * that panel's free edge facing `normal`). Throws when panels overlap, the wall is in pieces or the spot is taken.
 */
export function build({ panels, controller, seed }) {
  const next = random(seed);
  const owner = new Map();
  panels.forEach((panel, index) => {
    for (const [a, b, s] of panel.cells) {
      const k = key(a, b, s);
      if (owner.has(k)) throw new Error(`Panels ${owner.get(k)} and ${index} overlap at cell ${k}`);
      owner.set(k, index);
    }
  });

  const edges = new Set();
  panels.forEach((panel, index) => {
    for (const [a, b, s] of panel.cells) {
      for (const [across] of cellEdges(a, b, s)) {
        const other = owner.get(across);
        if (other !== undefined && other !== index) edges.add(`${Math.min(index, other)}-${Math.max(index, other)}`);
      }
    }
  });
  const reached = new Set([0]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const edge of edges) {
      const [i, j] = edge.split("-").map(Number);
      if (reached.has(i) !== reached.has(j)) {
        reached.add(i).add(j);
        changed = true;
      }
    }
  }
  if (reached.size !== panels.length) throw new Error("The wall is in pieces");

  const ids = new Set();
  while (ids.size < panels.length) ids.add(1000 + Math.floor(next() * 64000));
  const idList = [...ids];

  const positions = panels.map((panel, index) => {
    const points = panel.cells.map(([a, b, s]) => cellCentroid(a, b, s));
    const x = points.reduce((sum, [px]) => sum + px, 0) / points.length;
    const y = points.reduce((sum, [, py]) => sum + py, 0) / points.length;
    const o = panel.orientations[Math.floor(next() * panel.orientations.length)];
    return { panelId: idList[index], x, y, o, shapeType: panel.shapeType };
  });

  const [host, normal] = controller;
  const free = panels[host].cells.find(([a, b, s]) =>
    cellEdges(a, b, s).some(([across, n]) => n === normal && !owner.has(across)),
  );
  if (!free) throw new Error(`Panel ${host} has no free edge facing ${normal}°`);
  const [cx, cy] = cellCentroid(...free);
  const reach = SIDE / (2 * Math.sqrt(3)) + CONTROLLER_GAP;
  positions.push({
    panelId: 0,
    x: cx + reach * Math.cos((normal * Math.PI) / 180),
    y: cy + reach * Math.sin((normal * Math.PI) / 180),
    o: (normal + 270) % 360,
    shapeType: 12,
  });

  // Shift so every centroid is comfortably positive, then round like the device does.
  const minX = Math.min(...positions.map((p) => p.x));
  const minY = Math.min(...positions.map((p) => p.y));
  const positionData = positions.map((p) => ({
    ...p,
    x: Math.round(p.x - minX + 50),
    y: Math.round(p.y - minY + 40),
  }));
  return { positionData, edges: edges.size };
}

function info({ name, serialNo, globalOrientation, positionData }) {
  return {
    name,
    serialNo,
    manufacturer: "Nanoleaf",
    firmwareVersion: "9.2.4",
    hardwareVersion: "2.3-0",
    model: "NL42",
    discovery: {},
    effects: {
      effectsList: ["Beatdrop", "Blaze", "Cocoa Beach", "Cotton Candy", "Morning Sky", "Northern Lights", "Starlight"],
      select: "Northern Lights",
    },
    firmwareUpgrade: {},
    panelLayout: {
      globalOrientation: { value: globalOrientation, max: 360, min: 0 },
      layout: { numPanels: positionData.length, sideLength: 0, positionData },
    },
    schedules: {},
    state: {
      brightness: { value: 64, max: 100, min: 0 },
      colorMode: "effect",
      ct: { value: 4000, max: 6500, min: 1200 },
      hue: { value: 0, max: 360, min: 0 },
      on: { value: true },
      sat: { value: 0, max: 100, min: 0 },
    },
  };
}

/** The synthesised walls: panels on the lattice, the controller's spot, and a seed for ids and orientations. */
export const layouts = {
  // Twelve hexagons in four columns of 3, 4, 3 and 2.
  hexagons: {
    name: "Shapes Honeycomb",
    serialNo: "S19124C0HEX",
    globalOrientation: 0,
    seed: 7,
    panels: [
      [0, 0], [0, 1], [0, 2],
      [1, -1], [1, 0], [1, 1], [1, 2],
      [2, -1], [2, 0], [2, 1],
      [3, -1], [3, 0],
    ].map(([q, r]) => honeycomb(q, r)),
    controller: [0, 210],
  },
  // Ten mini triangles in a zig-zag strip: along a row, up a diagonal, then along the next row.
  minis: {
    name: "Shapes Minis",
    serialNo: "S19124C0MIN",
    globalOrientation: 240,
    seed: 11,
    panels: [
      [0, 0, "U"], [0, 0, "D"], [1, 0, "U"], [1, 0, "D"],
      [1, 1, "U"], [1, 1, "D"], [1, 2, "U"], [1, 2, "D"],
      [2, 2, "U"], [2, 2, "D"],
    ].map(([a, b, s]) => shapes.mini(a, b, s)),
    controller: [0, 150],
  },
  // Wall art: a flower of seven hexagons with triangle rays, a triangle ridge beneath and mini triangle sparks.
  big: {
    name: "Shapes Sunrise",
    serialNo: "S19124C0BIG",
    globalOrientation: 0,
    seed: 23,
    panels: [
      // The flower: a centre and its six neighbours.
      honeycomb(0, 0),
      honeycomb(1, 0),
      honeycomb(0, 1),
      honeycomb(-1, 1),
      honeycomb(-1, 0),
      honeycomb(0, -1),
      honeycomb(1, -1),
      // Rays, each on half of its triangle's edge: up, up-right, down-right, down-left, up-left.
      shapes.up(-2, 3),
      shapes.down(1, 0),
      shapes.up(3, -2),
      shapes.up(-3, -2),
      shapes.down(-5, 1),
      // The ridge below, from left to right, with a hexagon at each end.
      shapes.up(-4, -5),
      shapes.down(-4, -5),
      shapes.up(-2, -5),
      shapes.down(-2, -5),
      shapes.up(0, -5),
      shapes.down(0, -5),
      shapes.up(2, -5),
      shapes.hex(-5, -4),
      shapes.hex(3, -3),
      // Sparks.
      shapes.mini(-2, 4, "D"),
      shapes.mini(-2, 5, "U"),
      shapes.mini(3, 1, "U"),
      shapes.mini(3, 1, "D"),
      shapes.mini(4, -2, "D"),
      shapes.mini(-5, 3, "U"),
      shapes.mini(-6, 3, "D"),
      shapes.mini(-6, -3, "U"),
      shapes.mini(-6, -3, "D"),
      shapes.mini(3, -5, "D"),
      shapes.mini(3, -6, "D"),
    ],
    controller: [12, 270],
  },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [file, spec] of Object.entries(layouts)) {
    const { positionData, edges } = build(spec);
    const url = new URL(`./${file}.json`, import.meta.url);
    writeFileSync(url, `${JSON.stringify(info({ ...spec, positionData }), null, 2)}\n`);
    console.log(`${file}.json: ${positionData.length - 1} panels + controller, ${edges} shared edges`);
  }
}
