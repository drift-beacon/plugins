/**
 * Fill orders: automatic sweeps and paths over a placed layout, a seeded shuffle, and resolving a saved order against
 * the panels the wall has now. Everything is deterministic: the same panels (in any input order) give the same order.
 */
import { adjacency } from "./geometry.ts";
import type { AutoOrder, PanelOrder, PlacedPanel, Point } from "./types.ts";

/** Centres closer than this (layout units) count as level or aligned: the device rounds centroids to integers. */
const LEVEL = 1;
/** Turns closer than this (radians) count as equal. */
const SAME_TURN = 1e-3;
/**
 * How many steps the search for a walk through every panel may take before settling for the greedy walk. Warnsdorff
 * ordering finds most paths almost at once; the cap only matters for large walls where no such walk exists.
 */
const SEARCH_BUDGET = 20000;

/** Compares with a tolerance: values within `LEVEL` of each other are equal. */
function compare(a: number, b: number): number {
  return Math.abs(a - b) < LEVEL ? 0 : a - b;
}

/** Lowest, then leftmost, then lowest id. */
function lowerLeft(a: PlacedPanel, b: PlacedPanel): number {
  return compare(a.center[1], b.center[1]) || compare(a.center[0], b.center[0]) || a.id - b.id;
}

/**
 * An automatic order of the panels' ids. The sweeps sort by centre: `left-right` by x, then top first;
 * `right-left` mirrors it; `bottom-up` by y, then left first; `top-down` mirrors it. `path` walks neighbouring panels
 * so the fill feels like one continuous stroke (see `pathOrder`).
 */
export function autoOrder(panels: readonly PlacedPanel[], kind: AutoOrder): number[] {
  const sorted = [...panels].sort((a, b) => a.id - b.id);
  const x = (p: PlacedPanel) => p.center[0];
  const y = (p: PlacedPanel) => p.center[1];
  const sweep = (by: (a: PlacedPanel, b: PlacedPanel) => number) => sorted.sort(by).map((panel) => panel.id);
  switch (kind) {
    case "left-right":
      return sweep((a, b) => compare(x(a), x(b)) || compare(y(b), y(a)));
    case "right-left":
      return sweep((a, b) => compare(x(b), x(a)) || compare(y(b), y(a)));
    case "bottom-up":
      return sweep((a, b) => compare(y(a), y(b)) || compare(x(a), x(b)));
    case "top-down":
      return sweep((a, b) => compare(y(b), y(a)) || compare(x(a), x(b)));
    default:
      return pathOrder(sorted);
  }
}

/** What a walk steps over: the panels by id and each one's neighbours. */
interface Walker {
  readonly byId: ReadonlyMap<number, PlacedPanel>;
  readonly graph: ReadonlyMap<number, readonly number[]>;
}

/** Angle in radians between two directions, 0 to π. */
function turn(from: Point | null, to: Point): number {
  if (!from) return 0;
  return Math.abs(Math.atan2(from[0] * to[1] - from[1] * to[0], from[0] * to[0] + from[1] * to[1]));
}

function direction(from: PlacedPanel, to: PlacedPanel): Point {
  return [to.center[0] - from.center[0], to.center[1] - from.center[1]];
}

/**
 * The unvisited neighbours of `current`, best first: fewest unvisited neighbours of their own (Warnsdorff), then the
 * smallest turn from the previous step, then lowest, then leftmost.
 */
function candidates(walker: Walker, current: PlacedPanel, previous: Point | null, visited: Set<number>): PlacedPanel[] {
  const { byId, graph } = walker;
  const unvisited = (id: number) => (graph.get(id) ?? []).filter((next) => !visited.has(next));
  const scored = unvisited(current.id).map((id) => {
    const panel = byId.get(id) as PlacedPanel;
    return { panel, free: unvisited(id).length, turn: turn(previous, direction(current, panel)) };
  });
  scored.sort((a, b) => {
    if (a.free !== b.free) return a.free - b.free;
    if (Math.abs(a.turn - b.turn) > SAME_TURN) return a.turn - b.turn;
    return lowerLeft(a.panel, b.panel);
  });
  return scored.map((entry) => entry.panel);
}

/** The wall by index for the greedy walk, which runs once per possible start: typed arrays keep that cheap. */
interface Grid {
  readonly panels: readonly PlacedPanel[];
  readonly links: readonly (readonly number[])[];
}

function gridOf(walker: Walker): Grid {
  const panels = [...walker.byId.values()].sort((a, b) => a.id - b.id);
  const index = new Map(panels.map((panel, i) => [panel.id, i]));
  const links = panels.map((panel) => (walker.graph.get(panel.id) ?? []).map((id) => index.get(id) as number));
  return { panels, links };
}

/** A walk and what its jumps cost: how many, the longest and their total length (layout units). */
interface Walk {
  readonly order: number[];
  readonly jumps: number;
  readonly longest: number;
  readonly total: number;
}

/**
 * The greedy walk from panel `start` (an index): step to the unvisited neighbour that leaves the fewest groups of
 * panels behind, then Warnsdorff (fewest unvisited neighbours), then the smallest turn, then lowest, then leftmost.
 * When stuck, jump to the unvisited panel nearest the current one among those touching a lit panel (ties: fewest
 * unvisited neighbours, then lowest, then leftmost), so every prefix of the order is one piece of the wall; a wall in
 * pieces falls back to the nearest unvisited panel once a piece is done.
 */
function greedyWalk(grid: Grid, start: number): Walk {
  const { panels, links } = grid;
  const n = panels.length;
  const visited = new Uint8Array(n);
  /** Unvisited neighbours of each panel, and visited ones (a panel touching the lit part has at least one). */
  const free = Int32Array.from(links, (list) => list.length);
  const lit = new Int32Array(n);
  const seen = new Uint32Array(n);
  const stack = new Int32Array(n);
  let stamp = 0;
  /** How many groups of unvisited panels a step to `to` would leave that the walk can't carry on into. */
  const stranded = (to: number): number => {
    stamp++;
    seen[to] = stamp;
    let groups = 0;
    let continues = false;
    for (let root = 0; root < n; root++) {
      if (visited[root] || seen[root] === stamp) continue;
      groups++;
      seen[root] = stamp;
      let top = 0;
      stack[top++] = root;
      while (top > 0) {
        for (const next of links[stack[--top] as number] as number[]) {
          if (next === to) continues = true;
          if (visited[next] || seen[next] === stamp) continue;
          seen[next] = stamp;
          stack[top++] = next;
        }
      }
    }
    return continues ? groups - 1 : groups;
  };

  const order: number[] = [];
  let jumps = 0;
  let longest = 0;
  let total = 0;
  let current = start;
  let heading: Point | null = null;
  for (;;) {
    visited[current] = 1;
    order.push((panels[current] as PlacedPanel).id);
    for (const next of links[current] as number[]) {
      free[next]--;
      lit[next]++;
    }
    if (order.length === n) return { order, jumps, longest, total };
    const here = panels[current] as PlacedPanel;
    let best = -1;
    let bestLeft = 0;
    let bestTurn = 0;
    for (const option of links[current] as number[]) {
      if (visited[option]) continue;
      const panel = panels[option] as PlacedPanel;
      const bend = turn(heading, direction(here, panel));
      // Once a step strands nothing, only another such step that ranks higher on Warnsdorff can beat it.
      if (best >= 0 && bestLeft === 0 && (free[option] as number) > (free[best] as number)) continue;
      const left = stranded(option);
      const better =
        best < 0 ||
        (left !== bestLeft
          ? left < bestLeft
          : free[option] !== free[best]
            ? (free[option] as number) < (free[best] as number)
            : Math.abs(bend - bestTurn) > SAME_TURN
              ? bend < bestTurn
              : lowerLeft(panel, panels[best] as PlacedPanel) < 0);
      if (better) {
        best = option;
        bestLeft = left;
        bestTurn = bend;
      }
    }
    if (best >= 0) {
      heading = direction(here, panels[best] as PlacedPanel);
    } else {
      let bestDistance = Infinity;
      let touching = false;
      for (let i = 0; i < n; i++) {
        if (visited[i]) continue;
        const touches = (lit[i] as number) > 0;
        if (touching && !touches) continue;
        const panel = panels[i] as PlacedPanel;
        const distance = Math.hypot(panel.center[0] - here.center[0], panel.center[1] - here.center[1]);
        const better =
          best < 0 ||
          touches !== touching ||
          (Math.abs(distance - bestDistance) > 1e-9
            ? distance < bestDistance
            : free[i] !== free[best]
              ? (free[i] as number) < (free[best] as number)
              : lowerLeft(panel, panels[best] as PlacedPanel) < 0);
        if (better) {
          best = i;
          bestDistance = distance;
          touching = touches;
        }
      }
      if (best < 0) return { order, jumps, longest, total };
      jumps++;
      longest = Math.max(longest, bestDistance);
      total += bestDistance;
      // A jump has no heading to keep turning from.
      heading = null;
    }
    current = best;
  }
}

/** Fewest jumps, then the shortest longest jump, then the least jumping overall. */
function betterWalk(a: Walk, b: Walk): boolean {
  if (a.jumps !== b.jumps) return a.jumps < b.jumps;
  if (Math.abs(a.longest - b.longest) > 1e-9) return a.longest < b.longest;
  return a.total < b.total - 1e-9;
}

/**
 * A walk through every panel stepping only between neighbours (a Hamiltonian path), searched depth first in the
 * greedy walk's own preference order, so when the greedy walk already is one it is returned unchanged. Null when
 * there is none, or the search runs out of budget.
 */
function fullWalk(walker: Walker, start: PlacedPanel, budget: { steps: number }): number[] | null {
  const total = walker.byId.size;
  const visited = new Set<number>([start.id]);
  const order = [start.id];
  const extend = (current: PlacedPanel, previous: Point | null): boolean => {
    if (order.length === total) return true;
    for (const next of candidates(walker, current, previous, visited)) {
      if (--budget.steps < 0) return false;
      visited.add(next.id);
      order.push(next.id);
      if (extend(next, direction(current, next))) return true;
      visited.delete(next.id);
      order.pop();
    }
    return false;
  };
  return extend(start, null) ? order : null;
}

function isConnected(graph: ReadonlyMap<number, readonly number[]>): boolean {
  const first = graph.keys().next();
  if (first.done) return true;
  const seen = new Set<number>([first.value]);
  const stack = [first.value];
  while (stack.length > 0) {
    for (const id of graph.get(stack.pop() as number) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(id);
    }
  }
  return seen.size === graph.size;
}

/**
 * The `path` order. It starts at the lowest (then leftmost) panel and steps to the unvisited neighbour with the
 * fewest unvisited neighbours (Warnsdorff), breaking ties by the smallest turn, then lowest, then leftmost.
 *
 * When the wall has a walk through every panel between neighbours, it is used, so the fill never jumps. A panel with
 * one neighbour must end such a walk, so the search starts from the lowest panel when it can be an end, then from
 * those panels (lowest first); a wall with three or more of them has no such walk.
 *
 * Otherwise the greedy walk (see `greedyWalk`) runs from the lowest panel and from every panel with one neighbour,
 * and the walk with the fewest and shortest jumps wins (the lowest start on a tie). Its jumps only ever land next to
 * panels already lit, so every prefix of the order is one piece of the wall.
 */
function pathOrder(panels: readonly PlacedPanel[]): number[] {
  if (panels.length === 0) return [];
  const walker: Walker = { byId: new Map(panels.map((panel) => [panel.id, panel])), graph: adjacency(panels) };
  const byHeight = [...panels].sort(lowerLeft);
  const start = byHeight[0] as PlacedPanel;
  const ends = byHeight.filter((panel) => walker.graph.get(panel.id)?.length === 1);
  if (panels.length > 2 && isConnected(walker.graph) && ends.length <= 2) {
    const starts = ends.length === 2 ? ends : [start, ...ends];
    if (ends.length === 0) starts.push(...byHeight.filter((panel) => panel !== start));
    const budget = { steps: SEARCH_BUDGET };
    for (const from of new Set(starts)) {
      const walk = fullWalk(walker, from, budget);
      if (walk) return walk;
      if (budget.steps < 0) break;
    }
  }
  const grid = gridOf(walker);
  const indexOf = (panel: PlacedPanel) => grid.panels.indexOf(panel);
  let best = greedyWalk(grid, indexOf(start));
  for (const from of ends) {
    if (best.jumps === 0) break;
    if (from === start) continue;
    const walk = greedyWalk(grid, indexOf(from));
    if (betterWalk(walk, best)) best = walk;
  }
  return best.order;
}

/** mulberry32: a small seeded PRNG giving floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Fisher–Yates shuffle driven by `mulberry32(seed)`: the same ids and seed always give the same order. */
export function shuffle(ids: readonly number[], seed: number): number[] {
  const out = [...ids];
  const random = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = out[i] as number;
    out[i] = out[j] as number;
    out[j] = swap;
  }
  return out;
}

/**
 * The order to fill this layout in: `auto` computes it, `random` shuffles the panel ids (ascending, so rotating the
 * drawing never reshuffles) by the seed, and `custom` keeps the saved ids that still exist (first copy of each), then
 * appends any new panels in path order.
 */
export function resolveOrder(order: PanelOrder, panels: readonly PlacedPanel[]): number[] {
  if (order.mode === "random")
    return shuffle(
      panels.map((panel) => panel.id).sort((a, b) => a - b),
      order.seed,
    );
  if (order.mode !== "custom") return autoOrder(panels, order.auto);
  const present = new Set(panels.map((panel) => panel.id));
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of order.ids) {
    if (!present.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length < present.size) for (const id of autoOrder(panels, "path")) if (!seen.has(id)) out.push(id);
  return out;
}

/** Whether a saved order names exactly this layout's panels, each once (so a custom order needs no fixing up). */
export function isComplete(order: PanelOrder, panels: readonly { readonly id: number }[]): boolean {
  const ids = new Set(panels.map((panel) => panel.id));
  if (order.ids.length !== ids.size) return false;
  const seen = new Set<number>();
  for (const id of order.ids) {
    if (!ids.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}
