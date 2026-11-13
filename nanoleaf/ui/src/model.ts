import { createContext, createElement, type ReactNode, useContext } from "react";
import { DEFAULT_ORDER } from "../../shared/storage.ts";
import type {
  ActivityLike,
  ConnectionInfo,
  ControlLease,
  FoundController,
  Layout,
  MemberLike,
  OutputInfo,
  PanelOrder,
  SessionLike,
  Settings,
  TouchGesture,
  Zone,
} from "../../shared/types.ts";
import type { ControllerChange, PairingStep, PairResult, PreviewRequest } from "../../shared/ui-channel.ts";
import { resolveZones } from "../../shared/zones.ts";
import type { ZoneActions } from "./lib/zone-actions.ts";

export type { ControllerChange, PairingStep, PairResult, PreviewRequest } from "../../shared/ui-channel.ts";

/** How a pairing can be followed and given up. */
export interface PairOptions {
  /** Aborting it gives the pairing up: main stops asking the controller, unless it has already handed out a token. */
  readonly signal?: AbortSignal;
  /** Called as main gets on: the controller answered (`waiting` for its button), then `connecting` to it. */
  readonly onStep?: (step: PairingStep) => void;
}

/**
 * Whether main runs here: the platform's status, plus `connecting` while this page hasn't heard it yet (the app's
 * placeholder before its first report reads `unavailable`, which would otherwise flash "isn't running" at open).
 */
export type MainStatus =
  | "connecting"
  | "running"
  | "starting"
  | "unavailable"
  | "disabled"
  | "incompatible"
  | "not-installed";

/**
 * Everything the interface reads and does. The view never touches `ctx`: the live model wraps it (live-model.ts), and
 * the prototype harness supplies a simulator, so both render the same components.
 */
export interface NanoleafModel {
  /**
   * Every activity, archived included, in the app's order: a live session on an archived activity still glows (as
   * core's live-activity slot shows it). Lists and pickers filter `!archived`; pins of archived activities don't count.
   */
  readonly activities: readonly ActivityLike[];
  /** Every session in the workspace, newest first. */
  readonly sessions: readonly SessionLike[];
  readonly settings: Settings;
  /** The workspace's members, as this device last heard (none from an app that sends no roster). */
  readonly members: readonly MemberLike[];
  /**
   * The wall's zones as stored (storage `zones`): each a group of panels belonging to one member. What stands on the
   * wall now, and who each acts for, is `resolveZones` (lib/zones.ts `wallZones`), worked out where it is used.
   */
  readonly zones: readonly Zone[];
  readonly order: PanelOrder;
  readonly layout: Layout | null;
  /** The paired controller, without its token. */
  readonly controller: {
    readonly host: string;
    readonly port: number;
    readonly name: string | null;
    readonly model: string | null;
  } | null;
  /** Null until main publishes it. */
  readonly connection: ConnectionInfo | null;
  /** What main does with the wall; null while main isn't running. The wall shows a scene only when `inControl`. */
  readonly output: OutputInfo | null;
  /**
   * The lock another plugin or Home Assistant holds on the wall (main's `control` state), its effect on this page's
   * clock; null when nobody does.
   */
  readonly control: ControlLease | null;
  /** Whether main is running here, and if not why (`mainStatusReason`). */
  readonly mainStatus: MainStatus;
  readonly mainStatusReason: string | null;
  /** The app sends goals, periods and pins (SDK 0.2.2). Without them the wall still glows, but shows no goal or pin. */
  readonly supportsGoals: boolean;
  /**
   * The controller's touch stream has been heard since main last connected to it (main's `touchStream`): until it is,
   * a swipe on a split wall can't be placed in a zone, so it does nothing.
   */
  readonly touchStreamHeard: boolean;
  readonly actions: ZoneActions & {
    /**
     * Applies locally at once; rejects (and rolls back) when the app refuses the write. The model logs a refusal, so
     * dropping the promise is safe, but a control that can snap back should catch it and say so.
     */
    saveSettings(patch: Partial<Settings>): Promise<void>;
    /** As `saveSettings`. */
    saveOrder(order: PanelOrder): Promise<void>;
    /** Aborting `signal` ends the search in main too. */
    discover(timeoutMs?: number, signal?: AbortSignal): Promise<readonly FoundController[]>;
    /** Rejects `invalid` for an address that isn't on the local network. */
    pair(host: string, port?: number, options?: PairOptions): Promise<PairResult>;
    forget(): Promise<void>;
    /**
     * Reconnects and re-reads the layout. While the controller can't be reached, main also searches for it at another
     * address at once ("Search again"); rejects `unavailable` when it still isn't found.
     */
    refresh(): Promise<void>;
    resume(): Promise<void>;
    /** Fire and forget: failures are swallowed (the preview is a nicety). */
    preview(request: PreviewRequest): Promise<void>;
    brightness(value: number): Promise<void>;
    /** Tell main this copy is numbering panels (tap to order), or has stopped. Fire and forget. */
    numbering(on: boolean): Promise<void>;
  };
  /** Physical panel touches, while the controller's event stream is open. Returns an unsubscribe. */
  onTouch(listener: (panelId: number, gesture: TouchGesture) => void): () => void;
  /**
   * The zone main acted in for each gesture the wall reports (main's `gestureZone`), once it has worked it out: null
   * when it acted nowhere (a swipe on a split wall the touch stream couldn't place). A swipe's `touch` event names no
   * panel, so on a split wall this is the only way to know where it acted. Returns an unsubscribe.
   */
  onGestureZone(listener: (gesture: TouchGesture, zoneId: string | null) => void): () => void;
  /**
   * The controller was paired or forgotten just now, by any copy of the interface: another tab or device, or this
   * one. A copy hears its own pairing and forgetting too (before the request's answer), so a listener must be
   * idempotent: do what the news calls for only if it isn't done yet, and never treat it as "someone else did this".
   * The lasting truth is `controller` and `connection`; this only says it happened now. Returns an unsubscribe.
   */
  onControllerChanged(listener: (change: ControllerChange) => void): () => void;
  /**
   * Main may no longer hold what this copy asked of it, or may have told it something it missed (main restarted, or
   * the connection to it was made again): ask again for whatever still matters. Returns an unsubscribe.
   */
  onResync(listener: () => void): () => void;
}

const ModelContext = createContext<NanoleafModel | null>(null);

export function ModelProvider({ value, children }: { value: NanoleafModel; children: ReactNode }) {
  return createElement(ModelContext.Provider, { value }, children);
}

/** The model the surrounding `ModelProvider` supplies. */
export function useModel(): NanoleafModel {
  const model = useContext(ModelContext);
  if (!model) throw new Error("useModel() needs a <ModelProvider>");
  return model;
}

/**
 * Who the unsplit wall follows, worked out as main works it out: the first zone that stands, acting for its member
 * while they are in the workspace, else the owner (nobody with no roster). On a split wall each zone follows its own.
 */
export function followingOf(model: Pick<NanoleafModel, "members" | "zones">): string[] {
  return [...(resolveZones(model.zones, [], model.members, DEFAULT_ORDER)[0]?.following ?? [])];
}
