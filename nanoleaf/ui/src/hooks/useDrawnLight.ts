import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ZoneScene } from "../../../shared/scene.ts";
import type { PlacedLayout, Preview, ResolvedZone, Rgb } from "../../../shared/types.ts";
import type { ZoneStates } from "../../../shared/zone-render.ts";
import { type ZoneFill, zoneFills } from "../../../shared/zones.ts";
import { stepZoneStates, type ZonePreview, zoneLevels } from "../lib/zones.ts";
import { useModel } from "../model.ts";
import type { LightSource, LightSourceRef } from "./useLights.ts";
import { useZoneScenes } from "./useZones.ts";

/** A brightness slider being dragged: its value, and the colour its preview shows in (null: what shows). */
export interface BrightnessDrag {
  readonly value: number;
  readonly rgb: Rgb | null;
}

// One interface per iframe: the sliders and the drawings share this, wherever the layout puts them.
let drag: BrightnessDrag | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Tap to order holds the wall: the brightness sliders leave it alone (no preview, no override) until it ends. */
let drafting = false;
const draftListeners = new Set<() => void>();
const subscribeDrafting = (listener: () => void) => {
  draftListeners.add(listener);
  return () => draftListeners.delete(listener);
};

/** Says tap to order started or ended. */
export function setDrafting(next: boolean): void {
  if (drafting === next) return;
  drafting = next;
  for (const listener of draftListeners) listener();
}

/** Whether tap to order holds the wall now. */
export function useDrafting(): boolean {
  return useSyncExternalStore(
    subscribeDrafting,
    () => drafting,
    () => false,
  );
}

/** Says a brightness slider is being dragged (null once it lets go), for the drawings to preview it too. */
export function setBrightnessDrag(next: BrightnessDrag | null): void {
  if (drag?.value === next?.value && drag?.rgb === next?.rgb) return;
  drag = next;
  for (const listener of listeners) listener();
}

/** No preview from the drawing itself. */
export const NO_ZONE_PREVIEW: ZonePreview = Object.freeze({ preview: null, zoneId: null });

/**
 * How a drawing lights the wall: the light source its loop draws (useLights), each zone's render state stepped with
 * its scene and the preview over it (a dragged brightness slider's full fill over every zone, else `local`, the
 * drawing's own), and the `level` to draw light at, from the brightness the wall is driven at. `placed` is the wall as
 * the drawing places it (its fills follow that); `only` draws one zone with the others dark (tap to order on a split
 * wall). With one zone this is the drawing as it was before zones.
 */
export function useWallLight(
  placed: PlacedLayout | null,
  local: ZonePreview,
  only: string | null = null,
): {
  readonly source: LightSourceRef;
  readonly preview: Preview | null;
  readonly level: number;
  readonly zones: readonly ResolvedZone[];
  readonly scenes: readonly ZoneScene[];
  readonly fills: readonly ZoneFill[];
} {
  const { settings } = useModel();
  const { zones, scenes } = useZoneScenes();
  const dragged = useSyncExternalStore(
    subscribe,
    () => drag,
    () => null,
  );
  const dragging = dragged !== null;
  const rgb = dragged?.rgb ?? null;
  // Its own object only when the drag starts or changes colour: the value alone changes the level, not the preview.
  const fill = useMemo<ZonePreview | null>(
    () => (dragging ? { preview: { mode: "fill", fraction: 1, rgb }, zoneId: null } : null),
    [dragging, rgb],
  );
  const shown = fill ?? local;
  const levels = zoneLevels(settings, zones, scenes, shown, dragged?.value ?? null);
  const fills = useMemo(() => (placed ? zoneFills(zones, placed.panels) : []), [zones, placed]);

  const ref = useRef<LightSource | null>(null);
  const last = useRef<Preview | null>(shown.preview);
  const states = useRef<ZoneStates | null>(null);
  if (ref.current === null) {
    states.current = stepZoneStates(null, scenes, shown, false, Date.now());
    ref.current = { states: states.current, fills, scales: levels.scales, only };
  }
  // Kept by value: a new map each render would make the loop redraw a still wall.
  const scalesKey = levels.scales ? [...levels.scales].join(";") : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the map's value
  const scales = useMemo(() => levels.scales, [scalesKey]);
  const { preview, zoneId } = shown;
  useLayoutEffect(() => {
    const fresh = preview !== last.current;
    last.current = preview;
    states.current = stepZoneStates(states.current, scenes, { preview, zoneId }, fresh, Date.now());
    const old = ref.current;
    if (old && old.states === states.current && old.fills === fills && old.scales === scales && old.only === only) return;
    ref.current = { states: states.current, fills, scales, only };
  }, [scenes, preview, zoneId, fills, scales, only]);
  return { source: ref as LightSourceRef, preview, level: levels.level, zones, scenes, fills };
}
