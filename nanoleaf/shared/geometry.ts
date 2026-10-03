/**
 * Panel geometry: shapes, polygons, global orientation, bounds and adjacency. Conventions (checked against real
 * Shapes layouts, see DESIGN.md): layout units with Y up, `o` in degrees counter-clockwise; triangle corner k sits at
 * 90° + o + 120°·k, hexagon corner k at o + 60°·k (flat top and bottom at o = 0).
 */
import { readRawPanels } from "./storage.ts";
import { SHAPES_CONTROLLER } from "./types.ts";
import type { Layout, LightShapeType, PanelKind, PlacedLayout, PlacedOther, PlacedPanel, Point } from "./types.ts";

/** Every shape the plugin knows how to draw; only `light` ones are driven. */
export type ShapeKind =
  | PanelKind
  | "controller"
  | "light-panels-triangle"
  | "canvas-square"
  | "elements-hexagon"
  | "elements-corner";

/** A shape's drawing: `side` in layout units and `sides` corners, or 0 for both when it is drawn as a marker. */
export interface ShapeInfo {
  readonly kind: ShapeKind;
  readonly side: number;
  readonly sides: 0 | 3 | 4 | 6;
  readonly light: boolean;
}

/** Shape types by `shapeType`, with side lengths from the API docs (the layout's own `sideLength` is unreliable). */
export const SHAPES: Readonly<Record<number, ShapeInfo>> = Object.freeze({
  0: { kind: "light-panels-triangle", side: 150, sides: 3, light: false },
  2: { kind: "canvas-square", side: 100, sides: 4, light: false },
  3: { kind: "canvas-square", side: 100, sides: 4, light: false },
  4: { kind: "canvas-square", side: 100, sides: 4, light: false },
  7: { kind: "hexagon", side: 67, sides: 6, light: true },
  8: { kind: "triangle", side: 134, sides: 3, light: true },
  9: { kind: "mini-triangle", side: 67, sides: 3, light: true },
  12: { kind: "controller", side: 0, sides: 0, light: false },
  14: { kind: "elements-hexagon", side: 134, sides: 6, light: false },
  15: { kind: "elements-corner", side: 0, sides: 0, light: false },
});

/** Names for UI copy, by `shapeType`. */
export const SHAPE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  7: "Hexagon",
  8: "Triangle",
  9: "Mini triangle",
  12: "Controller",
});

/** A shape's name for UI copy ("Hexagon · 36776"); anything the plugin doesn't drive is "Unsupported". */
export function shapeLabel(shapeType: number): string {
  return SHAPE_NAMES[shapeType] ?? "Unsupported";
}

/** Half the size of the marker drawn for the controller and shapes without a polygon; bounds include it. */
export const MARKER_RADIUS = 12;

/** How far (layout units) two facing edges may be apart and still touch: the device rounds centroids to integers. */
export const TOUCH_TOLERANCE = 3;

const RAD = Math.PI / 180;
const SQRT3 = Math.sqrt(3);

/** Degrees wrapped into [0, 360). */
export function normalizeDegrees(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped >= 360 ? 0 : wrapped + 0;
}

/** Rotates a point about the origin, counter-clockwise for positive degrees (Y up). */
export function rotatePoint(point: Point, degrees: number): Point {
  const [x, y] = point;
  if (degrees % 360 === 0) return [x, y];
  const cos = Math.cos(degrees * RAD);
  const sin = Math.sin(degrees * RAD);
  return [x * cos - y * sin, x * sin + y * cos];
}

/** Circumradius (centre to corner) of a known polygonal shape, or 0 for markers. */
function circumradius(shape: ShapeInfo): number {
  if (shape.sides === 3) return shape.side / SQRT3;
  if (shape.sides === 4) return shape.side / Math.SQRT2;
  if (shape.sides === 6) return shape.side;
  return 0;
}

/** Inradius (centre to the middle of an edge) of a known polygonal shape, or 0 for markers. */
function inradiusOf(shape: ShapeInfo): number {
  if (shape.sides === 3) return shape.side / (2 * SQRT3);
  if (shape.sides === 4) return shape.side / 2;
  if (shape.sides === 6) return (shape.side * SQRT3) / 2;
  return 0;
}

/**
 * Corners (counter-clockwise, Y up) of a shape centred at `center` and turned by `orientation` degrees, or null when
 * the shape has no known polygon (the controller, Elements corners, unknown types).
 */
export function shapeCorners(shapeType: number, center: Point, orientation: number): Point[] | null {
  const shape = SHAPES[shapeType];
  if (!shape || shape.sides === 0) return null;
  const radius = circumradius(shape);
  const first = orientation + (shape.sides === 3 ? 90 : shape.sides === 4 ? 45 : 0);
  const step = 360 / shape.sides;
  const [cx, cy] = center;
  const corners: Point[] = [];
  for (let k = 0; k < shape.sides; k++) {
    const angle = (first + step * k) * RAD;
    corners.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return corners;
}

/**
 * Places a layout for drawing and ordering: every centroid is rotated about the origin by
 * θ = viewRotation − globalOrientation and θ is added to each orientation. Light panels (types 7, 8, 9) go to
 * `panels`, everything else to `others`, both sorted by id; `bounds` covers every corner and marker.
 */
export function placeLayout(layout: Layout, viewRotation = 0): PlacedLayout {
  const theta = viewRotation - layout.globalOrientation;
  const panels: PlacedPanel[] = [];
  const others: PlacedOther[] = [];
  const seen = new Set<number>();
  for (const raw of layout.panels) {
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    const center = rotatePoint([raw.x, raw.y], theta);
    const orientation = normalizeDegrees(raw.o + theta);
    const shape = SHAPES[raw.shapeType];
    const corners = shapeCorners(raw.shapeType, center, orientation);
    if (shape?.light && corners) {
      panels.push({
        id: raw.id,
        shapeType: raw.shapeType as LightShapeType,
        kind: shape.kind as PanelKind,
        side: shape.side,
        center,
        corners,
        inradius: inradiusOf(shape),
      });
    } else {
      const role = raw.shapeType === SHAPES_CONTROLLER ? "controller" : "unsupported";
      others.push({ id: raw.id, shapeType: raw.shapeType, center, corners, role });
    }
  }
  panels.sort((a, b) => a.id - b.id);
  others.sort((a, b) => a.id - b.id);
  return { panels, others, bounds: boundsOf(panels, others) };
}

function boundsOf(panels: readonly PlacedPanel[], others: readonly PlacedOther[]): PlacedLayout["bounds"] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const panel of panels) for (const [x, y] of panel.corners) include(x, y);
  for (const other of others) {
    if (other.corners) for (const [x, y] of other.corners) include(x, y);
    else {
      include(other.center[0] - MARKER_RADIUS, other.center[1] - MARKER_RADIUS);
      include(other.center[0] + MARKER_RADIUS, other.center[1] + MARKER_RADIUS);
    }
  }
  if (minX > maxX) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** Unit vectors from a panel's centre to the middle of each edge. */
export function edgeNormals(panel: PlacedPanel): Point[] {
  const { corners, center } = panel;
  return corners.map((corner, k) => {
    const next = corners[(k + 1) % corners.length] as Point;
    const mx = (corner[0] + next[0]) / 2 - center[0];
    const my = (corner[1] + next[1]) / 2 - center[1];
    const length = Math.hypot(mx, my) || 1;
    return [mx / length, my / length] as Point;
  });
}

/**
 * Whether panel B lies across one of A's edges: along some edge normal n of A, the centre-to-centre vector d has
 * |d·n − (rA + rB)| ≤ TOUCH_TOLERANCE, and the edges overlap by more than one unit:
 * |d × n| < (sideA + sideB)/2 − 1. The second test admits offset joins, such as a mini triangle against half of a
 * triangle's edge.
 */
function touches(a: PlacedPanel, normals: readonly Point[], b: PlacedPanel): boolean {
  const dx = b.center[0] - a.center[0];
  const dy = b.center[1] - a.center[1];
  const reach = a.inradius + b.inradius;
  const overlap = (a.side + b.side) / 2 - 1;
  for (const [nx, ny] of normals) {
    const along = dx * nx + dy * ny;
    if (Math.abs(along - reach) > TOUCH_TOLERANCE) continue;
    if (Math.abs(dx * ny - dy * nx) < overlap) return true;
  }
  return false;
}

/** Which panels share an edge (fully or offset): every panel id maps to its neighbours' ids, ascending. */
export function adjacency(panels: readonly PlacedPanel[]): Map<number, number[]> {
  const graph = new Map<number, number[]>();
  for (const panel of panels) graph.set(panel.id, []);
  const normals = panels.map(edgeNormals);
  const radii = panels.map((panel) => {
    const [cx, cy] = panel.center;
    return Math.max(...panel.corners.map(([x, y]) => Math.hypot(x - cx, y - cy)));
  });
  for (let i = 0; i < panels.length; i++) {
    const a = panels[i] as PlacedPanel;
    for (let j = i + 1; j < panels.length; j++) {
      const b = panels[j] as PlacedPanel;
      if (a.id === b.id) continue;
      const distance = Math.hypot(b.center[0] - a.center[0], b.center[1] - a.center[1]);
      if (distance > (radii[i] as number) + (radii[j] as number) + TOUCH_TOLERANCE) continue;
      if (touches(a, normals[i] as Point[], b) || touches(b, normals[j] as Point[], a)) {
        graph.get(a.id)?.push(b.id);
        graph.get(b.id)?.push(a.id);
      }
    }
  }
  for (const list of graph.values()) list.sort((x, y) => x - y);
  return graph;
}

/** The mean of the panels' centres (the origin for none): where the UI centres its floor glow. */
export function centroidOf(panels: readonly { readonly center: Point }[]): Point {
  if (panels.length === 0) return [0, 0];
  let x = 0;
  let y = 0;
  for (const panel of panels) {
    x += panel.center[0];
    y += panel.center[1];
  }
  return [x / panels.length, y / panels.length];
}

/** Whether a point lies inside a polygon (even-odd rule; points on an edge may go either way). */
export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as Point;
    const [xj, yj] = polygon[j] as Point;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The light panel under a point in placed layout space (Y up), for hit testing taps and drags. */
export function panelAt(placed: PlacedLayout, point: Point): PlacedPanel | null {
  for (const panel of placed.panels) if (pointInPolygon(point, panel.corners)) return panel;
  return null;
}

/**
 * Fits bounds (Y up) into a width × height viewport with `padding` pixels on every side, centred. Map a point with
 * `sx = x·scale + tx`, `sy = −y·scale + ty` (SVG, Y down).
 */
export function fitView(
  bounds: PlacedLayout["bounds"],
  width: number,
  height: number,
  padding = 0,
): { scale: number; tx: number; ty: number } {
  const spanX = Math.max(bounds.maxX - bounds.minX, 1);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1);
  const scale = Math.max(Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY), 0);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { scale, tx: width / 2 - cx * scale, ty: height / 2 + cy * scale };
}

/** The area of a simple polygon (positive when its corners run counter-clockwise). */
export function polygonArea(polygon: readonly Point[]): number {
  let twice = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as Point;
    const [xj, yj] = polygon[j] as Point;
    twice += xj * yi - xi * yj;
  }
  return twice / 2;
}

/**
 * The area two convex counter-clockwise polygons share (Sutherland–Hodgman clipping): used to check that a layout's
 * panels don't overlap.
 */
export function overlapArea(a: readonly Point[], b: readonly Point[]): number {
  let clipped: Point[] = [...a];
  for (let i = 0; i < b.length && clipped.length > 0; i++) {
    const [ax, ay] = b[i] as Point;
    const [bx, by] = b[(i + 1) % b.length] as Point;
    const side = ([x, y]: Point) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const input = clipped;
    clipped = [];
    for (let k = 0; k < input.length; k++) {
      const current = input[k] as Point;
      const previous = input[(k + input.length - 1) % input.length] as Point;
      const sc = side(current);
      const sp = side(previous);
      if (sc >= 0) {
        if (sp < 0) clipped.push(intersect(previous, current, sp, sc));
        clipped.push(current);
      } else if (sp >= 0) {
        clipped.push(intersect(previous, current, sp, sc));
      }
    }
  }
  return clipped.length < 3 ? 0 : Math.abs(polygonArea(clipped));
}

function intersect(p: Point, q: Point, sp: number, sq: number): Point {
  const t = sp / (sp - sq);
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

/**
 * A `Layout` from the controller's panel layout: `GET /panelLayout` (`{ globalOrientation: { value }, layout:
 * { positionData } }`), the flattened `{ globalOrientation, positionData }`, or a whole `GET /` info object.
 * `panelId` becomes `id`, `o` and the global orientation are wrapped into [0, 360), `sideLength` is ignored (it is
 * 0 on newer firmware) and malformed entries are dropped.
 */
export function layoutFromPanelLayout(panelLayout: unknown, controllerId: string, fetchedAt: string): Layout {
  let raw = isRecord(panelLayout) ? panelLayout : {};
  if (isRecord(raw.panelLayout)) raw = raw.panelLayout;
  const orientation = isRecord(raw.globalOrientation) ? raw.globalOrientation.value : raw.globalOrientation;
  const inner = isRecord(raw.layout) ? raw.layout : raw;
  return {
    controllerId,
    globalOrientation:
      typeof orientation === "number" && Number.isFinite(orientation) ? normalizeDegrees(orientation) : 0,
    panels: readRawPanels(inner.positionData, "panelId"),
    fetchedAt,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
