import { fitView } from "../../../../shared/geometry.ts";
import type { PanelKind, PlacedLayout, PlacedOther, Point } from "../../../../shared/types.ts";
import { insetPolygon, type Px, roundedPath, squarePath } from "../../lib/svg.ts";

/** Panels are drawn this many layout units inside their true outline, so the seams between them show. */
const SEAM = 3;
/** Corner rounding, as a fraction of a panel's side (the diffusers' soft corners). */
const CORNER = 0.085;
/** Pixels per layout unit, at most: a small wall in a wide column stays life-sized rather than ballooning. */
const MAX_SCALE = 1.45;
/** The drawing is never shorter than this (unless the column is), so a one-row wall still has room to glow. */
const MIN_HEIGHT = 240;
/** A panel whose outline is narrower than this (px, its shorter side) is hard to hit with a finger: offer zoom. */
export const MIN_TARGET = 32;
/** Zooming further than this would leave too little of the wall in view to find your way. */
export const MAX_ZOOM = 3;

/** A light panel, placed in stage pixels (x right, y down). */
export interface StagePanel {
  readonly id: number;
  readonly kind: PanelKind;
  readonly shapeType: number;
  readonly center: Px;
  /** Distance from the centre to an edge, in pixels. */
  readonly inradius: number;
  /** The lit diffuser: inset for the seam, corners rounded. */
  readonly path: string;
  /** The panel's full outline: taps and drops that land on a seam still count. */
  readonly hit: string;
  /** The shorter side of the outline's bounding box, px: how big a target the panel is. */
  readonly hitSize: number;
}

/** The controller or a shape this plugin doesn't drive, drawn as an inert marker or dashed ghost. */
export interface StageOther {
  readonly id: number;
  readonly role: PlacedOther["role"];
  readonly center: Px;
  readonly path: string;
}

/** Everything the stage draws, in pixels, for one size and view rotation. */
export interface Stage {
  readonly width: number;
  readonly height: number;
  /** Layout → pixels: `sx = x·scale + tx`, `sy = −y·scale + ty` (the same mapping as `fitView`). */
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
  readonly panels: readonly StagePanel[];
  readonly byId: ReadonlyMap<number, StagePanel>;
  readonly others: readonly StageOther[];
  /** Where light pools on the floor under the wall. */
  readonly floor: { readonly cx: number; readonly cy: number; readonly rx: number; readonly ry: number };
  /** Bloom blur radius (feGaussianBlur stdDeviation) in pixels. */
  readonly bloom: number;
}

/** Breathing room around the drawing for bloom and number badges, in pixels. */
export function stagePadding(width: number): number {
  return Math.min(48, Math.max(24, width * 0.07));
}

/** How tall the stage should be at `width`: the wall's own proportions, between a floor and `maxHeight`. */
export function stageHeight(placed: PlacedLayout, width: number, maxHeight: number): number {
  const pad = stagePadding(width);
  const { minX, minY, maxX, maxY } = placed.bounds;
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const scale = Math.min((width - 2 * pad) / w, (maxHeight - 2 * pad) / h, MAX_SCALE);
  return Math.round(Math.min(maxHeight, Math.max(Math.min(MIN_HEIGHT, maxHeight), h * scale + 2 * pad)));
}

/**
 * Projects a placed layout into a `width` × `height` stage: fitted, centred, each panel's paths ready to draw. `pad`
 * defaults to the stage's breathing room; a thumbnail passes its own.
 */
export function layoutStage(placed: PlacedLayout, width: number, height: number, pad = stagePadding(width)): Stage {
  const { minX, minY, maxX, maxY } = placed.bounds;
  let { scale, tx, ty } = fitView(placed.bounds, width, height, pad);
  if (scale > MAX_SCALE) {
    scale = MAX_SCALE;
    tx = width / 2 - ((minX + maxX) / 2) * scale;
    ty = height / 2 + ((minY + maxY) / 2) * scale;
  }
  const px = ([x, y]: Point): Px => [x * scale + tx, -y * scale + ty];

  const panels = placed.panels.map((p): StagePanel => {
    const center = px(p.center);
    const corners = p.corners.map(px);
    const inradius = p.inradius * scale;
    const inner = insetPolygon(corners, center, inradius, SEAM * scale);
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const hitSize = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    return {
      id: p.id,
      kind: p.kind,
      shapeType: p.shapeType,
      center,
      inradius,
      path: roundedPath(inner, p.side * CORNER * scale),
      hit: roundedPath(corners, 1),
      hitSize,
    };
  });

  const others = placed.others.map((o): StageOther => {
    const center = px(o.center);
    const path =
      o.role === "controller" || !o.corners
        ? squarePath(center, Math.max(9, 24 * scale), Math.max(2.5, 6 * scale))
        : roundedPath(o.corners.map(px), 4 * scale);
    return { id: o.id, role: o.role, center, path };
  });

  const left = minX * scale + tx;
  const right = maxX * scale + tx;
  const bottom = -minY * scale + ty;
  return {
    width,
    height,
    scale,
    tx,
    ty,
    panels,
    byId: new Map(panels.map((p) => [p.id, p])),
    others,
    floor: {
      cx: (left + right) / 2,
      cy: Math.min(height - 6, bottom + pad * 0.35),
      rx: Math.max(40, (right - left) * 0.55),
      ry: Math.max(10, Math.min(22, pad * 0.45)),
    },
    bloom: Math.min(26, Math.max(7, 16 * scale)),
  };
}

/** The smallest panel's target size (`hitSize`), px; Infinity for a stage without panels. */
export function smallestTarget(stage: Stage): number {
  let min = Number.POSITIVE_INFINITY;
  for (const p of stage.panels) min = Math.min(min, p.hitSize);
  return min;
}

/**
 * How far to zoom so every panel is at least a `MIN_TARGET` finger target, in quarter steps up to `MAX_ZOOM`; 1 when
 * the stage already is (a big wall on a phone draws mini triangles about 20 px across).
 */
export function zoomFor(stage: Stage): number {
  const min = smallestTarget(stage);
  if (!(min < MIN_TARGET) || !(min > 0)) return 1;
  return Math.min(MAX_ZOOM, Math.ceil((MIN_TARGET / min) * 4) / 4);
}
