/**
 * The effects a controller can put on the wall while it holds the lock (`takeControl`): a slow `pulse` of its palette,
 * a `shuffle` where every panel changes colour on its own, and a one-shot `reveal` that locks the wall to one colour.
 * Pure and deterministic like render.ts: time is the effect's own (`t − startedAt`), and what looks random is a hash
 * of the effect's id, the panel's position and a step, so main and the UI draw the same thing.
 */
import { mix, parseColor, toLedRgb } from "./color.ts";
import type { ControlEffect, ControlEffectType, PanelLight, Rgb } from "./types.ts";

/* ---- Constants (DESIGN.md "effects.ts") ---- */

export const EFFECT_TYPES: readonly ControlEffectType[] = Object.freeze(["pulse", "shuffle", "reveal"]);
/** A palette holds at most this many colours; a cube has six faces. */
export const MAX_COLORS = 12;
export const PERIOD_RANGE = Object.freeze({ min: 400, max: 10_000 });
/** `periodMs` when the controller gives none. */
export const DEFAULT_PERIOD_MS: Readonly<Record<ControlEffectType, number>> = Object.freeze({
  pulse: 4000,
  shuffle: 900,
  reveal: 600,
});
/** Pulse: the trough, as a share of full. Its wave spans one whole period along the order (a pin's spans 0.3). */
export const CONTROL_PULSE_LOW = 0.2;
/** Shuffle: the trough, each panel's step as a share of the period, and the crossfade into its next colour. */
export const SHUFFLE_LOW = 0.35;
export const SHUFFLE_STEP_MIN = 0.6;
export const SHUFFLE_STEP_SPAN = 0.8;
export const SHUFFLE_FADE_MS = 200;
/** Reveal: panels lock one after another until `REVEAL_LOCK_MS`, the wall swells, then holds. */
export const REVEAL_LOCK_GAP_MS = 120;
export const REVEAL_LOCK_MS = 1200;
export const REVEAL_LOCK_FADE_MS = 150;
export const REVEAL_BEAT_MS = 450;
export const REVEAL_BEATS = 2;
export const REVEAL_BEAT_LOW = 0.25;
export const REVEAL_HOLD_MS = 600;
/** A reveal from its first frame to the end of its hold: how long its lease lasts. */
export const REVEAL_MS = REVEAL_LOCK_MS + REVEAL_BEATS * REVEAL_BEAT_MS + REVEAL_HOLD_MS;
/** Reduced motion (the UI only): looping effects hold this level. */
export const REDUCED_EFFECT = 0.6;

const TAU = 2 * Math.PI;

/* ---- Reading a request ---- */

/** An effect as a controller asks for it (`takeControl`'s `effect`), colours as CSS strings. */
export interface EffectRequest {
  readonly type: string;
  readonly colors: readonly string[];
  readonly periodMs?: number;
  readonly color?: string;
}

/** An accepted effect before it has an id and a start: what two requests are compared by. */
export type EffectSpec = Omit<ControlEffect, "id" | "startedAt">;

/**
 * Checks an effect request and turns its colours into LED colours. Colours that don't parse are dropped; with none
 * left, more than `MAX_COLORS`, or a `reveal` without a colour to end on, the answer is what is wrong with it.
 */
export function readEffect(request: EffectRequest): EffectSpec | string {
  const type = EFFECT_TYPES.find((known) => known === request.type);
  if (!type) return `effect.type must be one of ${EFFECT_TYPES.join(", ")}`;
  const colors: Rgb[] = [];
  for (const css of request.colors) {
    const rgb = typeof css === "string" ? parseColor(css) : null;
    if (rgb) colors.push(toLedRgb(rgb));
  }
  if (colors.length === 0) return "effect.colors needs at least one CSS colour";
  if (colors.length > MAX_COLORS) return `effect.colors takes at most ${MAX_COLORS} colours`;
  let color: Rgb | null = null;
  if (type === "reveal") {
    const rgb = typeof request.color === "string" ? parseColor(request.color) : null;
    if (!rgb) return "A reveal needs effect.color, the CSS colour it ends on";
    color = toLedRgb(rgb);
  }
  const period = request.periodMs;
  const periodMs =
    typeof period === "number" && Number.isFinite(period)
      ? Math.min(PERIOD_RANGE.max, Math.max(PERIOD_RANGE.min, Math.round(period)))
      : DEFAULT_PERIOD_MS[type];
  return { type, colors, periodMs, color };
}

function sameColor(a: Rgb | null, b: Rgb | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Whether two effects would look the same apart from when they started: the same type, palette, tempo and winner. */
export function sameSpec(a: EffectSpec, b: EffectSpec): boolean {
  if (a.type !== b.type || a.periodMs !== b.periodMs || a.colors.length !== b.colors.length) return false;
  if (!sameColor(a.color, b.color)) return false;
  for (let i = 0; i < a.colors.length; i++) if (!sameColor(a.colors[i] ?? null, b.colors[i] ?? null)) return false;
  return true;
}

/** Whether two effects are the same one: the same intent, started at the same time. */
export function sameEffect(a: ControlEffect, b: ControlEffect): boolean {
  return a === b || (a.id === b.id && a.startedAt === b.startedAt && sameSpec(a, b));
}

/** How long an effect runs before it ends by itself, or null for one that loops until its lease does. */
export function effectDuration(type: ControlEffectType): number | null {
  return type === "reveal" ? REVEAL_MS : null;
}

/* ---- Hashing ---- */

/** A 32-bit seed from an effect id (FNV-1a). */
export function effectSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A float in [0, 1) from a seed and two integers, the same every time. */
function unit(seed: number, a: number, b: number): number {
  let h = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Salts for `unit`'s second integer, well away from step numbers. */
const STEP_LENGTH = -11;
const STEP_OFFSET = -12;
const PULSE_PHASE = -13;
const ALTERNATE = -14;

/* ---- Per-panel light ---- */

/** An effect at one time, with everything that doesn't depend on the panel worked out once per frame. */
export interface PreparedEffect {
  readonly effect: ControlEffect;
  readonly seed: number;
  /** Time since the effect started, never negative (a clock a little behind draws its first frame). */
  readonly dt: number;
  readonly n: number;
  readonly reduced: boolean;
}

export function prepareEffect(effect: ControlEffect, n: number, t: number, reduced: boolean): PreparedEffect {
  return { effect, seed: effectSeed(effect.id), dt: Math.max(0, t - effect.startedAt), n, reduced };
}

/** The palette index panel `k` shows during its step `s`: free on even steps, and on odd ones unlike both neighbours. */
function colorIndex(seed: number, k: number, s: number, m: number): number {
  if (m <= 1) return 0;
  if (m === 2) return (((s + (unit(seed, k, ALTERNATE) < 0.5 ? 0 : 1)) % 2) + 2) % 2;
  if (s % 2 === 0) return Math.floor(unit(seed, k, s) * m);
  const before = Math.floor(unit(seed, k, s - 1) * m);
  const after = Math.floor(unit(seed, k, s + 1) * m);
  const taken = before === after ? 1 : 2;
  let pick = Math.floor(unit(seed, k, s) * (m - taken));
  for (let i = 0; i < m; i++) {
    if (i === before || i === after) continue;
    if (pick === 0) return i;
    pick--;
  }
  return 0;
}

/** Panel `k`'s colour in a shuffle at `dt`: its step's colour, crossfading from the one before as the step starts. */
function shuffleColor(p: PreparedEffect, k: number, periodMs: number): Rgb {
  const colors = p.effect.colors;
  const m = colors.length;
  const length = periodMs * (SHUFFLE_STEP_MIN + SHUFFLE_STEP_SPAN * unit(p.seed, k, STEP_LENGTH));
  const at = p.dt + unit(p.seed, k, STEP_OFFSET) * length;
  const s = Math.floor(at / length);
  const rgb = colors[colorIndex(p.seed, k, s, m)] as Rgb;
  const into = at - s * length;
  if (m === 1 || s === 0 || into >= SHUFFLE_FADE_MS) return rgb;
  return mix(colors[colorIndex(p.seed, k, s - 1, m)] as Rgb, rgb, into / SHUFFLE_FADE_MS);
}

/** Panel `k`'s level in a shuffle: a quick pulse, every panel at its own point of it. */
function shuffleLevel(p: PreparedEffect, k: number, periodMs: number): number {
  const phase = p.dt / periodMs + unit(p.seed, k, PULSE_PHASE);
  return SHUFFLE_LOW + (1 - SHUFFLE_LOW) * (0.5 - 0.5 * Math.cos(TAU * phase));
}

/** When panel `k` of `n` locks to a reveal's colour: one after another along the order, all by `REVEAL_LOCK_MS`. */
export function revealLockAt(k: number, n: number): number {
  const gap = Math.min(REVEAL_LOCK_GAP_MS, (REVEAL_LOCK_MS - REVEAL_LOCK_FADE_MS) / Math.max(n - 1, 1));
  return k * gap;
}

/** The light an effect gives position `k` (0-based) of its `n` panels. */
export function effectLight(p: PreparedEffect, k: number): PanelLight {
  const effect = p.effect;
  const colors = effect.colors;
  const m = colors.length;
  const spread = colors[k % m] as Rgb;

  if (effect.type === "reveal") {
    const winner = effect.color ?? spread;
    if (p.reduced) return { rgb: winner, level: 1 };
    const since = p.dt - revealLockAt(k, p.n);
    if (since < 0) return { rgb: shuffleColor(p, k, effect.periodMs), level: shuffleLevel(p, k, effect.periodMs) };
    if (since < REVEAL_LOCK_FADE_MS) {
      const u = since / REVEAL_LOCK_FADE_MS;
      const level = shuffleLevel(p, k, effect.periodMs);
      return { rgb: mix(shuffleColor(p, k, effect.periodMs), winner, u), level: level + (1 - level) * u };
    }
    const beat = p.dt - REVEAL_LOCK_MS;
    if (beat <= 0 || beat >= REVEAL_BEATS * REVEAL_BEAT_MS) return { rgb: winner, level: 1 };
    const swell = 0.5 + 0.5 * Math.cos((TAU * beat) / REVEAL_BEAT_MS);
    return { rgb: winner, level: REVEAL_BEAT_LOW + (1 - REVEAL_BEAT_LOW) * swell };
  }

  if (p.reduced) return { rgb: spread, level: REDUCED_EFFECT };
  if (effect.type === "shuffle") {
    return { rgb: shuffleColor(p, k, effect.periodMs), level: shuffleLevel(p, k, effect.periodMs) };
  }
  const phase = p.dt / effect.periodMs - k / Math.max(p.n, 1);
  return { rgb: spread, level: CONTROL_PULSE_LOW + (1 - CONTROL_PULSE_LOW) * (0.5 - 0.5 * Math.cos(TAU * phase)) };
}
