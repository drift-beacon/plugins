/**
 * The private channel between the interface and main (SDK 0.2.4: `ctx.main` in the UI, `ctx.ui` in main): what the
 * interface asks of main, and what main tells its open copies. None of it is in manifest.json, so none of it is a
 * Home Assistant action or reachable from another plugin; only `resume` is declared there. main/src and ui/src import
 * this file type-only, and its import of "@drift-beacon/plugin" (not /ui) is what makes the augmentation apply in the
 * UI's program too. The handlers are in main/src/index.ts.
 */
import type { ValueSchema } from "@drift-beacon/plugin";
import type { FoundController } from "./types.ts";

/** What `pair` answers: the controller's name and model, and how many panels it lights. */
export interface PairResult {
  readonly name: string | null;
  readonly model: string | null;
  readonly panels: number;
}

/** A `preview` request: the wall shows it for `ttlMs` (default 4000); `none` ends the asking copy's preview. */
export interface PreviewRequest {
  readonly mode: "none" | "identify" | "fill" | "order";
  /** identify: the panels to light. */
  readonly panelIds?: readonly number[];
  /** fill: how much of the goal to show, 0–1. */
  readonly fraction?: number;
  /** Whose colour to preview; defaults to what is showing. */
  readonly activityId?: string | null;
  readonly ttlMs?: number;
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
    /** Main's time (epoch ms): the clock a controller's effect runs on (`ControlEffect.startedAt`). */
    clock: { output: { now: number } };
  }
  interface PluginUiMessages {
    pairing: { readonly step: PairingStep };
    controllerChanged: { readonly change: ControllerChange };
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
    mode: { type: "string", enum: ["none", "identify", "fill", "order"] },
    panelIds: { type: "array", items: { type: "integer" } },
    fraction: { type: "number", minimum: 0, maximum: 1 },
    activityId: { type: ["string", "null"] },
    ttlMs: { type: "integer", minimum: 500, maximum: 15000 },
  },
  required: ["mode"],
};

export const BRIGHTNESS_INPUT: ValueSchema = {
  type: "object",
  properties: { value: { type: "integer", minimum: 1, maximum: 100 } },
  required: ["value"],
};
