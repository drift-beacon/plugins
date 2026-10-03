/**
 * Colour helpers shared by main and the UI: parsing whatever CSS colour an activity carries, turning it into a
 * full-scale LED colour, mixing, and the one mapping from a light's level to what the wall shows (`deviceDrive`), which
 * main sends (`deviceRgb`) and the interface draws (`lightOpacity`).
 */
import type { PanelLight, Rgb } from "./types.ts";

/** The fallback LED colour: used for black, unparseable colours and the off scene, so a panel never "glows" black. */
export const WARM_WHITE: Rgb = Object.freeze([255, 214, 170] as const);

/**
 * Exponent from a light's level to the RGB drive we send. 1: the controller most likely maps RGB perceptually itself,
 * and a second curve here (2.2 before) crushed every dim light (the faint track, a pinned glow, a pulse's trough) to
 * black. Unverified on hardware (nanoleaf-api.md §11): if the wall turns out linear, raise this and nothing else.
 */
export const DEVICE_GAMMA = 1;
/** The least drive a lit panel gets (share of full scale), so its brightest channel is at least 8/255 and shows. */
export const MIN_DRIVE = 0.03;
/** The least a lit panel's brightest channel is sent at (`MIN_DRIVE` of full scale): a dim mixed colour still shows. */
const LIT_FLOOR = Math.round(255 * MIN_DRIVE);
/** From this brightest channel up, a channel the colour has never rounds away, so a dim panel keeps its hue. */
const HUE_FLOOR = 8;

/* ---- Parsing ---- */

/** Every CSS named colour, as `name hex` pairs (grey spellings included). Parsed on first use. */
const NAMED_SOURCE =
  "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 " +
  "black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 " +
  "cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc " +
  "crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 " +
  "darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f " +
  "darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f " +
  "darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 " +
  "deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 " +
  "floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 " +
  "goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 " +
  "indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 " +
  "lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff " +
  "lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 " +
  "lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 " +
  "lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff " +
  "maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db " +
  "mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc " +
  "mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 " +
  "navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 " +
  "orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee " +
  "palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd " +
  "powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 " +
  "saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d " +
  "silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa " +
  "springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 " +
  "turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32";

let named: Map<string, Rgb> | null = null;

function namedColors(): Map<string, Rgb> {
  if (named) return named;
  const map = new Map<string, Rgb>();
  const parts = NAMED_SOURCE.split(" ");
  for (let i = 0; i + 1 < parts.length; i += 2) map.set(parts[i]!, hexRgb(parts[i + 1]!));
  named = map;
  return map;
}

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const FUNCTION = /^(rgba?|hsla?)\((.*)\)$/;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/;
const HUE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/;

/** `rrggbb` or `rgb` (with or without an alpha digit pair or digit, which is dropped) → Rgb. */
function hexRgb(hex: string): Rgb {
  if (hex.length <= 4) {
    return [parseInt(hex[0]! + hex[0]!, 16), parseInt(hex[1]! + hex[1]!, 16), parseInt(hex[2]! + hex[2]!, 16)];
  }
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

/** A CSS `<number>` or `<percentage>`: percentages come back divided by 100 with `percent` set. */
function parseNumeric(token: string): { value: number; percent: boolean } | null {
  const percent = token.endsWith("%");
  const body = percent ? token.slice(0, -1) : token;
  if (!NUMBER.test(body)) return null;
  const value = Number(body);
  if (!Number.isFinite(value)) return null;
  return { value: percent ? value / 100 : value, percent };
}

/**
 * Splits a function's arguments in either syntax: legacy `a, b, c[, alpha]` or modern `a b c[ / alpha]`. Returns the
 * three colour arguments (the alpha is validated, then dropped) or null.
 */
function splitArgs(inner: string): readonly string[] | null {
  const body = inner.trim();
  if (body.includes(",")) {
    if (body.includes("/")) return null;
    const args = body.split(",").map((part) => part.trim());
    if (args.length !== 3 && args.length !== 4) return null;
    if (args.some((arg) => arg === "" || /\s/.test(arg))) return null;
    if (args.length === 4 && !parseNumeric(args[3]!)) return null;
    return args.slice(0, 3);
  }
  const slash = body.split("/");
  if (slash.length > 2) return null;
  const args = slash[0]!.trim().split(/\s+/);
  if (args.length !== 3 || args[0] === "") return null;
  if (slash.length === 2) {
    const alpha = slash[1]!.trim();
    if (/\s/.test(alpha) || !parseNumeric(alpha)) return null;
  }
  return args;
}

function channel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function parseRgbArgs(args: readonly string[]): Rgb | null {
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const n = parseNumeric(args[i]!);
    if (!n) return null;
    out[i] = channel(n.percent ? n.value * 255 : n.value);
  }
  return [out[0]!, out[1]!, out[2]!];
}

function parseHslArgs(args: readonly string[]): Rgb | null {
  const hue = HUE.exec(args[0]!);
  const s = parseNumeric(args[1]!);
  const l = parseNumeric(args[2]!);
  if (!hue || !s || !l) return null;
  const unit = hue[2];
  const raw = Number(hue[1]);
  const degrees =
    unit === "rad" ? (raw * 180) / Math.PI : unit === "grad" ? raw * 0.9 : unit === "turn" ? raw * 360 : raw;
  if (!Number.isFinite(degrees)) return null;
  // Saturation and lightness are percentages; a bare number (modern syntax) means the same percentage.
  const sat = Math.min(1, Math.max(0, s.percent ? s.value : s.value / 100));
  const light = Math.min(1, Math.max(0, l.percent ? l.value : l.value / 100));
  return hslToRgb(((degrees % 360) + 360) % 360, sat, light);
}

/** CSS Color 4 `hsl()` → sRGB. `h` in degrees [0, 360), `s` and `l` in [0, 1]. */
function hslToRgb(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return channel((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return [f(0), f(8), f(4)];
}

/**
 * Parses the colour an activity carries: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` and
 * `hsl()`/`hsla()` in comma or space syntax, and CSS named colours. Alpha is ignored. Anything else → null.
 */
export function parseColor(css: string): Rgb | null {
  if (typeof css !== "string") return null;
  const text = css.trim().toLowerCase();
  if (text === "") return null;
  if (text.startsWith("#")) return HEX.test(text) ? hexRgb(text.slice(1)) : null;
  const fn = FUNCTION.exec(text);
  if (fn) {
    const args = splitArgs(fn[2]!);
    if (!args) return null;
    return fn[1]!.startsWith("rgb") ? parseRgbArgs(args) : parseHslArgs(args);
  }
  return namedColors().get(text) ?? null;
}

/* ---- LED colour ---- */

/**
 * Scales a colour so its brightest channel is 255: the LEDs show the hue at full scale and brightness comes from the
 * level (and the device brightness). Black has no hue, so it becomes `WARM_WHITE`.
 */
export function toLedRgb(rgb: Rgb): Rgb {
  const max = Math.max(rgb[0], rgb[1], rgb[2]);
  if (!(max > 0)) return WARM_WHITE;
  if (max === 255) return rgb;
  const scale = 255 / max;
  return [channel(rgb[0] * scale), channel(rgb[1] * scale), channel(rgb[2] * scale)];
}

/** Linear blend from `a` (t = 0) to `b` (t = 1), rounded to whole channels; `t` is clamped to [0, 1]. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  if (!(t > 0)) return a;
  if (t >= 1) return b;
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * CSS for a colour, for the UI: `rgb(r g b)`, or `rgb(r g b / alpha)` with an alpha (0–1). Works for any activity
 * colour once parsed, where `${hex}26`-style suffixes would only work for hex.
 */
export function cssRgb(rgb: Rgb, alpha?: number): string {
  const body = `${channel(rgb[0])} ${channel(rgb[1])} ${channel(rgb[2])}`;
  if (alpha === undefined) return `rgb(${body})`;
  const a = Math.min(1, Math.max(0, alpha));
  return `rgb(${body} / ${Math.round(a * 1000) / 1000})`;
}

/**
 * A light's level (0–1) → the share of full scale it is driven at: the device curve, lifted so any lit level drives
 * at least `MIN_DRIVE`. Lifting rather than clamping keeps dim levels apart (a pulse's trough still moves). 0 stays 0.
 */
export function deviceDrive(level: number): number {
  if (!(level > 0)) return 0;
  const curve = level >= 1 ? 1 : DEVICE_GAMMA === 1 ? level : level ** DEVICE_GAMMA;
  return MIN_DRIVE + (1 - MIN_DRIVE) * curve;
}

/** The opacity to draw a light at so the interface looks like the wall: its drive, as the eye sees it. */
export function lightOpacity(level: number): number {
  const drive = deviceDrive(level);
  return DEVICE_GAMMA === 1 ? drive : drive ** (1 / DEVICE_GAMMA);
}

/** A minor channel at `scale`, never above `top`, and kept at 1 rather than lost once `top` is `HUE_FLOOR` or more. */
function minorChannel(value: number, scale: number, top: number): number {
  if (!(value > 0)) return 0;
  const scaled = Math.min(top, Math.round(value * scale));
  return scaled === 0 && top >= HUE_FLOOR ? 1 : scaled;
}

/**
 * What main sends for a panel: the colour at `deviceDrive(level)`, quantised so the hue survives. The brightest
 * channel is rounded (at least `LIT_FLOOR` when lit, which a full-scale colour gets from `MIN_DRIVE` anyway; a colour
 * mixed mid-crossfade is dimmer) and the others follow it from their unrounded ratios.
 */
export function deviceRgb(light: PanelLight): Rgb {
  const drive = deviceDrive(light.level);
  const rgb = light.rgb;
  const max = Math.max(rgb[0], rgb[1], rgb[2]);
  if (drive === 0 || !(max > 0)) return [0, 0, 0];
  const top = Math.max(LIT_FLOOR, channel(max * drive));
  const scale = top / max;
  return [minorChannel(rgb[0], scale, top), minorChannel(rgb[1], scale, top), minorChannel(rgb[2], scale, top)];
}
