import { useMemo } from "react";
import type { ZoneScene } from "../../../shared/scene.ts";
import type { ResolvedZone } from "../../../shared/types.ts";
import { lightPanelIds, wallZones, zoneScenes } from "../lib/zones.ts";
import { useModel } from "../model.ts";
import { useNow } from "./useNow.ts";

/** A live duration goal moves with the clock, so scenes are re-decided every second. */
const TICK_MS = 1000;

/** The zones as they stand on this wall now (`resolveZones`, as main resolves them), kept while nothing changes. */
export function useWallZones(): readonly ResolvedZone[] {
  const { zones, members, order, layout } = useModel();
  const panelIds = useMemo(() => lightPanelIds(layout), [layout]);
  return useMemo(() => wallZones({ zones, members, order, layout }, panelIds), [zones, members, order, layout, panelIds]);
}

/** The zones and what each shows now, decided as main decides it, every second and whenever the model changes. */
export function useZoneScenes(): { readonly zones: readonly ResolvedZone[]; readonly scenes: readonly ZoneScene[] } {
  const model = useModel();
  const { activities, sessions, settings, control } = model;
  const zones = useWallZones();
  const now = useNow(TICK_MS);
  const scenes = useMemo(
    () => zoneScenes({ activities, sessions, settings, control }, zones, now),
    [activities, sessions, settings, control, zones, now],
  );
  return { zones, scenes };
}
