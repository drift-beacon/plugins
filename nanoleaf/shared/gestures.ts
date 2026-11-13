/**
 * Controls: what a gesture on the wall does right now. Main acts on it; the interface uses the same answer to show
 * whether a gesture it heard did something, and to what.
 */
import { pinnedFor, shownLive } from "./scene.ts";
import type { ActivityLike, GestureAction, ResolvedZone, SessionLike, TouchGesture } from "./types.ts";

/** Every gesture, in the order Controls lists them. */
export const GESTURES: readonly TouchGesture[] = Object.freeze([
  "tap",
  "double-tap",
  "swipe-up",
  "swipe-down",
  "swipe-left",
  "swipe-right",
]);

export const GESTURE_KINDS: readonly GestureAction["kind"][] = Object.freeze([
  "pause-resume",
  "stop-unpin",
  "start",
  "pin",
]);

/**
 * One thing to do to the workspace, as the SDK does it. A `track` is for `members`; a pause or pin is placed by
 * `placedBy` (null: nobody).
 */
export type GestureStep =
  | {
      readonly kind: "pause";
      readonly sessionId: string;
      readonly activityId: string;
      readonly placedBy: string | null;
    }
  | { readonly kind: "stop"; readonly sessionId: string; readonly activityId: string }
  | { readonly kind: "track"; readonly activityId: string; readonly members: readonly string[] }
  | { readonly kind: "pin"; readonly activityId: string; readonly placedBy: string | null }
  | { readonly kind: "unpin"; readonly activityId: string };

/**
 * What a gesture's action does now, for the member the wall follows (`following`: `actingFor` of its zone's member, a
 * list of one, empty with no roster), judged as the wall shows things (scene.ts): the newest live span they are in
 * first, then the workspace's pin. Null when it does nothing: an adaptive action with nothing shown or pinned, an
 * activity that is gone or archived, pinning what is already pinned, starting what they are already in.
 *
 * - Pause and stop act on the session the wall shows, for everyone in it.
 * - Resume (pause or resume with nothing shown, and a pin) starts the pinned activity for `following`, whoever
 *   pinned it.
 * - Start is for `following`. It does nothing when they are already in a running span of that activity; otherwise it
 *   starts one for them, which moves them out of the span they were in.
 * - A pause or pin is placed by the member followed (null only with no roster).
 */
export function resolveGesture(
  action: GestureAction | undefined,
  activities: readonly ActivityLike[],
  sessions: readonly SessionLike[],
  following: readonly string[],
): GestureStep | null {
  if (!action) return null;
  const placedBy = following[0] ?? null;
  if (action.kind === "pause-resume" || action.kind === "stop-unpin") {
    const live = shownLive(activities, sessions, following);
    if (live) {
      const at = { sessionId: live.session.id, activityId: live.activity.id };
      return action.kind === "pause-resume" ? { kind: "pause", ...at, placedBy } : { kind: "stop", ...at };
    }
    const pinned = pinnedFor(activities);
    if (!pinned) return null;
    if (action.kind === "stop-unpin") return { kind: "unpin", activityId: pinned.id };
    return { kind: "track", activityId: pinned.id, members: following };
  }
  const activity = activities.find((a) => a.id === action.activityId);
  if (!activity || activity.archived) return null;
  if (action.kind === "pin") {
    return activity.pinned ? null : { kind: "pin", activityId: activity.id, placedBy };
  }
  // Already in a running span of it: starting would only move them into a second.
  const together =
    following.length > 0 &&
    sessions.some(
      (s) =>
        s.status === "live" &&
        s.type === "span" &&
        s.activityId === activity.id &&
        following.every((id) => s.currentMemberIds.includes(id)),
    );
  return together ? null : { kind: "track", activityId: activity.id, members: following };
}

/**
 * The zone a touch acts in. `panelId` is the panel touched (a tap or double tap), the panel a swipe was placed on
 * (touch.ts `swipePanel`), or null when nothing places it.
 *
 * - A touch on a panel acts in that panel's zone.
 * - On a wall that isn't split (one zone has panels, or none has) a touch nothing places, or one on an id that is no
 *   light panel of the wall, acts in that zone as every touch did before zones: the zone with panels, else the first.
 * - On a split wall such a touch acts nowhere (null), so a swipe the touch stream didn't place does nothing.
 *
 * Taps and swipes follow the same rule: the controller names a tap's panel, and the touch stream a swipe's.
 */
export function touchZone<Z extends Pick<ResolvedZone, "panels">>(zones: readonly Z[], panelId: number | null): Z | null {
  if (panelId !== null) {
    const touched = zones.find((zone) => zone.panels.includes(panelId));
    if (touched) return touched;
  }
  let drawn: Z | null = null;
  for (const zone of zones) {
    if (zone.panels.length === 0) continue;
    if (drawn) return null;
    drawn = zone;
  }
  return drawn ?? zones[0] ?? null;
}
