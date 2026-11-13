import { blankSetup, type ModeState, type Mapping } from './setup.ts';

export interface CubePreset {
  id: string;
  name: string;
  setup: ModeState;
  autoStartEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One atomic storage record: selection, edits and preset contents cannot drift apart. */
export interface CubeSettings {
  presets: CubePreset[];
  activePresetId: string | null;
  setup: ModeState;
  autoStartEnabled: boolean;
  /** Show the cube on the Nanoleaf wall while it is in hand; absent (records from before it existed) means on. */
  lightNanoleaf?: boolean;
}
export function emptySettings(): CubeSettings {
  return { presets: [], activePresetId: null, setup: blankSetup(), autoStartEnabled: false };
}
export interface CubeStatusState { state: 'idle' | 'held' | 'activated'; timestamp: string }
export type RollStartMode = 'auto' | 'manual';
export interface LastRollState {
  side: number;
  activityId: string | null;
  timestamp: string;
  presetId: string | null;
  startMode: RollStartMode | null;
  sessionId?: string;
  mapping: Mapping | null;
}
export const UNCATEGORIZED_ID = 'uncategorized';

/**
 * `rollsFor`: the member ids every roll is for, in its own record so a settings write can't overwrite it. Only the UI
 * writes it. Anything that isn't a non-empty string is dropped; undefined when nothing usable is stored.
 */
export function readRollsFor(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return ids.length > 0 ? ids : undefined;
}
