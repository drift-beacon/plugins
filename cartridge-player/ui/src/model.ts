import { createContext, createElement, type ReactNode, useContext } from "react";
import type { PresenceState } from "../../shared/state.ts";
import type { PlayerRecord, TagMappings } from "../../shared/storage.ts";
import type { Tag } from "../../shared/tags.ts";
import type { LabelResult, StartResult } from "../../shared/ui-channel.ts";
import type { MainStatus } from "./view/main-status.ts";
import type { ReadingBeat } from "./view/phase.ts";
import type { ActivityLookup, ActivityView, CategoryView, LiveSession } from "./view/types.ts";

/**
 * Everything the interface reads and does. The view never touches `ctx`: the live model wraps it (live-model.ts) and
 * the prototype harness supplies a simulator, so both render the same components. Every field keeps its identity
 * until its value changes, so components can memoise on them.
 */
export interface PlayerModel {
  /** Every activity, archived included, in the app's order. */
  readonly activities: readonly ActivityView[];
  readonly lookup: ActivityLookup;
  readonly categories: readonly CategoryView[];
  /** The current user's live sessions. */
  readonly live: readonly LiveSession[];
  readonly mappings: TagMappings;
  readonly record: PlayerRecord;
  /** Main's published `player` state; null while main isn't running (published state goes with it). */
  readonly presence: PresenceState | null;
  readonly mainStatus: MainStatus;
  readonly mainStatusReason: string | null;
  /** The reading beat: main just heard a cartridge go in and is resolving it. */
  readonly reading: ReadingBeat | null;
  /** `ctx.plugin.apiPath`, for the setup code. */
  readonly apiPath: string;
  /** The host this page was loaded from: the setup guide's first guess at the hub's address. */
  readonly pageHost: string;
  /** Every change goes through main (shared/ui-channel.ts). Each rejects with a `PluginError` main or the app threw. */
  readonly actions: {
    label(tag: Tag, activityId: string): Promise<LabelResult>;
    forget(tag: Tag): Promise<void>;
    dismiss(tag: Tag): Promise<void>;
    start(deviceId: string | null): Promise<StartResult>;
  };
}

const ModelContext = createContext<PlayerModel | null>(null);

export function ModelProvider({ value, children }: { value: PlayerModel; children: ReactNode }) {
  return createElement(ModelContext.Provider, { value }, children);
}

/** The model the surrounding `ModelProvider` supplies. */
export function useModel(): PlayerModel {
  const model = useContext(ModelContext);
  if (!model) throw new Error("useModel() needs a <ModelProvider>");
  return model;
}
