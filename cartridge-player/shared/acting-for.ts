/**
 * Who a cartridge tracks for, worked out each time it is needed: main calls it when a cartridge goes in or Start is
 * pressed, and the interface when it shows the cartridge's "Tracks for" row, so the two can't disagree.
 */
import type { Member } from "@drift-beacon/plugin";

/** The parts of a member the rule reads. */
export type Roster = readonly Pick<Member, "id" | "role">[];

/**
 * The chosen members still in the workspace, in their stored order and without repeats; when that leaves nobody, or
 * nothing is chosen, the workspace's owner. Empty only for a roster with no owner, which is an empty one: an app that
 * sends no members. The owner fallback is never stored.
 */
export function actingFor(chosen: readonly string[] | undefined, members: Roster): string[] {
  const ids = new Set(members.map((member) => member.id));
  const kept = [...new Set(chosen ?? [])].filter((id) => ids.has(id));
  if (kept.length > 0) return kept;
  const owner = members.find((member) => member.role === "OWNER");
  return owner ? [owner.id] : [];
}
