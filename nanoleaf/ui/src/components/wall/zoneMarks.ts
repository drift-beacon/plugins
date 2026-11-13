import type { PlacedPanel, Point, Rgb } from "../../../../shared/types.ts";
import type { Px } from "../../lib/svg.ts";
import type { Stage } from "./stageLayout.ts";

/** A zone's name tag on the drawing. */
export interface ZoneTag {
  readonly id: string;
  readonly name: string;
  readonly rgb: Rgb;
  /** Its panels: the tag sits at their middle. */
  readonly panels: readonly number[];
}

/** A tag placed in stage pixels: its centre. */
export interface PlacedTag extends ZoneTag {
  readonly at: Px;
}

const toPx = (stage: Stage, [x, y]: Point): Px => [x * stage.scale + stage.tx, -y * stage.scale + stage.ty];

/** Distance from `p` to the segment `a`–`b`, layout units. */
function toSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * The outer edges of a group of panels, as one SVG path in stage pixels, each pulled `inset` px inside its own panel
 * so it reads on the panel rather than the seam. An edge is inner when its middle lies on an edge of another panel of
 * the group.
 */
export function zoneOutline(panels: readonly PlacedPanel[], stage: Stage, inset = 2.5): string {
  let d = "";
  for (const panel of panels) {
    const sp = stage.byId.get(panel.id);
    if (!sp) continue;
    const k = sp.inradius > inset ? (sp.inradius - inset) / sp.inradius : 0;
    const pull = (p: Px): Px => [sp.center[0] + (p[0] - sp.center[0]) * k, sp.center[1] + (p[1] - sp.center[1]) * k];
    const c = panel.corners;
    for (let i = 0; i < c.length; i++) {
      const a = c[i] as Point;
      const b = c[(i + 1) % c.length] as Point;
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const inner = panels.some(
        (other) =>
          other !== panel &&
          other.corners.some((oa, j) => toSegment(mid, oa, other.corners[(j + 1) % other.corners.length] as Point) < 2),
      );
      if (inner) continue;
      const [ax, ay] = pull(toPx(stage, a));
      const [bx, by] = pull(toPx(stage, b));
      d += `M${ax.toFixed(1)} ${ay.toFixed(1)}L${bx.toFixed(1)} ${by.toFixed(1)}`;
    }
  }
  return d;
}

/** A tag's size on screen, px, from its name: a dot, the name at 11px, padding. */
export function tagSize(name: string): { readonly w: number; readonly h: number } {
  return { w: Math.round(Math.min(name.length, 22) * 6.2 + 26), h: 20 };
}

/**
 * Where each zone's tag goes: the middle of its panels, moved down or up (in steps of a tag's height, nearest first)
 * when it would cover a tag already placed, and kept inside the stage. A zone with no panels has no tag. Overlaps that
 * no step clears are left: they are rare, and every name still shows.
 */
export function placeTags(tags: readonly ZoneTag[], stage: Stage): PlacedTag[] {
  const placed: { tag: PlacedTag; w: number; h: number }[] = [];
  const hits = (x: number, y: number, w: number, h: number) =>
    placed.some((p) => Math.abs(p.tag.at[0] - x) < (p.w + w) / 2 + 4 && Math.abs(p.tag.at[1] - y) < (p.h + h) / 2 + 2);
  for (const tag of tags) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const id of tag.panels) {
      const panel = stage.byId.get(id);
      if (!panel) continue;
      sx += panel.center[0];
      sy += panel.center[1];
      n++;
    }
    if (n === 0) continue;
    const { w, h } = tagSize(tag.name);
    const clampX = (x: number) => Math.min(Math.max(x, w / 2 + 2), stage.width - w / 2 - 2);
    const clampY = (y: number) => Math.min(Math.max(y, h / 2 + 2), stage.height - h / 2 - 2);
    const x = clampX(sx / n);
    const y0 = clampY(sy / n);
    let y = y0;
    for (const step of [0, 1, -1, 2, -2, 3, -3]) {
      const candidate = clampY(y0 + step * (h + 4));
      if (!hits(x, candidate, w, h)) {
        y = candidate;
        break;
      }
    }
    placed.push({ tag: { ...tag, at: [x, y] }, w, h });
  }
  return placed.map((p) => p.tag);
}

/**
 * What the drawing says while choosing panels for `name`'s zone. A drag paints panels except with a touch on a zoomed
 * drawing (`zoomed` and a `coarse` pointer), where it pans instead: then the words say tap only.
 */
export function choosingLabel(name: string, zoomed: boolean, coarse: boolean): string {
  return zoomed && coarse
    ? `Your wall: tap panels to bring them into ${name}'s zone`
    : `Your wall: tap or drag across panels to bring them into ${name}'s zone`;
}
