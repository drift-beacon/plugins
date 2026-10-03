import type { Px } from "../../lib/svg.ts";
import type { Stage } from "./stageLayout.ts";

/** Badges are laid out at this size and scaled to each panel, so a number keeps its shape as it flies. */
export const BADGE_BASE = 30;
/** The number's size inside a badge at `BADGE_BASE`, px. */
export const BADGE_TEXT = 13;
/** The smallest a sequence number may render, px: smaller badges get a bigger font so the digits stay legible. */
export const MIN_TEXT_PX = 11;
/** The largest badge, px: a big hexagon's number stays a label, not a sticker. */
const MAX_SIZE = 32;
/** Badges this close (px) count as touching: a hair of stage between them keeps two numbers apart. */
const GAP = 1;
/** Rounds of nudging overlapping badges apart. */
const RELAX_ROUNDS = 12;

/** The smallest badge that still holds `count`'s digits at `MIN_TEXT_PX`. */
export function minBadgeSize(count: number): number {
  return count >= 100 ? 22 : count >= 10 ? 18 : 16;
}

/** Where and how big one panel's number sits on the stage. */
export interface BadgeFit {
  /** Centre, stage px: the panel's centre, nudged a little when a neighbour's badge would overlap. */
  readonly at: Px;
  /** Diameter, px. */
  readonly size: number;
  /** `size / BADGE_BASE`: the badge is laid out at the base size and scaled. */
  readonly scale: number;
  /** Font size at the base size, px, so the rendered number is at least `MIN_TEXT_PX`. */
  readonly font: number;
  /** Still overlapping a bigger neighbour's badge after nudging: shown only while its panel is hovered or focused. */
  readonly hidden: boolean;
}

/**
 * Sizes every panel's number to its panel (1.25 × inradius, within a legible minimum and 32 px), nudges badges that
 * would overlap apart (each by at most about half its panel's inradius, so it still sits on its panel), then hides
 * whatever still overlaps, smaller panels first. Big walls on phones keep readable numbers instead of 7 px ones.
 */
export function fitBadges(stage: Stage, count: number): Map<number, BadgeFit> {
  const floor = minBadgeSize(count);
  const panels = stage.panels;
  const size = panels.map((p) => Math.min(MAX_SIZE, Math.max(floor, p.inradius * 1.25)));
  const reach = panels.map((p) => Math.max(3, p.inradius * 0.6));
  const pos = panels.map((p) => [p.center[0], p.center[1]]);
  const n = panels.length;

  for (let round = 0; round < RELAX_ROUNDS; round++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos[i] as number[];
        const b = pos[j] as number[];
        const want = ((size[i] as number) + (size[j] as number)) / 2 + GAP;
        let dx = (b[0] as number) - (a[0] as number);
        let dy = (b[1] as number) - (a[1] as number);
        let d = Math.hypot(dx, dy);
        if (d >= want) continue;
        if (d < 1e-6) {
          dx = 1;
          dy = 0;
          d = 1;
        }
        const push = (want - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        a[0] = (a[0] as number) - ux * push;
        a[1] = (a[1] as number) - uy * push;
        b[0] = (b[0] as number) + ux * push;
        b[1] = (b[1] as number) + uy * push;
        moved = true;
      }
    }
    // Keep every badge within reach of its own panel's centre.
    for (let i = 0; i < n; i++) {
      const c = (panels[i] as Stage["panels"][number]).center;
      const p = pos[i] as number[];
      const off = Math.hypot((p[0] as number) - c[0], (p[1] as number) - c[1]);
      const max = reach[i] as number;
      if (off > max) {
        p[0] = c[0] + (((p[0] as number) - c[0]) / off) * max;
        p[1] = c[1] + (((p[1] as number) - c[1]) / off) * max;
      }
    }
    if (!moved) break;
  }

  // Whatever still overlaps: the bigger panel keeps its number (ties: the lower id), the other waits for hover.
  const rank = panels
    .map((_, i) => i)
    .sort((i, j) => {
      const a = panels[i] as Stage["panels"][number];
      const b = panels[j] as Stage["panels"][number];
      return b.inradius - a.inradius || a.id - b.id;
    });
  const hidden = new Array<boolean>(n).fill(false);
  const shown: number[] = [];
  for (const i of rank) {
    const a = pos[i] as number[];
    const clash = shown.some((j) => {
      const b = pos[j] as number[];
      // A sliver of overlap reads fine; a number half under another doesn't.
      const si = size[i] as number;
      const sj = size[j] as number;
      const want = (si + sj) / 2 - Math.min(si, sj) * 0.2;
      return Math.hypot((b[0] as number) - (a[0] as number), (b[1] as number) - (a[1] as number)) < want;
    });
    if (clash) hidden[i] = true;
    else shown.push(i);
  }

  const out = new Map<number, BadgeFit>();
  panels.forEach((p, i) => {
    const s = size[i] as number;
    const scale = s / BADGE_BASE;
    const at = pos[i] as number[];
    out.set(p.id, {
      at: [at[0] as number, at[1] as number],
      size: s,
      scale,
      font: Math.max(BADGE_TEXT, MIN_TEXT_PX / scale),
      hidden: hidden[i] as boolean,
    });
  });
  return out;
}

/** The CSS transform that puts a base-size badge at `fit`, scaled by `scale` (defaults to the fit's own). */
export function badgeTransform(fit: BadgeFit, scale = fit.scale): string {
  return `translate(${fit.at[0] - BADGE_BASE / 2}px, ${fit.at[1] - BADGE_BASE / 2}px) scale(${scale})`;
}

/** One number over the drawing at rest: which position it labels, which panel it sits on and how it gets there. */
export interface BadgeSlot {
  /** Stable per position, so a number flies from panel to panel when the order changes. */
  readonly key: string;
  readonly label: number;
  /** The panel this position fills. */
  readonly id: number;
  /** The panel it's drawn on: its own, or the dragged number's while it previews a swap. */
  readonly spot: number;
  readonly dragged: boolean;
  /** Jump rather than fly (the drawing resized, reduced motion, or the number was just dropped where it lands). */
  readonly instant: boolean;
}

/**
 * The numbers at rest, keyed by position. While a number is dragged over another panel, that panel's number slides to
 * the dragged one's panel (previewing the swap). `snap` is the panel whose number lands without flying.
 */
export function badgeSlots(
  shown: readonly number[],
  drag: { readonly id: number; readonly target: number | null } | null,
  snap: number | null,
  still: boolean,
): BadgeSlot[] {
  return shown.map((id, k) => ({
    key: `k${k}`,
    label: k + 1,
    id,
    spot: drag && drag.target !== null && id === drag.target ? drag.id : id,
    dragged: drag?.id === id,
    instant: still || snap === id,
  }));
}

/**
 * Which badge snaps when a dragged number is dropped on panel `target`: after the swap the dragged number labels
 * `target`, and it is already there under the pointer (the ghost), so it must not fly in again from its old panel.
 */
export function dropSnap(drop: { readonly id: number; readonly target: number }): number {
  return drop.target;
}

/** `order` with panels `a` and `b` trading places. */
export function swapIds(order: readonly number[], a: number, b: number): number[] {
  return order.map((id) => (id === a ? b : id === b ? a : id));
}
