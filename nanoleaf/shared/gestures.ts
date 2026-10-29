/**
 * Controls: what a gesture on the wall does right now. Main acts on it; the interface uses the same answer to show
 * whether a gesture it heard did something, and to what.
 */
import { liveFor, pinnedFor } from "./scene.ts";
import type { ActivityLike, GestureAction, SessionLike, TouchGesture } from "./types.ts";

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

/** One thing to do to the workspace, as the SDK does it. */
export type GestureStep =
  | { readonly kind: "pause"; readonly sessionId: string; readonly activityId: string }
  | { readonly kind: "stop"; readonly sessionId: string; readonly activityId: string }
  | { readonly kind: "track"; readonly activityId: string }
  | { readonly kind: "pin"; readonly activityId: string }
  | { readonly kind: "unpin"; readonly activityId: string };

/**
 * What a gesture's action does now, judged as the wall shows things (scene.ts): the user's newest live span first,
 * then their pin. Null when it does nothing: an adaptive action with nothing live or pinned, an activity that is gone
 * or archived, pinning what is already pinned, starting what is already live. Starting an activity while another is
 * live runs the two side by side, as core does.
 */
export function resolveGesture(
  action: GestureAction | undefined,
  userId: string,
  activities: readonly ActivityLike[],
  sessions: readonly SessionLike[],
): GestureStep | null {
  if (!action) return null;
  if (action.kind === "pause-resume" || action.kind === "stop-unpin") {
    const live = liveFor(userId, activities, sessions);
    if (live) {
      const at = { sessionId: live.session.id, activityId: live.activity.id };
      return { kind: action.kind === "pause-resume" ? "pause" : "stop", ...at };
    }
    const pinned = pinnedFor(userId, activities);
    if (!pinned) return null;
    return { kind: action.kind === "pause-resume" ? "track" : "unpin", activityId: pinned.id };
  }
  const activity = activities.find((a) => a.id === action.activityId);
  if (!activity || activity.archived) return null;
  if (action.kind === "pin") {
    return activity.pinnedBy?.includes(userId) ? null : { kind: "pin", activityId: activity.id };
  }
  // A span already live for the user would only start a second one.
  const live = sessions.some(
    (s) => s.status === "live" && s.type === "span" && s.activityId === activity.id && s.memberIds.includes(userId),
  );
  return live ? null : { kind: "track", activityId: activity.id };
}
