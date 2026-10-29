/**
 * Controls: acts on gestures made on the wall, as the user set them up (settings `gestures`, `gestureActions`). What a
 * gesture does is decided at the moment it arrives, from what's going on (shared/gestures.ts), and done through the
 * SDK as the user. One at a time: a gesture that arrives while one is still being done is dropped, so a burst of
 * touches can't pause a session and then start it again.
 */
import { type GestureStep, resolveGesture } from "../../shared/gestures.ts";
import type { Settings, TouchGesture } from "../../shared/types.ts";
import type { Log, WorkspaceData } from "./ports.ts";

/** What main does to the workspace, as the SDK does it (index.ts wires it). Each rejects when it can't. */
export interface GestureActions {
  pause(sessionId: string): Promise<unknown>;
  stop(sessionId: string): Promise<unknown>;
  track(activityId: string): Promise<unknown>;
  pin(activityId: string): Promise<unknown>;
  unpin(activityId: string): Promise<unknown>;
}

export interface GestureOptions {
  readonly userId: string;
  readonly settings: () => Settings;
  readonly data: () => WorkspaceData;
  /** Tap to order holds the wall: its taps are for numbering panels. */
  readonly drafting: () => boolean;
  readonly actions: GestureActions;
  readonly log: Log;
}

/** The log's line for a step done: "paused Deep work", "marked Take vitamins done". */
function done(step: GestureStep, name: string, point: boolean): string {
  if (step.kind === "track") return point ? `marked ${name} done` : `started ${name}`;
  const verb = { pause: "paused", stop: "stopped", pin: "pinned", unpin: "unpinned" }[step.kind];
  return `${verb} ${name}`;
}

/** Returns what to call for each gesture the wall reports. The promise settles once its step is done (or not). */
export function createGestures(options: GestureOptions): (gesture: TouchGesture) => Promise<void> {
  const { userId, actions, log } = options;
  let busy = false;
  // Never rejects: index.ts doesn't wait for it, so anything that goes wrong, reading included, is logged here.
  return async (gesture) => {
    if (busy) return;
    busy = true;
    let failure = `${gesture}: couldn't act on it`;
    try {
      const settings = options.settings();
      if (!settings.gestures || options.drafting()) return;
      const { activities, sessions } = options.data();
      const step = resolveGesture(settings.gestureActions[gesture], userId, activities, sessions);
      if (!step) return;
      const activity = activities.find((a) => a.id === step.activityId);
      const name = activity?.name ?? step.activityId;
      failure = `${gesture}: couldn't ${step.kind} ${name}`;
      await run(step, actions);
      log.info(`${gesture}: ${done(step, name, activity?.trackingType === "point")}`);
    } catch (error) {
      log.warn(failure, error);
    } finally {
      busy = false;
    }
  };
}

function run(step: GestureStep, actions: GestureActions): Promise<unknown> {
  switch (step.kind) {
    case "pause":
      return actions.pause(step.sessionId);
    case "stop":
      return actions.stop(step.sessionId);
    case "track":
      return actions.track(step.activityId);
    case "pin":
      return actions.pin(step.activityId);
    case "unpin":
      return actions.unpin(step.activityId);
  }
}
