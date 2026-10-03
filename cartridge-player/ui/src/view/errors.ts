/**
 * A failed request to main, in a sentence the user can act on. Main's own refusals (`invalid`, `not-found`) are
 * already sentences ("Take it out of the player first"); the platform's codes are about the connection, and say
 * whether the change may still have happened. One of main's sentences travels under a platform code (`SAVE_REFUSED`).
 */
import { SAVE_REFUSED } from "../../../shared/ui-channel.ts";

const CODES: Readonly<Record<string, string>> = {
  unavailable: "The plugin isn't running right now, so nothing changed.",
  disabled: "The plugin is switched off for this workspace, so nothing changed.",
  "not-installed": "The plugin isn't installed here, so nothing changed.",
  incompatible: "This Drift Beacon can't run this version of the plugin, so nothing changed.",
  unsupported: "This Drift Beacon is too old for that, so nothing changed.",
  timeout: "The plugin didn't answer in time. It may still have happened: check again in a moment.",
  stopped: "The plugin stopped before it answered. It may still have happened: check again in a moment.",
  failed: "Something went wrong in the plugin. It may still have happened: check again in a moment.",
};

/** Codes whose own message is meant for the user: main threw them with a sentence. */
const OWN_MESSAGE = new Set(["invalid", "not-found"]);

/**
 * `SAVE_REFUSED` is main's answer when storage refused the write a label, forget or dismiss made (main/src/player.ts
 * `confirmed`). Its code is `failed`, which the platform also gives a handler that threw, where the change is in doubt
 * and the user is told to look again before repeating it. Here nothing is in doubt: the change isn't there and sending
 * it again is safe, so main's own words are shown, and they say to try again.
 */
export function requestError(error: unknown): string {
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : null;
  const message = error instanceof Error ? error.message.trim() : "";
  if (code && OWN_MESSAGE.has(code) && message) return sentence(message);
  if (code === "failed" && message === SAVE_REFUSED) return sentence(message);
  if (code && Object.hasOwn(CODES, code)) return CODES[code];
  return message ? sentence(message) : "That didn't work. Try again in a moment.";
}

/** How much of an action's message main keeps on the slot (shared/storage.ts `readSlot`). */
const SLOT_ERROR_MAX = 300;

/**
 * Whether a rejected `start` is the failure main already wrote on the slot. Main rethrows the session action's own
 * error, whose code (`unavailable`, `failed`…) reads here as a problem reaching the plugin, when the plugin ran and
 * recorded why the activity didn't start. The slot's message is the reason to show, and `requestError` would only
 * contradict it. A timeout, a main that isn't running or a request that never arrived leave no such message.
 */
export function recordedByMain(error: unknown, slotError: string | null): boolean {
  if (!(error instanceof Error) || slotError === null) return false;
  const recorded = slotError.trim();
  return recorded !== "" && error.message.slice(0, SLOT_ERROR_MAX).trim() === recorded;
}

/** A message as a sentence: capitalised, ending in a full stop. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capital = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
