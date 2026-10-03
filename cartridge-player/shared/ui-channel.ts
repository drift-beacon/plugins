/**
 * The private channel between the interface and main (SDK 0.2.4: `ctx.main` in the UI, `ctx.ui` in main). Every
 * change the interface makes goes through here, so main stays the only writer of storage and can do what a change
 * implies (labelling the cartridge that's in the slot, ending nothing it shouldn't). None of it is in manifest.json,
 * so Home Assistant and other plugins can't reach it. main/src and ui/src import this file type-only (plus the input
 * schemas and `SAVE_REFUSED`), and its import of "@drift-beacon/plugin" (not /ui) is what makes the augmentation apply
 * in the UI too.
 *
 * Refusals are `PluginError`s: `invalid` for a bad tag or activity, or forgetting a cartridge that's in a player for
 * certain (see `forget`); `not-found` when there's nothing to start; `failed` with `SAVE_REFUSED` when storage
 * refused a write a label, forget or dismiss made: the request didn't go through, and sending it again is safe. A
 * `start` whose session action was rejected has written the reason on the slot (outcome `error`) and rejects with that
 * action's own error: its code is the app's, not a verdict on the plugin (`failed` with the action's message when it
 * wasn't a PluginError). Every request rejects `stopped` while main is stopping.
 */
import type { ValueSchema } from "@drift-beacon/plugin";
import type { Tag } from "./tags.ts";

/**
 * The message of the `failed` refusal main gives when storage wouldn't take a label, forget or dismiss. `failed` is
 * also the platform's code for a handler that threw, so the interface tells the two apart by this sentence.
 */
export const SAVE_REFUSED = "Couldn't save it; try again";

export interface LabelResult {
  readonly tag: Tag;
  readonly activityId: string;
  /** The activity it carried before, or null for a new cartridge. */
  readonly previous: string | null;
  /** It's in a player now: the interface offers to start it (main doesn't, until it goes in again). */
  readonly inSlot: boolean;
}

export interface StartResult {
  readonly activityId: string;
  readonly sessionId: string | null;
  readonly result: "started" | "marked" | "resumed";
}

declare module "@drift-beacon/plugin" {
  interface PluginUiRequests {
    /** Label a cartridge (new or not) with an activity. */
    label: { input: { readonly tag: string; readonly activityId: string }; output: LabelResult };
    /**
     * Forget a labelled cartridge: next time it goes in it's new. Refused (`invalid`, "Take it out of the player
     * first") only while it's in a player for certain: the slot holding it has a live session, or the player holding
     * it is online as main counts it. A slot whose player is offline or hasn't been heard since main started is only
     * what the record last heard: the cartridge is forgotten and that slot emptied in the same write, ending nothing. Should that player report it still in, it's an unlabelled cartridge in its slot.
     */
    forget: { input: { readonly tag: string }; output: { readonly forgotten: boolean } };
    /** Drop an unlabelled cartridge from the list without labelling it. */
    dismiss: { input: { readonly tag: string }; output: { readonly dismissed: boolean } };
    /** Start (or mark) the labelled cartridge in a player's slot: the active player's unless `deviceId` says. */
    start: { input: { readonly deviceId?: string }; output: StartResult };
  }
  interface PluginUiMessages {
    /**
     * A cartridge just went in and main is resolving it (starting its activity can take a moment): the interface's
     * "reading" beat. Storage follows with the outcome, on a path of its own: nothing orders the two, so `entry` is
     * the id of the history entry (`insert` or `new`) this insert will write, and the beat is over once the record
     * holds it, whichever arrived first.
     */
    reading: { readonly tag: Tag; readonly deviceId: string; readonly entry: number };
  }
}

/* The inputs main checks before a handler runs (`ctx.ui.handle(name, handler, { input })`). Objects are closed. */

const TAG: ValueSchema = { type: "string", title: "Cartridge UID" };

export const LABEL_INPUT: ValueSchema = {
  type: "object",
  properties: { tag: TAG, activityId: { type: "string" } },
  required: ["tag", "activityId"],
};

export const TAG_INPUT: ValueSchema = { type: "object", properties: { tag: TAG }, required: ["tag"] };

export const START_INPUT: ValueSchema = { type: "object", properties: { deviceId: { type: "string" } } };
