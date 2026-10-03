/**
 * The one animation engine. Main renders frames at 10 Hz for the wall and the UI at 60 fps for its drawing, from the
 * same `RenderState`, so the preview moves exactly like the panels. Everything here is pure and deterministic given
 * (state, order, t): time is passed in, nothing is random, and a frame allocates only its result map, one light per
 * panel, a few objects per layer and the odd mixed colour.
 */
import { mix, WARM_WHITE } from "./color.ts";
import { effectLight, prepareEffect, type PreparedEffect, sameEffect } from "./effects.ts";
import { OFF_SCENE } from "./scene.ts";
import type {
  Alert,
  GoalMark,
  GoalProgress,
  Moment,
  PanelLight,
  Preview,
  PreviewFade,
  RenderState,
  Rgb,
  Scene,
} from "./types.ts";

/* ---- Constants (DESIGN.md "render.ts") ---- */

/** Level of unfilled panels when the faint track is on. */
export const TRACK = 0.08;
/** Crossfade duration per panel when something else shows (a new key, activity or colour). */
export const FADE_MS = 900;
/** Crossfade delay per position along the order, capped at `STAGGER_MAX_MS`. */
export const STAGGER_MS = 45;
export const STAGGER_MAX_MS = 540;
/** Pinned pulse: period, floor (share of the peak) and phase spread across the order (share of a period). */
export const PULSE_MS = 4000;
export const PULSE_LOW = 0.2;
export const PULSE_SPREAD = 0.3;
/** The filling panel's breathing: period and extra level at its peak. */
export const EDGE_MS = 2600;
export const EDGE_BOOST = 0.07;
/** Length of the goal-met wave along the order. */
export const SHIMMER_MS = 1800;
/** A preview fades in over the scene for this long, and back out to it when it ends. */
export const PREVIEW_FADE_MS = 200;
/** Reduced motion: one short fade replaces the staggered crossfade, and a pulse holds steady at this share. */
export const REDUCED_FADE_MS = 150;
export const REDUCED_PULSE = 0.6;
/** Identify: listed panels blink twice during this window; the others dim to `IDENTIFY_DIM`. */
export const IDENTIFY_BLINK_MS = 600;
export const IDENTIFY_DIM = 0.06;
/** The same scene shown differently (style, level, track, progress, goal, a leap) fades this long, unstaggered. */
export const ADJUST_FADE_MS = 400;
/** A duration goal's progress step this big (share of the goal) fades; smaller ones (a live goal's creep) don't. */
export const LEAP = 0.01;
/**
 * A schedule alert: the whole wall swells `ALERT_BEATS` times, each `ALERT_BEAT_MS` long, from `ALERT_LOW` to full and
 * back, all panels together. It fades in over the scene for `ALERT_IN_MS` and back to it for `ALERT_OUT_MS` after
 * the last beat. The first peak is half a beat in, so it is noticed within a second.
 */
export const ALERT_BEAT_MS = 900;
export const ALERT_BEATS = 2;
export const ALERT_LOW = 0.06;
export const ALERT_IN_MS = 250;
export const ALERT_OUT_MS = 500;
/** An alert's beats, then the whole of it with its fade-out. */
export const ALERT_BEATS_MS = ALERT_BEATS * ALERT_BEAT_MS;
export const ALERT_MS = ALERT_BEATS_MS + ALERT_OUT_MS;
/** Alerts that arrive while one runs wait their turn; beyond this many, a new one is dropped. */
export const ALERT_QUEUE = 3;
/** Reduced motion: an alert holds this level instead of swelling. */
export const REDUCED_ALERT = 0.6;
/** How many interrupted fades (or replaced previews) deep a state keeps; older ones only pile up when changes do. */
const MAX_DEPTH = 8;
/** How many activities' last goal fractions a state remembers, so a goal met across a scene change still shimmers. */
const GOAL_MEMORY = 8;
/** A goal-met wave's reach: where its bump is smaller than this it adds nothing. */
const WAVE_TAIL = 0.02;

/** Frame options. `reducedMotion` is for the UI only: the wall always gets the full motion. */
export interface RenderOptions {
  readonly reducedMotion?: boolean;
}

const WHITE: Rgb = [255, 255, 255];
const TAU = 2 * Math.PI;

function clamp01(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0;
}

/** The crossfade curve: slow out of the old scene, slow into the new one. */
export function easeInOutCubic(x: number): number {
  const v = clamp01(x);
  return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2;
}

/* ---- Equality (value comparison, so an unchanged scene or preview keeps the state object) ---- */

function sameRgb(a: Rgb | null, b: Rgb | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function sameProgress(a: GoalProgress | null, b: GoalProgress | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ga = a.goal.type === "duration" ? a.goal.seconds : a.goal.count;
  const gb = b.goal.type === "duration" ? b.goal.seconds : b.goal.count;
  return (
    a.goal.type === b.goal.type &&
    ga === gb &&
    a.period === b.period &&
    a.current === b.current &&
    a.target === b.target &&
    a.fraction === b.fraction
  );
}

/** Whether two scenes would render the same (every field compared by value). */
export function sameScene(a: Scene, b: Scene): boolean {
  return (
    a === b ||
    (a.kind === b.kind &&
      a.key === b.key &&
      a.activityId === b.activityId &&
      a.cssColor === b.cssColor &&
      a.level === b.level &&
      a.style === b.style &&
      a.track === b.track &&
      sameRgb(a.rgb, b.rgb) &&
      sameProgress(a.progress, b.progress) &&
      (a.kind !== "control" || (b.kind === "control" && a.holder === b.holder && sameEffect(a.effect, b.effect))))
  );
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Whether two previews are the same request (mode, colour, panels or fraction). */
export function samePreview(a: Preview | null, b: Preview | null): boolean {
  if (a === b) return true;
  if (!a || !b || !sameRgb(a.rgb, b.rgb)) return false;
  if (a.mode === "identify") return b.mode === "identify" && sameIds(a.panelIds, b.panelIds);
  if (a.mode === "fill") return b.mode === "fill" && a.fraction === b.fraction;
  return b.mode === a.mode;
}

/* ---- State ---- */

/** A state showing `scene` straight away: no crossfade, no moments, no preview; it remembers the scene's goal. */
export function initialRenderState(scene: Scene, now: number): RenderState {
  return {
    scene,
    previous: null,
    changedAt: now,
    moments: [],
    preview: null,
    previewAt: now,
    from: null,
    adjust: false,
    previewFadeAt: now,
    previewFrom: null,
    goals: remember(NO_GOALS, scene),
  };
}

const NO_GOALS: readonly GoalMark[] = Object.freeze([]);

/**
 * `state` as the wall should show it when the plugin has just taken the wall (from dark): its scene and preview fade in
 * as if from the off scene, and its moments (a goal just met) and goal memory carry on, which a fresh state would lose.
 */
export function fromDark(state: RenderState, now: number): RenderState {
  return {
    ...state,
    previous: OFF_SCENE,
    changedAt: now,
    from: null,
    adjust: false,
    previewFadeAt: now,
    previewFrom: null,
  };
}

/** The last goal fraction `goals` holds for an activity, if any. */
function recall(goals: readonly GoalMark[] | undefined, activityId: string): number | undefined {
  if (goals) for (const mark of goals) if (mark.activityId === activityId) return mark.fraction;
  return undefined;
}

/**
 * The goal fraction `scene`'s activity had before `scene` showed, when it is known: the old scene's if it showed the
 * same activity; for a session that has just appeared with a count goal, the count without it (a live span counts as
 * one, progress.ts), even if the wall was idle before; else the fraction last seen for that activity.
 */
function fractionBefore(old: Scene, scene: Scene, goals: readonly GoalMark[]): number | undefined {
  const progress = scene.progress;
  if (!progress || !scene.activityId) return undefined;
  if (old.activityId === scene.activityId && old.progress) return old.progress.fraction;
  if (scene.kind === "live" && old.key !== scene.key && progress.goal.type === "count" && progress.target > 0) {
    return (progress.current - 1) / progress.target;
  }
  return recall(goals, scene.activityId);
}

/** `goals` with the scene's goal fraction first (the same array when nothing changed), at most `GOAL_MEMORY` long. */
function remember(goals: readonly GoalMark[], scene: Scene): readonly GoalMark[] {
  const activityId = scene.activityId;
  const progress = scene.progress;
  if (!activityId || !progress) return goals;
  const first = goals[0];
  if (first && first.activityId === activityId && first.fraction === progress.fraction) return goals;
  const out: GoalMark[] = [{ activityId, fraction: progress.fraction }];
  for (const mark of goals) if (mark.activityId !== activityId && out.length < GOAL_MEMORY) out.push(mark);
  return out;
}

const NONE = 0;
const SWAP = 1;
const ADJUST = 2;
const IN_PLACE = 3;

function sameGoal(a: GoalProgress, b: GoalProgress): boolean {
  const ga = a.goal.type === "duration" ? a.goal.seconds : a.goal.count;
  const gb = b.goal.type === "duration" ? b.goal.seconds : b.goal.count;
  return a.goal.type === b.goal.type && ga === gb && a.period === b.period && a.target === b.target;
}

/**
 * How a scene change shows: something else to show (key, activity or colour) swaps with the full staggered fade; the
 * same thing shown differently (style, level, track, progress shown or not, the goal, a leap in progress) adjusts with
 * a short one; a small progress step (a live duration goal's per-second creep) updates in place. A controller's
 * effect swaps in and out like any scene, and a new effect within the same hold (pulse to shuffle) adjusts.
 */
function changeOf(a: Scene, b: Scene): number {
  if (sameScene(a, b)) return NONE;
  if (a.kind === "control" || b.kind === "control") return a.kind === b.kind && a.key === b.key ? ADJUST : SWAP;
  if (a.key !== b.key || a.activityId !== b.activityId || !sameRgb(a.rgb, b.rgb)) return SWAP;
  if (a.kind !== b.kind || a.style !== b.style || a.level !== b.level || a.track !== b.track) return ADJUST;
  const p = a.progress;
  const q = b.progress;
  if (!p || !q) return p === q ? IN_PLACE : ADJUST;
  if (!sameGoal(p, q)) return ADJUST;
  const step = clamp01(q.fraction) - clamp01(p.fraction);
  if (step === 0) return IN_PLACE;
  // A count only moves in whole steps (a session started, ended or logged), and a fill that starts from nothing (or
  // goes back to it) changes more than its size (the breathing starts, a pin's bare track goes): always worth a fade.
  if (q.goal.type === "count" || !(p.fraction > 0) || !(q.fraction > 0)) return ADJUST;
  return Math.abs(step) >= LEAP ? ADJUST : IN_PLACE;
}

/** The longest a state's running fade can last (reduced motion only shortens it): until then it may still be drawn. */
function fadeSpan(state: RenderState): number {
  return state.adjust === true ? ADJUST_FADE_MS : FADE_MS + STAGGER_MAX_MS;
}

/** Whether the state's crossfade may still be running at `t`. */
function fading(state: RenderState, t: number): boolean {
  return state.previous !== null && t - state.changedAt <= fadeSpan(state);
}

function waving(moments: readonly Moment[], t: number): boolean {
  for (const m of moments) if (m.kind === "goal-met" && t >= m.at && t - m.at <= SHIMMER_MS) return true;
  return false;
}

/**
 * A fade's from-side as it stands at `now`: levels whose own fade has finished lose what they faded from, and the
 * chain is cut at `MAX_DEPTH`. Returns `state` itself when nothing goes.
 */
function trimmed(state: RenderState, now: number, depth: number): RenderState {
  const from = state.from ?? null;
  if (!fading(state, now)) return state.previous || from ? { ...state, previous: null, from: null } : state;
  if (!from) return state;
  if (depth >= MAX_DEPTH) return { ...state, from: null };
  const kept = trimmed(from, now, depth + 1);
  return kept === from ? state : { ...state, from: kept };
}

/** The scene side of `state` to fade from: what it still needs at `now`, no preview, its moments unless `bare`. */
function fadeSource(state: RenderState, now: number, bare: boolean): RenderState {
  const source: RenderState = {
    scene: state.scene,
    previous: state.previous,
    changedAt: state.changedAt,
    moments: bare ? NO_MOMENTS : state.moments,
    preview: null,
    previewAt: state.previewAt,
    from: state.from ?? null,
    adjust: state.adjust === true,
  };
  return trimmed(source, now, 1);
}

const NO_MOMENTS: readonly Moment[] = Object.freeze([]);

/**
 * Feeds the latest scene in (see `changeOf`). A swap or an adjustment fades from what is lit right now: the old scene
 * when it had settled, else the whole old state (a fade still running, a goal-met wave), which keeps moving underneath
 * as the new fade takes over, so a change that lands mid-fade never jumps. A goal fraction going from under 1 to 1 or
 * more adds a goal-met moment, live or pinned, also across a scene change (see `fractionBefore`: a count goal is met
 * by starting its final session). Finished fades, moments and preview fades are dropped. Returns `state` itself when
 * nothing changed.
 */
export function advance(state: RenderState, scene: Scene, now: number): RenderState {
  const old = state.scene;
  const change = changeOf(old, scene);
  const next = change === NONE ? old : scene;
  let previous = state.previous;
  let changedAt = state.changedAt;
  let from = state.from ?? null;
  let adjust = state.adjust === true;
  let moments = state.moments;
  const goals = state.goals ?? NO_GOALS;

  if (change === SWAP || change === ADJUST) {
    // An adjustment keeps the scene's goal-met wave on top; a swap fades it out with the old scene instead.
    const bare = change === ADJUST;
    from = fading(state, now) || (!bare && waving(moments, now)) ? fadeSource(state, now, bare) : null;
    previous = old;
    changedAt = now;
    adjust = bare;
    if (!bare && moments.some((m) => m.kind === "goal-met")) moments = moments.filter((m) => m.kind !== "goal-met");
  }
  if (change !== NONE && scene.kind !== "off" && scene.progress && scene.progress.fraction >= 1) {
    const before = fractionBefore(old, scene, goals);
    if (before !== undefined && before < 1) moments = [...moments, { kind: "goal-met", at: now }];
  }
  if (moments.some((m) => now - m.at > SHIMMER_MS)) moments = moments.filter((m) => now - m.at <= SHIMMER_MS);
  if (previous && now - changedAt > (adjust ? ADJUST_FADE_MS : FADE_MS + STAGGER_MAX_MS)) {
    previous = null;
    from = null;
  } else if (from) {
    // What it fades from sheds its own finished fades as time goes on.
    from = trimmed(from, now, 1);
  }
  const fadeAt = state.previewFadeAt ?? state.previewAt;
  const previewFrom = state.previewFrom && now - fadeAt < PREVIEW_FADE_MS ? state.previewFrom : null;
  const nextGoals = remember(goals, next);
  const alerts = liveAlerts(state.alerts, now);

  if (
    alerts === (state.alerts ?? NO_ALERTS) &&
    next === old &&
    previous === state.previous &&
    changedAt === state.changedAt &&
    from === (state.from ?? null) &&
    adjust === (state.adjust === true) &&
    moments === state.moments &&
    previewFrom === (state.previewFrom ?? null) &&
    nextGoals === goals
  ) {
    return state;
  }
  return { ...state, scene: next, previous, changedAt, from, adjust, moments, previewFrom, goals: nextGoals, alerts };
}

/* ---- Schedule alerts ---- */

const NO_ALERTS: readonly Alert[] = Object.freeze([]);

/** `alerts` without the ones that are over at `now` (the same array when none is). */
function liveAlerts(alerts: readonly Alert[] | undefined, now: number): readonly Alert[] {
  if (!alerts) return NO_ALERTS;
  return alerts.some((a) => now - a.at > ALERT_MS) ? alerts.filter((a) => now - a.at <= ALERT_MS) : alerts;
}

/**
 * Adds a schedule alert in `rgb`. It starts now, or, while another runs, as that one's beats end: the two crossfade,
 * so alerts that fire together play one after the other and nothing jumps. With `ALERT_QUEUE` already there it is
 * dropped (`state` is returned).
 */
export function withAlert(state: RenderState, rgb: Rgb, now: number): RenderState {
  const alerts = liveAlerts(state.alerts, now);
  if (alerts.length >= ALERT_QUEUE) return state;
  const last = alerts[alerts.length - 1];
  const at = last ? Math.max(now, last.at + ALERT_BEATS_MS) : now;
  return { ...state, alerts: [...alerts, { at, rgb }] };
}

/** Whether a schedule alert is running or waiting its turn at `t`. */
export function alerting(state: RenderState, t: number): boolean {
  const alerts = state.alerts;
  if (alerts) for (const a of alerts) if (t - a.at <= ALERT_MS) return true;
  return false;
}

/** An alert at one time: its colour, level and how much of it shows over what is underneath. */
interface AlertPlan {
  readonly rgb: Rgb;
  readonly level: number;
  readonly w: number;
}

/** The alerts showing at `t`, oldest first; null when none does. */
function alertPlans(alerts: readonly Alert[] | undefined, t: number, reduced: boolean): AlertPlan[] | null {
  if (!alerts) return null;
  let plans: AlertPlan[] | null = null;
  for (const a of alerts) {
    const dt = t - a.at;
    if (dt <= 0 || dt >= ALERT_MS) continue;
    const beating = dt < ALERT_BEATS_MS;
    const swell = beating ? 0.5 - 0.5 * Math.cos((TAU * dt) / ALERT_BEAT_MS) : 0;
    const w = beating ? easeInOutCubic(dt / ALERT_IN_MS) : 1 - easeInOutCubic((dt - ALERT_BEATS_MS) / ALERT_OUT_MS);
    (plans ??= []).push({ rgb: a.rgb, level: reduced ? REDUCED_ALERT : ALERT_LOW + (1 - ALERT_LOW) * swell, w });
  }
  return plans;
}

/** The preview layer of `state` as it stands, to fade from; its own fade-from only while that fade still runs. */
function previewLayer(state: RenderState, now: number): PreviewFade | null {
  const fadeAt = state.previewFadeAt ?? state.previewAt;
  const running = now - fadeAt < PREVIEW_FADE_MS;
  const below = running ? (state.previewFrom ?? null) : null;
  if (!state.preview && !below) return null;
  const from = below ? limitPreview(below, MAX_DEPTH - 2) : null;
  return { preview: state.preview, previewAt: state.previewAt, fadeAt, from };
}

/** `layer` with at most `depth` layers under it. */
function limitPreview(layer: PreviewFade, depth: number): PreviewFade {
  const from = layer.from;
  if (!from) return layer;
  if (depth <= 0) return { ...layer, from: null };
  const kept = limitPreview(from, depth - 1);
  return kept === from ? layer : { ...layer, from: kept };
}

/**
 * Sets (or clears, with null) the interface preview. The same request again (a lease renewal) returns `state`, and a
 * new fill fraction updates in place (scrubbing never re-fades). Anything else fades over `PREVIEW_FADE_MS` from what
 * the preview layer shows right now: a new preview from the scene or from the one it replaces, a new colour from the
 * old one, a cleared one back to the scene, so nothing flashes. The layer faded from keeps its blinks and sweep but
 * stops fading in. `previewAt`, the blink and sweep clock, restarts only when a preview starts, its mode changes or
 * identify gets different panels (a new colour keeps a sweep's phase).
 */
export function withPreview(state: RenderState, preview: Preview | null, now: number): RenderState {
  const old = state.preview;
  if (samePreview(old, preview)) return state;
  const restart =
    !old ||
    !preview ||
    old.mode !== preview.mode ||
    (old.mode === "identify" && preview.mode === "identify" && !sameIds(old.panelIds, preview.panelIds));
  if (!restart && sameRgb(old.rgb, preview.rgb)) return { ...state, preview };
  return {
    ...state,
    preview,
    previewAt: restart && preview ? now : state.previewAt,
    previewFadeAt: now,
    previewFrom: previewLayer(state, now),
  };
}

/* ---- Per-panel light for a scene ---- */

const OFF = 0;
const LIVE = 1;
const GLOW = 2;
const PULSE = 3;
const STEADY = 4;
const CONTROL = 5;

/** Everything about a scene at time t that doesn't depend on the panel, computed once per frame. */
interface Prepared {
  readonly mode: number;
  readonly rgb: Rgb;
  readonly peak: number;
  /** Whether the scene shows progress; without it every panel is full. */
  readonly hasProgress: boolean;
  /** min(fraction, 1)·n: how many panels' worth is filled. */
  readonly filled: number;
  readonly trackFloor: boolean;
  /** Position of the breathing panel, or -1. */
  readonly edgeK: number;
  readonly edge: number;
  readonly phase: number;
  readonly spread: number;
  /** A controller's effect on its own clock (mode `CONTROL`): it gives each panel its colour as well as its level. */
  readonly effect: PreparedEffect | null;
}

function prepare(scene: Scene, n: number, t: number, reduced: boolean): Prepared {
  const progress = scene.progress;
  const mode =
    scene.kind === "control"
      ? CONTROL
      : scene.kind === "live"
        ? LIVE
        : scene.kind === "pinned"
          ? scene.style === "pulse"
            ? reduced
              ? STEADY
              : PULSE
            : GLOW
          : OFF;
  const fraction = progress ? progress.fraction : 0;
  const filled = clamp01(fraction) * n;
  const breathing = mode === LIVE && !reduced && progress !== null && fraction > 0 && fraction < 1;
  // A pinned goal with nothing done yet shows its track even with the track off, so a pin never holds the wall dark.
  const bare = mode !== LIVE && !(fraction > 0);
  return {
    mode,
    rgb: mode === OFF ? WARM_WHITE : (scene.rgb ?? WARM_WHITE),
    peak: scene.level,
    hasProgress: progress !== null,
    filled,
    trackFloor: progress !== null && (scene.track || bare),
    edgeK: breathing ? Math.floor(filled) : -1,
    edge: breathing ? EDGE_BOOST * (0.5 - 0.5 * Math.cos((TAU * t) / EDGE_MS)) : 0,
    phase: t / PULSE_MS,
    spread: PULSE_SPREAD / Math.max(n - 1, 1),
    effect: scene.kind === "control" ? prepareEffect(scene.effect, n, t, reduced) : null,
  };
}

/** The scene's own colour and level at position `k`, written into `out`. */
function lightAt(p: Prepared, k: number, out: Slot): void {
  if (p.effect) {
    const light = effectLight(p.effect, k);
    out.rgb = light.rgb;
    out.level = light.level;
  } else {
    out.rgb = p.rgb;
    out.level = levelAt(p, k);
  }
}

function levelAt(p: Prepared, k: number): number {
  if (p.mode === OFF) return 0;
  let fill = 1;
  if (p.hasProgress) {
    const amount = clamp01(p.filled - k);
    fill = p.trackFloor ? TRACK + (1 - TRACK) * amount : amount;
  }
  switch (p.mode) {
    case LIVE:
      return k === p.edgeK ? Math.min(1, fill + p.edge) : fill;
    case GLOW:
      return p.peak * fill;
    case STEADY:
      return p.peak * fill * REDUCED_PULSE;
    default: {
      const w = PULSE_LOW + (1 - PULSE_LOW) * (0.5 - 0.5 * Math.cos(TAU * (p.phase - p.spread * k)));
      return p.peak * fill * w;
    }
  }
}

/** The scene's own light for position `k` (0-based) of `n` at time `t`, before crossfades, moments and previews. */
export function sceneLight(scene: Scene, k: number, n: number, t: number, opts?: RenderOptions): PanelLight {
  const p = prepare(scene, n, t, opts?.reducedMotion === true);
  return p.effect ? effectLight(p.effect, k) : { rgb: p.rgb, level: levelAt(p, k) };
}

/** The 0-based position of the panel that is filling (the one that breathes), or null when none is part-way. */
export function fillingPosition(progress: GoalProgress | null, n: number): number | null {
  if (!progress || n <= 0) return null;
  const f = progress.fraction;
  if (!(f > 0 && f < 1)) return null;
  return Math.min(n - 1, Math.floor(f * n));
}

/* ---- Previews ---- */

const IDENTIFY = 1;
const FILL = 2;
const ORDER = 3;

/** Length of one order sweep over `n` panels. */
export function orderSweepMs(n: number): number {
  return Math.min(4200, Math.max(1200, 700 + 110 * n));
}

/* ---- Frames ---- */

/** A light being worked out: each layer of a frame owns one, so a frame allocates a handful, not one per panel. */
interface Slot {
  rgb: Rgb;
  level: number;
  /** The scene's colour even where it is dark, crossfading with it: a preview without its own colour takes it. */
  tint: Rgb;
}

/**
 * A state's scene side ready to draw at one time: the scene, its goal-met waves and, while its crossfade runs, what it
 * fades from (the interrupted earlier state, still animating, or else the previous scene), both drawn at the same time.
 */
interface SceneLayer {
  readonly cur: Prepared;
  readonly waves: readonly number[] | null;
  readonly from: SceneLayer | null;
  readonly prev: Prepared | null;
  readonly since: number;
  readonly fadeMs: number;
  readonly stagger: number;
  readonly out: Slot;
  /** Scratch for the side it fades from. */
  readonly side: Slot;
}

/**
 * The goal-met waves running at `t`: each one's centre position along the order. A wave starts and ends three
 * positions off the order, so it arrives and leaves without a visible step.
 */
function wavesAt(moments: readonly Moment[], n: number, t: number): number[] | null {
  let waves: number[] | null = null;
  for (const m of moments) {
    if (m.kind !== "goal-met") continue;
    const dt = t - m.at;
    if (dt < 0 || dt > SHIMMER_MS) continue;
    (waves ??= []).push((dt / SHIMMER_MS) * (n + 5) - 3);
  }
  return waves;
}

function sceneLayer(state: RenderState, n: number, t: number, reduced: boolean, depth: number): SceneLayer {
  const adjust = state.adjust === true;
  const full = adjust ? ADJUST_FADE_MS : FADE_MS;
  const fadeMs = reduced ? Math.min(full, REDUCED_FADE_MS) : full;
  const stagger = reduced || adjust ? 0 : STAGGER_MS;
  const since = t - state.changedAt;
  let from: SceneLayer | null = null;
  let prev: Prepared | null = null;
  if (state.previous && since < fadeMs + (stagger === 0 ? 0 : Math.min((n - 1) * stagger, STAGGER_MAX_MS))) {
    if (state.from && depth < MAX_DEPTH) from = sceneLayer(state.from, n, t, reduced, depth + 1);
    else prev = prepare(state.previous, n, t, reduced);
  }
  return {
    cur: prepare(state.scene, n, t, reduced),
    waves: reduced ? null : wavesAt(state.moments, n, t),
    from,
    prev,
    since,
    fadeMs,
    stagger,
    out: { rgb: WARM_WHITE, level: 0, tint: WARM_WHITE },
    side: { rgb: WARM_WHITE, level: 0, tint: WARM_WHITE },
  };
}

/** The scene light at position `k`: the crossfade (staggered along the order), then goal-met waves on top. */
function sceneAt(layer: SceneLayer, k: number): Slot {
  const side = layer.side;
  lightAt(layer.cur, k, side);
  let level = side.level;
  let rgb = side.rgb;
  let tint = rgb;
  if (layer.from || layer.prev) {
    const delay = Math.min(k * layer.stagger, STAGGER_MAX_MS);
    const u = easeInOutCubic((layer.since - delay) / layer.fadeMs);
    if (u < 1) {
      let a: number;
      let aRgb: Rgb;
      let aTint: Rgb;
      if (layer.from) {
        const below = sceneAt(layer.from, k);
        a = below.level;
        aRgb = below.rgb;
        aTint = below.tint;
      } else {
        lightAt(layer.prev as Prepared, k, side);
        a = side.level;
        aRgb = side.rgb;
        aTint = side.rgb;
      }
      // A dark side has no colour to fade from (or to): keep the lit side's, so nothing passes through grey.
      rgb = a === 0 ? rgb : level === 0 ? aRgb : mix(aRgb, rgb, u);
      tint = mix(aTint, tint, u);
      level = a + (level - a) * u;
    }
  }
  if (layer.waves) {
    for (const s of layer.waves) {
      const bump = Math.exp(-((k - s) * (k - s)) / 2);
      // Its faint tail is left out: on a dark panel it would light it (the wall lifts any light to a visible floor).
      if (bump < WAVE_TAIL) continue;
      rgb = mix(rgb, WHITE, 0.5 * bump);
      level += (1 - level) * bump;
    }
  }
  const out = layer.out;
  out.rgb = rgb;
  out.level = level;
  out.tint = tint;
  return out;
}

/**
 * A preview layer ready to draw at one time: its preview's per-mode constants (mode 0: none, the scene shows through),
 * how far its fade has got, and the layer it fades from (frozen when it was replaced), or the scene when none.
 */
interface PreviewPlan {
  readonly mode: number;
  /** The preview's own colour; null takes the scene's (`Slot.tint`). */
  readonly rgb: Rgb | null;
  readonly ids: readonly number[];
  readonly blink: number;
  readonly filled: number;
  readonly sweep: number;
  readonly w: number;
  readonly from: PreviewPlan | null;
  readonly out: Slot;
}

/**
 * `at` is the time the layer's fade weight is read at: `t` for the top layer, and for one it replaced the moment it
 * was replaced, so a fade it hadn't finished never carries on upwards underneath. Its blinks and sweep keep `t`.
 */
function previewPlan(
  preview: Preview | null,
  previewAt: number,
  fadeAt: number,
  below: PreviewFade | null,
  n: number,
  t: number,
  at: number,
  reduced: boolean,
  depth: number,
): PreviewPlan {
  const w = clamp01((at - fadeAt) / PREVIEW_FADE_MS);
  const from =
    w < 1 && below && depth < MAX_DEPTH
      ? previewPlan(below.preview, below.previewAt, below.fadeAt, below.from, n, t, fadeAt, reduced, depth + 1)
      : null;
  let mode = 0;
  let ids: readonly number[] = NO_IDS;
  let blink = 1;
  let filled = 0;
  let sweep = 0;
  const dt = t - previewAt;
  if (preview?.mode === "identify") {
    mode = IDENTIFY;
    ids = preview.panelIds;
    if (!reduced && dt >= 0 && dt < IDENTIFY_BLINK_MS) blink = 0.35 + 0.65 * Math.abs(Math.cos((Math.PI * dt) / 300));
  } else if (preview?.mode === "fill") {
    mode = FILL;
    filled = clamp01(preview.fraction) * n;
  } else if (preview) {
    mode = ORDER;
    const period = orderSweepMs(n);
    sweep = ((((dt % period) + period) % period) / period) * (n + 2);
  }
  const rgb = preview?.rgb ?? null;
  return { mode, rgb, ids, blink, filled, sweep, w, from, out: { rgb: WARM_WHITE, level: 0, tint: WARM_WHITE } };
}

const NO_IDS: readonly number[] = Object.freeze([]);

/** The light at position `k` (panel `id`) with the preview layers over the scene's light there. */
function previewAt(plan: PreviewPlan, k: number, id: number, scene: Slot): Slot {
  let a = scene.level;
  let aRgb = scene.rgb;
  if (plan.from) {
    const below = previewAt(plan.from, k, id, scene);
    a = below.level;
    aRgb = below.rgb;
  }
  let b = scene.level;
  let bRgb = scene.rgb;
  if (plan.mode !== 0) {
    bRgb = plan.rgb ?? scene.tint;
    if (plan.mode === IDENTIFY) b = plan.ids.includes(id) ? plan.blink : IDENTIFY_DIM;
    else if (plan.mode === FILL) b = TRACK + (1 - TRACK) * clamp01(plan.filled - k);
    else b = 0.1 + 0.9 * clamp01(plan.sweep - k);
  }
  const w = plan.w;
  const out = plan.out;
  if (w >= 1) {
    out.level = b;
    out.rgb = bRgb;
  } else if (w <= 0) {
    out.level = a;
    out.rgb = aRgb;
  } else {
    out.rgb = a === 0 ? bRgb : b === 0 ? aRgb : mix(aRgb, bRgb, w);
    out.level = a + (b - a) * w;
  }
  return out;
}

/**
 * Every ordered panel's light at time `t`: the scene (crossfading from what was lit when it changed, staggered along
 * the order), goal-met waves on top, then the preview layers fading over it, then schedule alerts over everything,
 * the same on every panel. Keys are the panel ids in `order`
 * (n = order.length); callers treat layout panels missing from the map as dark.
 */
export function renderFrame(
  state: RenderState,
  order: readonly number[],
  t: number,
  opts?: RenderOptions,
): Map<number, PanelLight> {
  const out = new Map<number, PanelLight>();
  const n = order.length;
  if (n === 0) return out;
  const reduced = opts?.reducedMotion === true;
  const scene = sceneLayer(state, n, t, reduced, 0);
  const fadeAt = state.previewFadeAt ?? state.previewAt;
  const below = state.previewFrom ?? null;
  const showing = state.preview !== null || (below !== null && t - fadeAt < PREVIEW_FADE_MS);
  const preview = showing ? previewPlan(state.preview, state.previewAt, fadeAt, below, n, t, t, reduced, 0) : null;
  const alerts = alertPlans(state.alerts, t, reduced);
  for (let k = 0; k < n; k++) {
    const id = order[k] as number;
    let light = sceneAt(scene, k);
    if (preview) light = previewAt(preview, k, id, light);
    let rgb = light.rgb;
    let level = light.level;
    if (alerts) {
      for (const alert of alerts) {
        // A dark panel has no colour to fade from: it takes the alert's.
        rgb = level === 0 ? alert.rgb : mix(rgb, alert.rgb, alert.w);
        level += (alert.level - level) * alert.w;
      }
    }
    out.set(id, { rgb, level });
  }
  return out;
}

/**
 * Whether frames change over time on their own: a crossfade, moment or schedule alert is running, a preview is showing
 * or fading, the scene is a pinned pulse, or it is live and part-way to its goal (the filling panel breathes). Lets
 * callers idle otherwise.
 */
export function isAnimating(state: RenderState, t: number): boolean {
  if (state.preview) return true;
  if (state.previewFrom && t - (state.previewFadeAt ?? state.previewAt) < PREVIEW_FADE_MS) return true;
  if (fading(state, t) || alerting(state, t)) return true;
  for (const m of state.moments) if (t - m.at <= SHIMMER_MS) return true;
  const scene = state.scene;
  if (scene.kind === "control") return true;
  if (scene.kind === "pinned" && scene.style === "pulse") return true;
  if (scene.kind === "live" && scene.progress) {
    const f = scene.progress.fraction;
    if (f > 0 && f < 1) return true;
  }
  return false;
}
