import { lightOpacity } from "../../../shared/color.ts";
import { EDGE_BOOST, fillingPosition, sceneLight, TRACK } from "../../../shared/render.ts";
import type { Scene } from "../../../shared/types.ts";

/*
 * The Now card's bar, lit by the wall's own maths: `sceneLight` from render.ts at the drawing's clock (epoch ms, as
 * useLights passes it), so a pinned pulse peaks on the bar exactly when it peaks on the drawing and the wall, however
 * long ago the bar mounted.
 */

/** The filling segment's breath on the bar: a floor well above the wall's 7% boost, so it reads at 6 px. */
const BREATH_LOW = 0.72;

/** How full each segment is (0–1): panel k holds clamp(f·n − k, 0, 1), or every panel is full without a goal. */
export function barFill(scene: Scene, n: number): number[] {
  const f = scene.progress ? Math.min(Math.max(scene.progress.fraction, 0), 1) : 1;
  return Array.from({ length: Math.max(0, n) }, (_, k) => Math.min(Math.max(f * n - k, 0), 1));
}

/** Whether the bar changes over time on its own: a pinned pulse, or a live goal part-way with its panel breathing. */
export function barMoves(scene: Scene, n: number): boolean {
  if (scene.kind === "control") return true;
  if (scene.kind === "pinned") return scene.style === "pulse";
  return scene.kind === "live" && fillingPosition(scene.progress, n) !== null;
}

/**
 * Each segment's brightness at `t`: the light the wall gives that panel at full fill (the scene's level, and the
 * pulse wave at its place in the order) drawn as the drawing draws it (`lightOpacity`), times the filling panel's
 * breath in step with the wall's. How full a segment is shows as its width (`barFill`), not here.
 */
export function barBrightness(scene: Scene, n: number, t: number, reduced = false): number[] {
  if (n <= 0 || scene.kind === "off") return Array.from({ length: Math.max(0, n) }, () => 0);
  const opts = { reducedMotion: reduced };
  const full: Scene = { ...scene, progress: null, track: false };
  const edge = reduced ? null : fillingPosition(scene.kind === "live" ? scene.progress : null, n);
  const breath = edge === null ? 1 : BREATH_LOW + (1 - BREATH_LOW) * edgeWave(scene, edge, n, t);
  return Array.from({ length: n }, (_, k) => {
    const level = lightOpacity(sceneLight(full, k, n, t, opts).level);
    return k === edge ? level * breath : level;
  });
}

/**
 * The wall's breathing wave (0–1) for the filling panel at `t`, read back from `sceneLight`: its level is the panel's
 * fill plus `EDGE_BOOST` × the wave (capped at 1, as on the wall).
 */
function edgeWave(scene: Scene, k: number, n: number, t: number): number {
  const amount = barFill(scene, n)[k] ?? 0;
  const rest = scene.track ? TRACK + (1 - TRACK) * amount : amount;
  const wave = (sceneLight(scene, k, n, t).level - rest) / EDGE_BOOST;
  return Math.min(Math.max(wave, 0), 1);
}

/** The pinned pulse at the first panel, 0–1 with its floor, for a status dot that pulses with the wall. */
export function pulseWave(scene: Scene, t: number, reduced = false): number {
  return sceneLight({ ...scene, progress: null, track: false, level: 1 }, 0, 1, t, { reducedMotion: reduced }).level;
}
