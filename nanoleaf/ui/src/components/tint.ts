import { cssRgb, parseColor } from "../../../shared/color.ts";
import type { Rgb } from "../../../shared/types.ts";

/** Zinc 400: what an activity colour falls back to when the app sends one we can't read. */
const FALLBACK: Rgb = [161, 161, 170];

/** Any CSS colour as channels (activity colours may be hex, rgb(), hsl() or a name). */
export function channels(css: string | null | undefined): Rgb {
  return (css ? parseColor(css) : null) ?? FALLBACK;
}

/** The colour at an alpha, whatever syntax it arrived in (the `${c}26` hex trick only works for #rrggbb). */
export function tint(css: string | null | undefined, alpha: number): string {
  return cssRgb(channels(css), alpha);
}

/** The sibling plugins' activity colour treatments: icon tile, card wash and glow shadow. */
export function activityStyle(css: string | null | undefined) {
  return {
    solid: tint(css, 1),
    tile: tint(css, 0.15),
    wash: `linear-gradient(135deg, ${tint(css, 0.15)}, transparent 70%)`,
    glow: `0 10px 30px -10px ${tint(css, 0.53)}`,
  };
}
