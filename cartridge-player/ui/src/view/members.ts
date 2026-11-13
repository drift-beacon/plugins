/**
 * The "Tracks for" row's ticks (components/shelf/TracksFor.tsx), kept out of React so tests can check them.
 */
import { actingFor } from "../../../shared/acting-for.ts";
import type { MemberView } from "./types.ts";

/**
 * The members ticked: the choice the row last sent (`asked`, once main answers it is what main stored), else the
 * stored one, through `actingFor` over the roster this device has. A member no longer on that roster is never ticked,
 * so the ticks are only chips the user can see.
 */
export function tickedMembers(asked: readonly string[] | null, stored: readonly string[], members: readonly MemberView[]): string[] {
  return actingFor(asked ?? stored, members);
}

/** The choice after pressing `id`'s chip, or null when it is the last one ticked, which can't be unticked. */
export function toggledMembers(ticked: readonly string[], id: string): string[] | null {
  if (!ticked.includes(id)) return [...ticked, id];
  return ticked.length === 1 ? null : ticked.filter((other) => other !== id);
}
