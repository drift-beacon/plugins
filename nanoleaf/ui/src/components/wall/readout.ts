import { progressPercent } from "../../../../shared/scene.ts";
import type { WallShowing } from "../../lib/showing.ts";

/**
 * What the drawing says to a screen reader: the wall, what it glows with, the goal, and, when the wall isn't actually
 * showing it (offline, paused, someone else driving…), that it only would.
 */
export function stageLabel(input: {
  readonly panels: number;
  readonly activity: string | null;
  readonly fraction: number | null;
  readonly showing: WallShowing;
}): string {
  const { panels, activity, fraction, showing } = input;
  const parts = [`Drawing of your wall: ${panels} ${panels === 1 ? "panel" : "panels"}`];
  if (!activity) parts.push("not lit by the plugin right now");
  else if (showing.showing) parts.push(`glowing in the colour of ${activity}`);
  else {
    const why = showing.reason ?? "not driven";
    parts.push(`it would glow in the colour of ${activity}, but isn't showing it: ${why}`);
  }
  if (activity && fraction !== null) parts.push(`${progressPercent(fraction)}% of the goal filled`);
  return parts.join(", ");
}

/** The stage toast for a save the app refused (the SDK has rolled it back): what didn't save, and why. */
export function refusedText(what: string, error: unknown): string {
  const why = error instanceof Error ? error.message : String(error);
  return `Couldn't save ${what}: ${why}`;
}
