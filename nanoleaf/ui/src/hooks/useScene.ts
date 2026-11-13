import { useMemo } from "react";
import { decideScene } from "../../../shared/scene.ts";
import type { Scene } from "../../../shared/types.ts";
import { followingOf, useModel } from "../model.ts";
import { useNow } from "./useNow.ts";

/** A live duration goal moves with the clock, so the scene is re-decided every second. */
const TICK_MS = 1000;

/**
 * What the wall should show, decided from the model exactly as main decides it (shared `decideScene`), for the member
 * the wall follows. Near a goal period's edge the fill can differ from the wall's, since this
 * device and the hub count goal progress in their own time zones. Recomputed every second and whenever the model
 * changes. It gets every activity, archived ones included, as main does: a live session of an archived activity still
 * glows (decideScene ignores only archived pins). While another plugin holds the wall, its effect is the scene, as on
 * the wall. The clock ticks; it never animates.
 */
export function useScene(): Scene {
  const { activities, sessions, settings, control, members, zones } = useModel();
  const now = useNow(TICK_MS);
  const following = useMemo(() => followingOf({ members, zones }), [members, zones]);
  return useMemo(
    () => decideScene({ activities, sessions, following, settings, now, control }),
    [activities, sessions, following, settings, now, control],
  );
}
