/**
 * Who the wall acts for: one answer that main, the interface's preview and its picker all use, so they can't disagree.
 * The rules that use it (scene.ts, gestures.ts) take the one acting member in a list as an argument; only callers read
 * storage.
 */
import type { MemberLike } from "./types.ts";

/**
 * Who a zone acts for, as a list of at most one: its stored member while they are in `members`. With nobody stored, or
 * someone who has left, the workspace's owner. Empty only when `members` has no owner: an empty roster.
 */
export function actingFor(chosen: string | null | undefined, members: readonly MemberLike[]): string[] {
  if (chosen && members.some((member) => member.id === chosen)) return [chosen];
  const owner = members.find((member) => member.role === "OWNER");
  return owner ? [owner.id] : [];
}

/**
 * What a press on `pressed` in the picker writes: their id, or null when they are already the one followed, since a
 * single choice can't be cleared and the fallback to the owner is never stored.
 */
export function choiceAfterPress(following: readonly string[], pressed: string): string | null {
  return following.includes(pressed) ? null : pressed;
}

/** Whether a schedule that speaks to `members` (`ScheduleTrigger.members`) flashes a wall that follows `following`. */
export function speaksTo(members: readonly string[], following: readonly string[]): boolean {
  return members.some((id) => following.includes(id));
}
