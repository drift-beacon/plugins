/** A member of the workspace, as far as choosing who a roll is for needs one. */
export interface RosterMember {
  readonly id: string;
  readonly role: string;
}

/**
 * Who a roll is for: the stored choice, less anyone no longer in `members`, in stored order. When that leaves nobody,
 * or nothing is stored, the workspace's owner. Empty only when `members` has no owner, which is an empty roster. The
 * owner stand-in is never written back.
 */
export function actingFor(chosen: readonly string[] | undefined, members: readonly RosterMember[]): string[] {
  const here = new Set(members.map((member) => member.id));
  const kept = [...new Set(chosen ?? [])].filter((id) => here.has(id));
  if (kept.length > 0) return kept;
  const owner = members.find((member) => member.role === "OWNER");
  return owner ? [owner.id] : [];
}

/** The choice with `id` ticked or unticked; null when that would untick the last one. */
export function toggleMember(chosen: readonly string[], id: string): string[] | null {
  if (!chosen.includes(id)) return [...chosen, id];
  if (chosen.length <= 1) return null;
  return chosen.filter((other) => other !== id);
}
