import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { adjacency, layoutFromPanelLayout, placeLayout } from "../shared/geometry.ts";
import { autoOrder, isComplete, mulberry32, resolveOrder, shuffle } from "../shared/order.ts";
import { AUTO_ORDERS, readOrder } from "../shared/storage.ts";

const WALLS = ["theduck", "wings", "hexagons", "minis", "big"];
const layoutOf = (name) => {
  const data = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
  return layoutFromPanelLayout(data.panelLayout, data.serialNo, "2026-09-30T12:00:00.000Z");
};
const panelsOf = (name, rotation = 0) => placeLayout(layoutOf(name), rotation).panels;
const idsOf = (panels) => panels.map((panel) => panel.id);
const sorted = (ids) => [...ids].sort((a, b) => a - b);
const x = (panel) => panel.center[0];
const y = (panel) => panel.center[1];

/** Whether the graph has a walk through every node between neighbours (bitmask DP, fine up to ~20 nodes). */
function hasHamiltonianPath(graph) {
  const ids = [...graph.keys()];
  const index = new Map(ids.map((id, k) => [id, k]));
  const n = ids.length;
  const reach = Array.from({ length: 1 << n }, () => new Uint8Array(n));
  for (let v = 0; v < n; v++) reach[1 << v][v] = 1;
  for (let mask = 1; mask < 1 << n; mask++) {
    for (let v = 0; v < n; v++) {
      if (!reach[mask][v]) continue;
      for (const neighbour of graph.get(ids[v])) {
        const w = index.get(neighbour);
        if (!(mask & (1 << w))) reach[mask | (1 << w)][w] = 1;
      }
    }
  }
  return reach[(1 << n) - 1].some(Boolean);
}

const jumpsIn = (order, graph) => order.slice(1).filter((id, k) => !graph.get(order[k]).includes(id)).length;

/** Lowest, then leftmost (centres within one unit count as level, as order.ts does). */
const lowerLeft = (a, b) => {
  if (Math.abs(y(a) - y(b)) >= 1) return y(a) - y(b);
  return Math.abs(x(a) - x(b)) >= 1 ? x(a) - x(b) : a.id - b.id;
};

test("every automatic order is a permutation of the panels", () => {
  for (const name of WALLS) {
    for (const rotation of [0, 90, 210]) {
      const panels = panelsOf(name, rotation);
      for (const kind of AUTO_ORDERS) {
        const order = autoOrder(panels, kind);
        assert.deepEqual(sorted(order), sorted(idsOf(panels)), `${name} ${kind} ${rotation}°`);
      }
    }
  }
});

test("orders are deterministic and don't depend on the order panels arrive in", () => {
  for (const name of WALLS) {
    const panels = panelsOf(name, 30);
    const reversed = [...panels].reverse();
    const scrambled = shuffle(idsOf(panels), 7).map((id) => panels.find((panel) => panel.id === id));
    for (const kind of AUTO_ORDERS) {
      const order = autoOrder(panels, kind);
      assert.deepEqual(autoOrder(panels, kind), order);
      assert.deepEqual(autoOrder(reversed, kind), order, `${name} ${kind}`);
      assert.deepEqual(autoOrder(scrambled, kind), order, `${name} ${kind}`);
    }
    assert.deepEqual(idsOf(panels), sorted(idsOf(panels)), "the input is left alone");
  }
});

test("sweeps order by centre: left to right with the top first, bottom to top with the left first", () => {
  for (const name of WALLS) {
    for (const rotation of [0, 60, 150]) {
      const panels = panelsOf(name, rotation);
      const byId = new Map(panels.map((panel) => [panel.id, panel]));
      const pairs = (kind) => {
        const order = autoOrder(panels, kind).map((id) => byId.get(id));
        return order.slice(1).map((panel, k) => [order[k], panel]);
      };
      for (const [a, b] of pairs("left-right")) {
        assert.ok(x(a) <= x(b) + 1, `${name}: left-right`);
        if (Math.abs(x(a) - x(b)) < 1) assert.ok(y(a) >= y(b) - 1, `${name}: left-right, top first`);
      }
      for (const [a, b] of pairs("right-left")) {
        assert.ok(x(a) >= x(b) - 1, `${name}: right-left`);
        if (Math.abs(x(a) - x(b)) < 1) assert.ok(y(a) >= y(b) - 1, `${name}: right-left, top first`);
      }
      for (const [a, b] of pairs("bottom-up")) {
        assert.ok(y(a) <= y(b) + 1, `${name}: bottom-up`);
        if (Math.abs(y(a) - y(b)) < 1) assert.ok(x(a) <= x(b) + 1, `${name}: bottom-up, left first`);
      }
      for (const [a, b] of pairs("top-down")) {
        assert.ok(y(a) >= y(b) - 1, `${name}: top-down`);
        if (Math.abs(y(a) - y(b)) < 1) assert.ok(x(a) <= x(b) + 1, `${name}: top-down, left first`);
      }
    }
  }
});

test("right-left mirrors left-right, and top-down mirrors bottom-up", () => {
  const mirror = (panels, flipX) =>
    panels.map((panel) => ({ ...panel, center: flipX ? [-x(panel), y(panel)] : [x(panel), -y(panel)] }));
  for (const name of WALLS) {
    const panels = panelsOf(name, 90);
    assert.deepEqual(autoOrder(panels, "right-left"), autoOrder(mirror(panels, true), "left-right"), name);
    assert.deepEqual(autoOrder(panels, "top-down"), autoOrder(mirror(panels, false), "bottom-up"), name);
  }
});

test("sweeps on a small grid, including level panels that differ only by rounding", () => {
  const panel = (id, cx, cy) => ({ id, shapeType: 7, kind: "hexagon", side: 67, center: [cx, cy], inradius: 58 });
  const grid = [panel(1, 0, 0), panel(2, 100, 0.4), panel(3, 0.3, 100), panel(4, 100, 100), panel(5, 50, 50)];
  assert.deepEqual(autoOrder(grid, "left-right"), [3, 1, 5, 4, 2]);
  assert.deepEqual(autoOrder(grid, "right-left"), [4, 2, 5, 3, 1]);
  assert.deepEqual(autoOrder(grid, "bottom-up"), [1, 2, 5, 3, 4]);
  assert.deepEqual(autoOrder(grid, "top-down"), [3, 4, 5, 1, 2]);
});

test("path walks neighbour to neighbour on every wall that allows it (theduck, wings, hexagons, minis)", () => {
  for (const name of ["theduck", "wings", "hexagons", "minis"]) {
    const graph = adjacency(panelsOf(name));
    assert.ok(hasHamiltonianPath(graph), `${name} has a walk through every panel`);
    for (let rotation = 0; rotation < 360; rotation += 30) {
      const panels = panelsOf(name, rotation);
      const order = autoOrder(panels, "path");
      assert.equal(jumpsIn(order, graph), 0, `${name} at ${rotation}°: ${order.join(" ")}`);
    }
    for (const globalOrientation of [0, 17, 123]) {
      const panels = placeLayout({ ...layoutOf(name), globalOrientation }).panels;
      assert.equal(jumpsIn(autoOrder(panels, "path"), graph), 0, `${name} at global ${globalOrientation}°`);
    }
  }
});

test("wings: the path is its chain of nine triangles, from the lower end", () => {
  const chain = [31270, 20510, 59975, 37923, 1837, 25862, 24968, 923, 34168];
  for (let rotation = 0; rotation < 360; rotation += 30) {
    const panels = panelsOf("wings", rotation);
    const order = autoOrder(panels, "path");
    const [first, last] = [chain[0], chain[8]].map((id) => panels.find((panel) => panel.id === id));
    const expected = lowerLeft(first, last) <= 0 ? chain : [...chain].reverse();
    assert.deepEqual(order, expected, `${rotation}°`);
  }
});

test("path starts at the lowest panel unless that would break the walk", () => {
  // The honeycomb has no dead ends, so the walk starts where DESIGN.md says: lowest, then leftmost.
  for (const rotation of [0, 30, 90, 180, 270]) {
    const panels = panelsOf("hexagons", rotation);
    const lowest = [...panels].sort(lowerLeft)[0];
    assert.equal(autoOrder(panels, "path")[0], lowest.id, `${rotation}°`);
  }
  // theduck is a chain; unturned, its lowest panel (the mini 34671) sits one step in from the triangle at the end.
  // Starting there would strand the triangle, so the walk starts at the chain's lower end instead.
  const duck = panelsOf("theduck");
  assert.equal([...duck].sort(lowerLeft)[0].id, 34671);
  assert.deepEqual(autoOrder(duck, "path"), [49632, 34671, 36406, 39807, 42632, 15767, 32797]);
});

/** Every prefix of `order` is one piece of the wall: each panel after the first touches one lit before it. */
function assertConnectedPrefixes(order, graph, label) {
  const lit = new Set([order[0]]);
  for (let k = 1; k < order.length; k++) {
    const touches = graph.get(order[k]).some((id) => lit.has(id));
    assert.ok(touches, `${label}: step ${k} (${order[k]}) lands next to the lit part`);
    lit.add(order[k]);
  }
}

/** The jumps in `order` (steps between panels that don't touch): how many and the longest, in layout units. */
function jumpStats(order, graph, byId) {
  let jumps = 0;
  let longest = 0;
  for (let k = 1; k < order.length; k++) {
    if (graph.get(order[k - 1]).includes(order[k])) continue;
    const [a, b] = [byId.get(order[k - 1]), byId.get(order[k])];
    jumps++;
    longest = Math.max(longest, Math.hypot(x(a) - x(b), y(a) - y(b)));
  }
  return { jumps, longest };
}

test("big has no walk through every panel: the path's jumps stay few, short and on the lit part's edge", () => {
  const graph = adjacency(panelsOf("big"));
  // A walk has two ends; seven panels with a single neighbour would each have to be one.
  assert.equal([...graph.values()].filter((list) => list.length === 1).length, 7);
  const bounds = placeLayout(layoutOf("big")).bounds;
  const diagonal = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  for (let rotation = 0; rotation < 360; rotation += 30) {
    const panels = panelsOf("big", rotation);
    const byId = new Map(panels.map((panel) => [panel.id, panel]));
    const order = autoOrder(panels, "path");
    assert.deepEqual(sorted(order), sorted(idsOf(panels)));
    // Never a jump across the wall: the fill only ever grows from what is lit.
    assertConnectedPrefixes(order, graph, `${rotation}°`);
    const { jumps, longest } = jumpStats(order, graph, byId);
    // Seven dead ends need at least three jumps; the greedy walk from the best start keeps it to five.
    assert.ok(jumps >= 3 && jumps <= 5, `${rotation}°: ${jumps} jumps`);
    const what = `${rotation}°: longest jump ${longest.toFixed(0)} across a ${diagonal.toFixed(0)} wall`;
    assert.ok(longest < diagonal / 3, what);
  }
});

test("every prefix of the path is one piece of the wall, on every fixture and at every rotation", () => {
  for (const name of WALLS) {
    const graph = adjacency(panelsOf(name));
    for (let rotation = 0; rotation < 360; rotation += 30) {
      assertConnectedPrefixes(autoOrder(panelsOf(name, rotation), "path"), graph, `${name} at ${rotation}°`);
    }
  }
});

test("on grown mini-triangle walls the path stays connected and its jumps stay short", () => {
  // Walls grown triangle by triangle from a seed, like a real Shapes wall, with plenty of dead ends.
  const SIDE = 67;
  const ROW = (SIDE * Math.sqrt(3)) / 2;
  const key = (a, b, s) => `${a},${b},${s}`;
  const neighbours = (a, b, s) =>
    s === "U" ? [[a, b - 1, "D"], [a, b, "D"], [a - 1, b, "D"]] : [[a + 1, b, "U"], [a, b + 1, "U"], [a, b, "U"]];
  const centre = (a, b, s) => {
    const k = s === "U" ? 1 / 3 : 2 / 3;
    return [a * SIDE + (b * SIDE) / 2 + k * SIDE * 1.5, b * ROW + k * ROW];
  };
  for (const n of [12, 30, 60]) {
    for (let seed = 1; seed <= 6; seed++) {
      const random = mulberry32(seed * 97 + n);
      const cells = new Map([[key(0, 0, "U"), [0, 0, "U"]]]);
      const list = [[0, 0, "U"]];
      while (cells.size < n) {
        const cell = list[Math.floor(random() * list.length)];
        const next = neighbours(...cell)[Math.floor(random() * 3)];
        if (cells.has(key(...next))) continue;
        cells.set(key(...next), next);
        list.push(next);
      }
      const raw = [...cells.values()].map(([a, b, s], i) => {
        const [cx, cy] = centre(a, b, s);
        return { id: i + 1, x: Math.round(cx), y: Math.round(cy), o: s === "U" ? 0 : 60, shapeType: 9 };
      });
      const layout = { controllerId: "c", globalOrientation: 0, panels: raw, fetchedAt: "" };
      const graph = adjacency(placeLayout(layout).panels);
      for (const rotation of [0, 90, 210]) {
        const panels = placeLayout(layout, rotation).panels;
        const order = autoOrder(panels, "path");
        assert.deepEqual(sorted(order), sorted(idsOf(panels)), `n ${n} seed ${seed}`);
        assertConnectedPrefixes(order, graph, `n ${n} seed ${seed} at ${rotation}°`);
      }
    }
  }
});

test("path handles tiny and broken walls", () => {
  assert.deepEqual(autoOrder([], "path"), []);
  const [one, two] = panelsOf("wings").filter((panel) => panel.id === 31270 || panel.id === 34168);
  assert.deepEqual(autoOrder([one], "path"), [one.id]);
  const apart = autoOrder([two, one], "path");
  assert.deepEqual(apart, [one, two].sort(lowerLeft).map((panel) => panel.id));
  // Without its middle mini triangle theduck falls into two chains of three. A real wall is always in one piece (the
  // panels carry each other's power), so this only happens if a join goes unseen; the greedy walk still covers it.
  const duck = panelsOf("theduck").filter((panel) => panel.id !== 39807);
  const order = autoOrder(duck, "path");
  assert.deepEqual(sorted(order), sorted(idsOf(duck)));
  const jumps = jumpsIn(order, adjacency(duck));
  assert.ok(jumps >= 1 && jumps <= 2, `${jumps} jumps`);
  assert.deepEqual(autoOrder(duck, "path"), order);
});

test("shuffle is a seeded Fisher–Yates: same seed, same order", () => {
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // Pinned: a saved random order must come out the same after an update, in main and the UI alike.
  assert.deepEqual(shuffle(ids, 1), [8, 9, 4, 3, 2, 6, 10, 5, 1, 7]);
  assert.deepEqual(shuffle(ids, 2), [1, 10, 5, 2, 7, 6, 4, 9, 3, 8]);
  assert.equal(mulberry32(1)(), 0.6270739405881613);
  assert.deepEqual(shuffle(ids, 12345), shuffle(ids, 12345));
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "the input is left alone");
  const seen = new Set();
  for (let seed = 0; seed < 50; seed++) {
    const order = shuffle(ids, seed);
    assert.deepEqual(sorted(order), ids);
    seen.add(order.join());
  }
  assert.equal(seen.size, 50, "different seeds, different orders");
  assert.deepEqual(shuffle([], 3), []);
  assert.deepEqual(shuffle([42], 3), [42]);
  // Every arrangement of three is about equally likely (an off-by-one in the swap range would skew this).
  const counts = new Map();
  for (let seed = 0; seed < 6000; seed++) {
    const key = shuffle([1, 2, 3], seed).join();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  assert.equal(counts.size, 6);
  for (const [key, count] of counts) assert.ok(count > 850 && count < 1150, `${key}: ${count}`);
  for (let k = 0, next = mulberry32(99); k < 1000; k++) {
    const value = next();
    assert.ok(value >= 0 && value < 1);
  }
});

test("resolveOrder: auto and random are computed from the layout", () => {
  for (const name of WALLS) {
    const panels = panelsOf(name);
    for (const auto of AUTO_ORDERS) {
      assert.deepEqual(resolveOrder({ mode: "auto", auto, ids: [1, 2], seed: 5 }, panels), autoOrder(panels, auto));
    }
    const random = (seed, ids = []) => resolveOrder({ mode: "random", auto: "left-right", ids, seed }, panels);
    assert.deepEqual(random(9), shuffle(sorted(idsOf(panels)), 9));
    assert.deepEqual(random(9, [123, 456]), random(9), "saved ids don't matter");
    assert.deepEqual(sorted(random(4)), sorted(idsOf(panels)));
    if (panels.length > 5) assert.notDeepEqual(random(1), random(2), name);
  }
});

test("a random order doesn't change when the drawing is rotated; the automatic ones follow the wall", () => {
  const RANDOM = { mode: "random", auto: "path", ids: [], seed: 12345 };
  for (const name of WALLS) {
    const random = (rotation) => resolveOrder(RANDOM, panelsOf(name, rotation));
    for (let rotation = 30; rotation < 360; rotation += 30) {
      assert.deepEqual(random(rotation), random(0), `${name} ${rotation}°`);
    }
    // The panels may arrive in any order too.
    assert.deepEqual(resolveOrder(RANDOM, [...panelsOf(name, 90)].reverse()), random(0), name);
  }
  const SWEEP = { ...RANDOM, mode: "auto", auto: "bottom-up" };
  const bottomUp = (rotation) => resolveOrder(SWEEP, panelsOf("theduck", rotation));
  assert.notDeepEqual(bottomUp(0), bottomUp(180), "a sweep follows the wall as it hangs");
});

test("resolveOrder: custom keeps the saved order and fixes it up when panels come and go", () => {
  const panels = panelsOf("big");
  const path = autoOrder(panels, "path");
  const saved = shuffle(idsOf(panels), 3);
  const custom = (ids) => resolveOrder({ mode: "custom", auto: "path", ids, seed: 1 }, panels);
  assert.deepEqual(custom(saved), saved);
  assert.deepEqual(custom([]), path);

  // Panels taken off the wall disappear from the order; repeats count once.
  const gone = [9999, 1, saved[0], saved[0], 65535];
  assert.deepEqual(custom([...gone, ...saved.slice(1)]), saved);

  // Panels added to the wall join the end, in path order.
  const kept = saved.slice(0, 20);
  const expected = [...kept, ...path.filter((id) => !kept.includes(id))];
  assert.deepEqual(custom(kept), expected);

  // A smaller wall: the saved order for the whole wall resolves to what is left, in the same relative order.
  const fewer = panels.filter((panel) => !saved.slice(5, 8).includes(panel.id));
  const resolved = resolveOrder({ mode: "custom", auto: "path", ids: saved, seed: 1 }, fewer);
  assert.deepEqual(resolved, saved.filter((id) => !saved.slice(5, 8).includes(id)));

  // What storage reads back resolves the same way.
  const stored = readOrder(JSON.parse(JSON.stringify({ mode: "custom", auto: "path", ids: kept, seed: 1 })));
  assert.deepEqual(resolveOrder(stored, panels), expected);
  assert.deepEqual(resolveOrder(readOrder(undefined), panels), path);
});

test("isComplete is true only when the saved ids are exactly the layout's panels", () => {
  const panels = panelsOf("wings");
  const ids = idsOf(panels);
  const order = (list) => ({ mode: "custom", auto: "path", ids: list, seed: 1 });
  assert.equal(isComplete(order(ids), panels), true);
  assert.equal(isComplete(order([...ids].reverse()), panels), true);
  assert.equal(isComplete(order(ids.slice(1)), panels), false, "one missing");
  assert.equal(isComplete(order([...ids, 4242]), panels), false, "one extra");
  assert.equal(isComplete(order([...ids.slice(1), 4242]), panels), false, "one swapped for a stranger");
  assert.equal(isComplete(order([...ids.slice(1), ids[2]]), panels), false, "a repeat");
  assert.equal(isComplete(order([]), []), true);
  assert.equal(isComplete(order([]), panels), false);
  assert.equal(isComplete(order(ids), [{ id: ids[0] }]), false);
});
