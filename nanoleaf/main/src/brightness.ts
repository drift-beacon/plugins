/**
 * The two brightness settings as declared state and commands: the `sessionBrightness` and `pinnedBrightness` range
 * controls in manifest.json read `brightness` and set it through `setSessionBrightness` and `setPinnedBrightness`, for
 * Home Assistant and Stream Deck keys. Setting one saves the setting, as the interface's sliders do; the storage change
 * then reaches the Director and publishes the state again, whoever made it.
 */
import { readSettings } from "../../shared/storage.ts";
import { type Settings, STORAGE_KEYS } from "../../shared/types.ts";

/** The published `brightness` state. */
export interface BrightnessState {
  readonly session: number;
  readonly pinned: number;
}

/** The storage main reads and writes settings through. */
export interface SettingsStorage {
  get(key: string): unknown;
  set(key: string, value: unknown): Promise<void>;
}

/** Which setting each command sets. */
export const BRIGHTNESS_SETTINGS = Object.freeze({
  session: "maxBrightness",
  pinned: "pinnedBrightness",
} as const);

export function brightnessState(settings: Settings): BrightnessState {
  return { session: settings.maxBrightness, pinned: settings.pinnedBrightness };
}

/**
 * Saves one brightness setting, keeping the others as stored. The value is clamped and rounded the way settings are
 * read, so what is published is what drives the wall.
 */
export async function saveBrightness(
  storage: SettingsStorage,
  which: keyof typeof BRIGHTNESS_SETTINGS,
  value: number,
): Promise<void> {
  const settings = readSettings(storage.get(STORAGE_KEYS.settings));
  const next = readSettings({ ...settings, [BRIGHTNESS_SETTINGS[which]]: value });
  await storage.set(STORAGE_KEYS.settings, next);
}
