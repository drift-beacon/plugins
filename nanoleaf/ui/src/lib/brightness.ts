import { DRAFT_BRIGHTNESS } from "../../../shared/render.ts";
import type { Preview, Settings } from "../../../shared/types.ts";

/**
 * The brightness (%) the wall is driven at, as main decides it (director.ts `#targetBrightness`): tap to order's own
 * while it holds the wall (`preview` is a draft), else a slider being dragged (`dragged`), else a showing pin's own
 * unless a preview is over it, else Session brightness.
 */
export function wallBrightness(
  settings: Pick<Settings, "maxBrightness" | "pinnedBrightness">,
  pinned: boolean,
  preview: Preview["mode"] | null,
  dragged: number | null,
): number {
  if (preview === "draft") return DRAFT_BRIGHTNESS;
  if (dragged !== null) return dragged;
  return pinned && preview === null ? settings.pinnedBrightness : settings.maxBrightness;
}

/**
 * How strongly the drawing draws light at a wall brightness (%): a gentle curve (the square root), not the
 * percentage itself, so a dim wall still reads on screen: 100% is full, 25% half, 5% a faint fifth.
 */
export function drawnLevel(percent: number): number {
  return Math.round(Math.sqrt(Math.min(100, Math.max(0, percent)) / 100) * 1000) / 1000;
}
