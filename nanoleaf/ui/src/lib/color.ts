import { cssRgb, parseColor, WARM_WHITE } from "../../../shared/color.ts";
import type { Rgb } from "../../../shared/types.ts";

/**
 * An activity colour at an alpha, for tiles, washes and glows. Activity colours can be any CSS syntax, so this parses
 * them rather than appending a hex alpha suffix; anything unparseable falls back to `color-mix`.
 */
export function withAlpha(css: string, alpha: number): string {
  const rgb = parseColor(css);
  if (rgb) return cssRgb(rgb, alpha);
  return `color-mix(in srgb, ${css} ${Math.round(alpha * 100)}%, transparent)`;
}

/** The colour the editor draws with: what the wall shows, or warm white when nothing is showing. */
export function accentRgb(css: string | null): Rgb {
  return (css ? parseColor(css) : null) ?? WARM_WHITE;
}

/** Near-black or white text, whichever reads better on `rgb` (WCAG relative luminance). */
export function inkOn(rgb: Rgb): string {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return luminance > 0.36 ? "#0b0b0e" : "#ffffff";
}
