import { rovingStep } from "../../lib/roving.ts";

/**
 * An arrow, Home or End in a zone's person choice: the chip to focus, and whom to give the zone to, if anyone. Landing
 * on the person already chosen (the only option, or Home or End where it already is) picks nobody: it is no change,
 * and asking would only be refused.
 */
export function personKey(
  key: string,
  index: number,
  options: readonly { readonly id: string }[],
  value: string | null,
): { readonly focus: number; readonly pick: string | null } | null {
  const next = rovingStep(key, index, options.length);
  if (next === null) return null;
  const member = options[next];
  return { focus: next, pick: member && member.id !== value ? member.id : null };
}
