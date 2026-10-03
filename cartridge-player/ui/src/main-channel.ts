import type { MainApi } from "@drift-beacon/plugin/ui";
import type { PlayerRecord } from "../../shared/storage.ts";
import { normalizeTag } from "../../shared/tags.ts";
import type { PlayerModel } from "./model.ts";
import { beatResolved, type ReadingBeat } from "./view/phase.ts";

/** Starting an activity waits for the app's snapshot, which can take a moment on a busy hub. */
export const START_TIMEOUT_MS = 15_000;

/** What the channel needs of `ctx.main`. */
export type MainPort = Pick<MainApi, "request" | "onMessage" | "onResync">;

/** The interface's side of the private channel (shared/ui-channel.ts): its requests, and the reading beat. */
export interface MainChannel {
  readonly actions: PlayerModel["actions"];
  /**
   * Hears the reading beat: a beat each time main says a cartridge went in, and null when a resync may have lost
   * what followed (storage alone speaks then). Returns how to stop listening.
   */
  onReading(listener: (beat: ReadingBeat | null) => void): () => void;
}

/**
 * The channel over `main`, with no React in it so tests script it. Every change is a request (inputs stay inside
 * what main's schemas accept: closed objects, no `undefined` fields). A `reading` message becomes a beat that ends on
 * the insert's history entry: main names that entry's id, and for a main that doesn't, the record's `nextId` as this
 * copy sees it when the message arrives stands in (`readRecord` reads storage at that moment). The message and the
 * storage write travel separately, so the outcome can arrive first: a beat that is already over is never started.
 */
export function createMainChannel(main: MainPort, readRecord: () => PlayerRecord, now: () => number = Date.now): MainChannel {
  return {
    actions: {
      label: (tag, activityId) => main.request("label", { tag, activityId }),
      async forget(tag) {
        await main.request("forget", { tag });
      },
      async dismiss(tag) {
        await main.request("dismiss", { tag });
      },
      start: (deviceId) => main.request("start", deviceId ? { deviceId } : {}, { timeoutMs: START_TIMEOUT_MS }),
    },
    onReading(listener) {
      const stopMessage = main.onMessage("reading", (message) => {
        const { tag, deviceId, entry: named } = message;
        const canonical = normalizeTag(tag);
        if (!canonical || typeof deviceId !== "string") return;
        const record = readRecord();
        // Checked, not trusted: an older main sends no `entry`.
        const entry = Number.isInteger(named) && named > 0 ? named : record.nextId;
        const beat: ReadingBeat = { tag: canonical, deviceId, at: now(), entry };
        if (!beatResolved(beat, record.history)) listener(beat);
      });
      const stopResync = main.onResync(() => listener(null));
      return () => {
        stopMessage();
        stopResync();
      };
    },
  };
}
