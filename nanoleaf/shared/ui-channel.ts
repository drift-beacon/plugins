/**
 * The private channel between the interface and main (SDK 0.2.4: `ctx.main` in the UI, `ctx.ui` in main): what the
 * interface asks of main, and what main tells its open copies. None of it is in manifest.json, so none of it is a
 * Home Assistant action or reachable from another plugin; only `resume` is declared there. main/src and ui/src import
 * this file type-only, and its import of "@drift-beacon/plugin" (not /ui) is what makes the augmentation apply in the
 * UI's program too. The handlers are in main/src/index.ts.
 */
import type { ValueSchema } from "@drift-beacon/plugin";
import type { FoundController, TouchGesture } from "./types.ts";

/** What `pair` answers: the controller's name and model, and how many panels it lights. */
export interface PairResult {
  readonly name: string | null;
  readonly model: string | null;
  readonly panels: number;
}

/**
 * A `preview` request: the wall shows it for `ttlMs` (default 4000); `none` ends the asking copy's preview. `draft` is
 * tap to order holding the wall: `panelIds` are the panels numbered so far. `fill`, `order` and `draft` apply to one
 * zone (`zoneId`, the first zone when left out): the other zones keep showing what they show, except under `draft`,
 * which holds the whole wall with them dark. `identify` lights panels wherever they are. `zones` is the zone-editing
 * preview: every zone in its tag colour (shared/zones.ts `zoneTagLights`); it takes no other field.
 */
export interface PreviewRequest {
  readonly mode: "none" | "identify" | "fill" | "order" | "draft" | "zones";
  /** identify: the panels to light; draft: the panels numbered so far. */
  readonly panelIds?: readonly number[];
  /** fill: how much of the goal to show, 0–1. */
  readonly fraction?: number;
  /** Whose colour to preview; defaults to what is showing. */
  readonly activityId?: string | null;
  /** fill, order and draft: the zone it applies to (a stored zone id); left out, or no zone now, the first zone. */
  readonly zoneId?: string;
  readonly ttlMs?: number;
}

/** Whether any touch stream packet has arrived since main last connected to this controller. */
export interface TouchStreamInfo {
  readonly heard: boolean;
}

/**
 * How far a pairing has got, told to the copy that asked: the controller answered and main is `waiting` for its
 * pairing window (the power button), then `connecting` once it handed out a token (reading its layout).
 */
export type PairingStep = "waiting" | "connecting";

/** The controller was paired or forgotten, told to every open copy. */
export type ControllerChange = "paired" | "forgotten";

declare module "@drift-beacon/plugin" {
  interface PluginUiRequests {
    /** Look for controllers on the server's network (mDNS and SSDP) for `timeoutMs` (default 2500). */
    discover: { input: { readonly timeoutMs?: number }; output: { controllers: FoundController[] } };
    /**
     * Ask a controller on the local network for an access token; waits up to the request's budget (30 s). An address
     * off the local network is refused as a mistake (main/src/lan.ts); a host name is looked up again at each
     * connection, so that check is a help against wrong entries, not a security guarantee.
     */
    pair: { input: { readonly host: string; readonly port?: number }; output: PairResult };
    /** Hand the lights back, revoke the access token and forget the controller. */
    forget: { output: undefined };
    /** Reconnect and re-read the layout. */
    refresh: { output: { panels: number } };
    /** Show a temporary preview on the panels, owned by the copy that asked; `shown`: main drives the wall for it. */
    preview: { input: PreviewRequest; output: { shown: boolean } };
    /** Try a maximum brightness at once while a slider is dragged; the saved setting is unchanged. */
    brightness: { input: { readonly value: number }; output: { applied: boolean } };
    /**
     * This copy is numbering panels (tap to order) or has stopped: while any open copy is, gestures on the wall leave
     * the workspace alone, since its taps are numbers. Separate from the `draft` preview, which only exists while main
     * may drive the wall.
     */
    numbering: { input: { readonly on: boolean }; output: undefined };
    /** Main's time (epoch ms): the clock a controller's effect runs on (`ControlEffect.startedAt`). */
    clock: { output: { now: number } };
    /**
     * Whether the controller's touch stream has been heard since main last connected to it: without it, a swipe on a
     * split wall acts nowhere (it can't be placed in a zone).
     */
    touchStream: { output: TouchStreamInfo };
  }
  interface PluginUiMessages {
    pairing: { readonly step: PairingStep };
    controllerChanged: { readonly change: ControllerChange };
    /** `touchStream` changed (a first packet arrived, or main connected again): told to every open copy. */
    touchStream: TouchStreamInfo;
    /**
     * Where a gesture on the wall acts, told to every open copy once main knows (for a swipe on a split wall, once the
     * touch stream has placed it): the zone's id, or null when it acts in none. Whatever its action then does; not for
     * a touch tap to order or zone editing take, nor one dropped while another gesture is being worked on.
     */
    gestureZone: { readonly gesture: TouchGesture; readonly zoneId: string | null };
  }
}

/*
 * The inputs main checks before a handler runs (`ctx.ui.handle(name, handler, { input })`), in the manifest's schema
 * subset: objects are closed, so a field that isn't listed is refused. `forget` and `refresh` take none.
 */

export const DISCOVER_INPUT: ValueSchema = {
  type: "object",
  properties: { timeoutMs: { type: "integer", minimum: 500, maximum: 8000 } },
};

export const PAIR_INPUT: ValueSchema = {
  type: "object",
  properties: { host: { type: "string" }, port: { type: "integer", minimum: 1, maximum: 65535 } },
  required: ["host"],
};

export const PREVIEW_INPUT: ValueSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["none", "identify", "fill", "order", "draft", "zones"] },
    panelIds: { type: "array", items: { type: "integer" } },
    fraction: { type: "number", minimum: 0, maximum: 1 },
    activityId: { type: ["string", "null"] },
    zoneId: { type: "string" },
    ttlMs: { type: "integer", minimum: 500, maximum: 15000 },
  },
  required: ["mode"],
};

export const BRIGHTNESS_INPUT: ValueSchema = {
  type: "object",
  properties: { value: { type: "integer", minimum: 1, maximum: 100 } },
  required: ["value"],
};

export const NUMBERING_INPUT: ValueSchema = {
  type: "object",
  properties: { on: { type: "boolean" } },
  required: ["on"],
};
