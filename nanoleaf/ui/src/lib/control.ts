import { EFFECT_TYPES } from "../../../shared/effects.ts";
import type { ControlEffect, ControlLease, Rgb } from "../../../shared/types.ts";

/**
 * How far main's clock is ahead of this page's, from one `clock` request: main's time when it answered, against the
 * middle of the round trip here. A controller's effect starts at a time on main's clock (`ControlEffect.startedAt`).
 */
export function clockOffset(sentAt: number, receivedAt: number, mainNow: number): number {
  return Math.round(mainNow - (sentAt + receivedAt) / 2);
}

function isRgb(value: unknown): value is Rgb {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)
  );
}

function readEffect(raw: unknown): ControlEffect | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, type, colors, periodMs, color, startedAt } = raw as Record<string, unknown>;
  const known = EFFECT_TYPES.find((name) => name === type);
  if (typeof id !== "string" || !known || !Array.isArray(colors) || colors.length === 0 || !colors.every(isRgb)) {
    return null;
  }
  if (typeof periodMs !== "number" || !(periodMs > 0) || typeof startedAt !== "number") return null;
  return { id, type: known, colors, periodMs, color: isRgb(color) ? color : null, startedAt };
}

/**
 * The published `control` state as `decideScene` takes it, its effect's start moved from main's clock onto this
 * page's (`offset`: how far main's is ahead), so a page opened part-way through an effect draws it part-way through.
 * Null when nobody holds the wall, or for a value this version doesn't understand.
 */
export function controlOnPageClock(raw: unknown, offset: number): ControlLease | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { holder, leaseId, effect } = raw as Record<string, unknown>;
  const read = readEffect(effect);
  if (typeof holder !== "string" || typeof leaseId !== "string" || !read) return null;
  return { holder, leaseId, effect: { ...read, startedAt: read.startedAt - offset } };
}

/** Who holds the wall, as a name: a plugin's manifest id in words, or Home Assistant for `integration`. */
export function holderName(holder: string): string {
  if (holder === "integration") return "Home Assistant";
  const words = holder.split(/[-_]+/).filter((word) => word !== "");
  if (words.length === 0) return "Another plugin";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
