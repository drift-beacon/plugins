import { useSyncExternalStore } from "react";
import { actingFor, toggleMember } from "../../../../shared/acting-for";

/*
 * Stand-in for the workspace's members and the `rollsFor` record, so the "Rolls are for" picker can be judged
 * without a hub. The simulator's members switch leaves only the owner, which hides the picker.
 */

const HOUSEHOLD = [
  { id: "alex", name: "Alex Morgan", role: "OWNER" },
  { id: "sam", name: "Sam", role: "MEMBER" },
  { id: "riley", name: "Riley", role: "MEMBER" },
] as const;

// `?members=1` opens the harness as a workspace of one.
let oneMember = new URLSearchParams(location.search).get("members") === "1";
let stored: string[] | undefined;
let snapshot = build();
const listeners = new Set<() => void>();

function build() {
  const members = oneMember ? HOUSEHOLD.slice(0, 1) : HOUSEHOLD;
  return { members, chosen: actingFor(stored, members), oneMember };
}
function changed() {
  snapshot = build();
  for (const listener of listeners) listener();
}

export function setOneMember(value: boolean) {
  oneMember = value;
  changed();
}

/** Tick or untick one member; false when that would leave nobody. */
export function toggleRoster(id: string): boolean {
  const next = toggleMember(snapshot.chosen, id);
  if (!next) return false;
  stored = next;
  changed();
  return true;
}

export function useRoster() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}
