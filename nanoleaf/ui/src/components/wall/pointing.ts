/**
 * What hovering or focusing a list row does to the wall channel:
 * - `show`: point the row's panel out on the wall (after a moment's intent);
 * - `release` / `release-soon`: let go of the identify now (the wall can't be driven) or after a short grace
 *   (the pointer is between rows);
 * - `forget`: a draft, Play or goal preview has replaced the identify with its own request, so only drop the flag;
 * - `none`: nothing is pointed at and nothing is standing.
 */
export type PointingStep = "show" | "release" | "release-soon" | "forget" | "none";

/**
 * The list-hover effect's decision. A standing identify must never outlive the ability to drive the wall (it would be
 * renewed for as long as the page is open) or the list focus that asked for it.
 */
export function listPointing(input: {
  readonly canWall: boolean;
  /** Tap to order, Play or a goal preview owns the wall channel. */
  readonly busy: boolean;
  readonly listFocus: number | null;
  /** An identify from the list is standing on the wall. */
  readonly pointing: boolean;
}): PointingStep {
  if (!input.canWall) return input.pointing ? "release" : "none";
  if (input.busy) return input.pointing ? "forget" : "none";
  if (input.listFocus !== null) return "show";
  return input.pointing ? "release-soon" : "none";
}
