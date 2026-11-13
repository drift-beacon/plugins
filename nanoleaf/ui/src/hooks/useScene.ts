import { useMemo } from "react";
import type { Scene } from "../../../shared/types.ts";
import { wallScene } from "../lib/zones.ts";
import { useModel } from "../model.ts";
import { useZoneScenes } from "./useZones.ts";

/**
 * What the wall shows, decided from the model exactly as main decides it (shared `decideZoneScenes`, then
 * `outputScene` of the drawn zones, what main's published `output` speaks for; lib/zones.ts `wallScene`): with one
 * zone, the scene for the member the wall follows; on a split wall, the drawn zone showing the newest running session,
 * else the pin. A zone with no panels yet never decides it. Near a goal period's edge the fill can
 * differ from the wall's, since this device and the hub count goal progress in their own time zones. Recomputed every
 * second and whenever the model changes. It gets every activity, archived ones included, as main does: a live
 * session of an archived activity still glows (decideScene ignores only archived pins). While another plugin holds
 * the wall, its effect is the scene, as on the wall. The clock ticks; it never animates.
 */
export function useScene(): Scene {
  const { sessions } = useModel();
  const { zones, scenes } = useZoneScenes();
  return useMemo(() => wallScene(zones, scenes, sessions), [zones, scenes, sessions]);
}
