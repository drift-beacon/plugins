import { resolveGesture, type GestureStep } from "../../../../shared/gestures.ts";
import type { TouchGesture } from "../../../../shared/types.ts";
import { showsZones, wallZones } from "../../lib/zones.ts";
import { followingOf, type NanoleafModel } from "../../model.ts";

/** What the wall reported: a touch (its `touch` event, -1 for a swipe), or the zone main acted in (`gestureZone`). */
export type Heard =
  | { readonly via: "touch"; readonly panel: number }
  | { readonly via: "zone"; readonly zoneId: string | null };

type JudgeInput = Pick<NanoleafModel, "zones" | "members" | "order" | "layout" | "settings" | "activities" | "sessions">;

/**
 * Whom a gesture's tile judges it for, from one report: on an unsplit wall the `touch` event and the member the wall
 * follows, as before zones; on a split wall the zone main says it acted in (`gestureZone`), null when it acted nowhere.
 * Undefined when this report isn't the one to judge by (the other one will come).
 */
export function tileFollowing(model: JudgeInput, heard: Heard): readonly string[] | null | undefined {
  const zones = wallZones(model);
  if (!showsZones(zones)) return heard.via === "touch" ? followingOf(model) : undefined;
  if (heard.via === "touch") return undefined;
  return zones.find((zone) => zone.id === heard.zoneId)?.following ?? null;
}

/** What the gesture did, judged as main judges it, for `following` (null: nothing). */
export function tileStep(model: JudgeInput, gesture: TouchGesture, following: readonly string[] | null): GestureStep | null {
  if (!following) return null;
  const resolved = resolveGesture(model.settings.gestureActions[gesture], model.activities, model.sessions, following);
  // Main starts nothing for nobody (no roster), so that does nothing here either.
  return resolved?.kind === "track" && resolved.members.length === 0 ? null : resolved;
}
