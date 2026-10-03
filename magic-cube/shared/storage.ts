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
