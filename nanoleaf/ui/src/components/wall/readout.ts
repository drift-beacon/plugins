import { progressPercent } from "../../../../shared/scene.ts";
import type { WallShowing } from "../../lib/showing.ts";

/** What the goal scrubber says: the percentage (as the Now card rounds it) and a caption. */
export interface ScrubberReadout {
  /** The value the range sits at, 0–100. */
  readonly percent: number;
  /** "44%", or null for "Drag to try it". */
  readonly value: string | null;
  /** Which panel is filling, or null at rest with no goal to mirror. */
  readonly caption: string | null;
}

/**
 * The scrubber's words for a previewed fraction (`value`), or at rest for the live goal (`now`). The percentage uses
 * the shared `progressPercent`, so the scrubber and the Now card never disagree by one.
 */
export function scrubberReadout(value: number | null, now: number | null, n: number): ScrubberReadout {
  const active = value !== null;
  const raw = value ?? now ?? 0;
  const fraction = Math.min(1, Math.max(0, raw));
  const percent = progressPercent(raw);
  if (!active && now === null) {
    return { percent, value: null, caption: null };
  }
  const prefix = active ? "" : "Now · ";
  let caption: string;
  if (fraction >= 1) caption = `${prefix}all ${n} panels full`;
  else if (fraction <= 0) caption = `${prefix}nothing filled yet`;
  else caption = `${prefix}panel ${Math.min(n, Math.floor(fraction * n) + 1)} of ${n} filling`;
  return { percent, value: `${percent}%`, caption };
}

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
