/**
 * The wall drawn zone by zone: one render state per zone, each advanced with the engine's own `advance` and drawn with
 * its own `renderFrame` over the zone's fill (zones.ts `zoneFills`), merged into one frame. Zones never share a state,
 * so a zone that appears, goes or changes leaves the others' lights exactly as they were. With one zone everything
 * here is the engine as it was before zones, light for light.
 */
import { advance, fromDark, initialRenderState, renderFrame } from "./render.ts";
import type { ZoneScene } from "./scene.ts";
import type { PanelLight, RenderState, Scene, Settings } from "./types.ts";
import type { ZoneFill } from "./zones.ts";

/** Each zone's render state, by zone id, in the zones' order. */
export type ZoneStates = ReadonlyMap<string, RenderState>;

/**
 * Feeds each zone its latest scene (`advance`), in the order of `scenes`; a zone missing from `scenes` is dropped.
 * A zone with no state yet starts showing its scene straight away when no zone had one (the wall's first frame, as
 * `initialRenderState`), and otherwise fades in from dark (`fromDark`), so a zone added beside lit ones arrives
 * smoothly. Returns `states` itself when nothing changed.
 */
export function advanceZones(states: ZoneStates | null, scenes: readonly ZoneScene[], now: number): ZoneStates {
  const fresh = !states || states.size === 0;
  const before = states ? [...states.keys()] : [];
  let same = !fresh && before.length === scenes.length;
  const next = new Map<string, RenderState>();
  scenes.forEach(({ id, scene }, i) => {
    const old = states?.get(id);
    const state = old
      ? advance(old, scene, now)
      : fresh
        ? initialRenderState(scene, now)
        : fromDark(initialRenderState(scene, now), now);
    if (state !== old || before[i] !== id) same = false;
    next.set(id, state);
  });
  return same && states ? states : next;
}

/**
 * Applies `update` to each zone's state (`withPreview`, `withAlert`, `fromDark`…): the callback gets the zone's id, so
 * it can leave a zone as it is by returning its state. Returns `states` itself when no state changed.
 */
export function updateZones(
  states: ZoneStates,
  update: (state: RenderState, id: string) => RenderState,
): ZoneStates {
  let changed = false;
  const next = new Map<string, RenderState>();
  for (const [id, state] of states) {
    const updated = update(state, id);
    if (updated !== state) changed = true;
    next.set(id, updated);
  }
  return changed ? next : states;
}

/** Frame options for the whole wall. */
export interface ZoneFrameOptions {
  /** For the UI only, as in `renderFrame`. */
  readonly reducedMotion?: boolean;
  /** Each zone's level scale (`zonesBrightness`); a zone left out is drawn at 1. */
  readonly scales?: ReadonlyMap<string, number> | null;
  /** Draw only this zone, the others dark (tap to order holding the wall for one zone). */
  readonly only?: string | null;
}

/**
 * Every drawn panel's light at time `t`: each zone's state drawn by `renderFrame` over its own fill order and line
 * spans, its effect positions read along the whole wall (`ZoneFill.offset`), its levels scaled by its brightness
 * scale, merged in the wall's combined order. A zone with no panels or no state draws nothing: its panels, like any
 * missing from the map, are dark.
 */
export function renderZones(
  states: ZoneStates,
  fills: readonly ZoneFill[],
  t: number,
  opts?: ZoneFrameOptions,
): Map<number, PanelLight> {
  const out = new Map<number, PanelLight>();
  let length = 0;
  for (const fill of fills) length += fill.order.length;
  const only = opts?.only ?? null;
  for (const fill of fills) {
    const state = states.get(fill.id);
    if (!state || fill.order.length === 0 || (only !== null && fill.id !== only)) continue;
    const frame = renderFrame(state, fill.order, t, {
      reducedMotion: opts?.reducedMotion,
      spans: fill.spans,
      along: { offset: fill.offset, length },
    });
    const scale = opts?.scales?.get(fill.id) ?? 1;
    for (const [id, light] of frame) out.set(id, scale === 1 ? light : { rgb: light.rgb, level: light.level * scale });
  }
  return out;
}

/* ---- Brightness ---- */

/** What a zone shows, for the wall's brightness. */
export interface ZoneShowing {
  readonly id: string;
  readonly scene: Scene;
  /** An interface preview shows in this zone (identify, a fill, Play order). */
  readonly preview?: boolean;
  /** A schedule alert plays or waits in this zone. */
  readonly alert?: boolean;
}

/** The brightness the controller should be at, and what each zone needs. */
export interface WallBrightness {
  /** The target: the highest any zone needs, else Session brightness. */
  readonly brightness: number;
  /** By zone id: the brightness the zone needs, or null for one showing nothing that needs none. */
  readonly needs: ReadonlyMap<string, number | null>;
}

/**
 * The wall's one brightness to aim for, and each zone's need. A zone needs Session brightness (`maxBrightness`) for a
 * running session, another plugin's effect or a preview, and Pinned brightness for a pin; a zone showing nothing needs
 * nothing, unless a schedule alert plays there (Session brightness, as an idle wall's alert had). The target is the
 * highest need, else Session brightness. With one zone it is the brightness the wall had before zones. Tap to order's
 * `DRAFT_BRIGHTNESS` and a slider's short-lived override are the caller's: they replace the target, and draw at scale 1.
 * Turn needs into level scales with `zoneScales`, against the brightness the controller is actually at.
 */
export function zonesBrightness(settings: Settings, zones: readonly ZoneShowing[]): WallBrightness {
  const needs = new Map<string, number | null>();
  let brightness: number | null = null;
  for (const zone of zones) {
    let need: number | null = null;
    if (zone.preview) need = settings.maxBrightness;
    else if (zone.scene.kind === "pinned") need = settings.pinnedBrightness;
    else if (zone.scene.kind !== "off" || zone.alert) need = settings.maxBrightness;
    needs.set(zone.id, need);
    if (need !== null && (brightness === null || need > brightness)) brightness = need;
  }
  return { brightness: brightness ?? settings.maxBrightness, needs };
}

/**
 * Each zone's level scale at the brightness the controller is at now (`applied`, which lags the target while a write
 * is on its way): its need over that, at most 1, and exactly 1 when they are equal or it needs nothing. Worked out
 * against what is applied, so a zone keeps its look while the controller's brightness catches up.
 */
export function zoneScales(needs: ReadonlyMap<string, number | null>, applied: number): Map<string, number> {
  const scales = new Map<string, number>();
  for (const [id, need] of needs) {
    scales.set(id, need === null || !(applied > 0) || need >= applied ? 1 : need / applied);
  }
  return scales;
}
