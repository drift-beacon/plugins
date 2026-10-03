/**
 * Activity colours are the user's choice, so text on them can't be a fixed white: these pick near-black or white by
 * WCAG luminance, on the colour as it's actually painted. A sticker isn't one colour: it fades toward the shell's
 * plastic under a thin black overlay, and its title sits on the faded part, so the ink is chosen there (`sticker`).
 */

export type Rgb = readonly [number, number, number];

/** `#rgb`, `#rrggbb` (alpha ignored) or `rgb(r g b)` / `rgb(r, g, b)`; null for anything else. */
export function parseColor(css: string): Rgb | null {
  const text = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join("") : hex.slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
  }
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(text);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map((c) => Math.min(c, 255)) as unknown as Rgb;
  return null;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(rgb: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const INK_DARK = "#18181b";
export const INK_LIGHT = "#ffffff";
const DARK: Rgb = [24, 24, 27];
const LIGHT: Rgb = [255, 255, 255];

/** `color` with `shade` of black over it, as the sticker's overlay paints it. */
export function shaded(rgb: Rgb, shade: number): Rgb {
  return rgb.map((c) => Math.round(c * (1 - shade))) as unknown as Rgb;
}

/** The ink that reads better on `css` darkened by `shade`; white when the colour can't be parsed. */
export function inkOn(css: string, shade = 0): string {
  const rgb = parseColor(css);
  if (!rgb) return INK_LIGHT;
  const painted = shaded(rgb, shade);
  return contrast(painted, DARK) > contrast(painted, LIGHT) ? INK_DARK : INK_LIGHT;
}

/** The cartridge shell's plastic (deck.css `.cp-shell`), which a sticker's colour fades toward. */
export const SHELL = "#45423e";
const SHELL_RGB: Rgb = [0x45, 0x42, 0x3e];
/** The black over a sticker, so the label reads as printed rather than glowing: one value for shelf and scene. */
export const STICKER_SHADE = 0.2;
/**
 * How much of the activity colour is left at the sticker's faded corner. The fade is kept this narrow so the ink
 * chosen for the title still reads at the solid corner, where the category line is.
 */
export const STICKER_FADE = 0.8;
/** How far along the fade the title sits, on both stickers: in the faded half, short of the corner. */
const TITLE_AT = 0.75;

/** `share` of `a` over `b`, as `color-mix(in srgb, a share, b)` paints it. */
export function mixed(a: Rgb, b: Rgb, share: number): Rgb {
  return a.map((c, i) => Math.round(c * share + b[i] * (1 - share))) as unknown as Rgb;
}

/** What a sticker in `css` paints `at` along its fade (0 the solid corner, 1 the faded one), overlay included. */
export function stickerPaint(css: string, at: number): Rgb | null {
  const rgb = parseColor(css);
  return rgb ? shaded(mixed(rgb, SHELL_RGB, 1 - (1 - STICKER_FADE) * at), STICKER_SHADE) : null;
}

export interface Sticker {
  /** The two ends of its gradient: opaque, so what's painted doesn't depend on what's behind it. */
  readonly from: string;
  readonly to: string;
  /** The ink that reads better where the title sits; white when the colour can't be parsed. */
  readonly ink: string;
}

/** A sticker in an activity's colour: its gradient and the ink for the text on it. */
export function sticker(css: string): Sticker {
  const painted = stickerPaint(css, TITLE_AT);
  const ink = painted && contrast(painted, DARK) > contrast(painted, LIGHT) ? INK_DARK : INK_LIGHT;
  return { from: css, to: `color-mix(in srgb, ${css} ${STICKER_FADE * 100}%, ${SHELL})`, ink };
}
