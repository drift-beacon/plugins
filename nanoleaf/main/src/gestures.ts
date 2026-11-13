/**
 * Controls: acts on gestures made on the wall, as set up in the interface (settings `gestures`, `gestureActions`).
 * What a gesture does is decided at the moment it arrives, from what's going on and who the wall follows
 * (shared/gestures.ts), and done through the SDK. On a split wall a gesture acts in one zone, for that zone's member
 * (index.ts works out which). One at a time, for the whole wall: a gesture that arrives while one is still being done
 * is dropped, so a burst of touches can't pause a session and then start it again.
 */
import { type GestureStep, resolveGesture } from "../../shared/gestures.ts";
import type { Settings, TouchGesture } from "../../shared/types.ts";
import type { Log, WorkspaceData } from "./ports.ts";

/** What main does to the workspace, as the SDK does it (index.ts wires it). Each rejects when it can't. */
export interface GestureActions {
  pause(sessionId: string, placedBy: string | null): Promise<unknown>;
  stop(sessionId: string): Promise<unknown>;
  /** Starts a span or marks a point, for `members`. */
  track(activityId: string, members: readonly string[]): Promise<unknown>;
  pin(activityId: string, placedBy: string | null): Promise<unknown>;
  unpin(activityId: string): Promise<unknown>;
}

/** The zone a gesture acts in: its id, and who it is for (zones.ts `ResolvedZone`). */
export interface GestureZone {
  readonly id: string;
  readonly following: readonly string[];
}

/**
 * Where a gesture acts: the zone, or null when it acts in no zone (a swipe the touch stream didn't place on a split
 * wall). It may wait (placing a swipe). It is asked once
 * the gesture is known not to be dropped as busy, and at once, before anything is awaited: placing a swipe uses up
 * its touch data, so a swipe dropped as busy must not place, and one that isn't must place as it arrives (even when
 * gestures are off or tap to order runs, so its data can't place the next swipe).
 */
export type GestureTarget = () => GestureZone | null | Promise<GestureZone | null>;

export interface GestureOptions {
  /** Who the wall follows now: `actingFor` of its zone's member and `ctx.members`. Used when a gesture has no target. */
  readonly following: () => readonly string[];
  readonly settings: () => Settings;
  readonly data: () => WorkspaceData;
  /** Tap to order holds the wall: its taps are for numbering panels. */
  readonly drafting: () => boolean;
  readonly actions: GestureActions;
  readonly log: Log;
  /**
   * Told where a gesture with a target acts (the zone's id, or null for none), once that is known, whatever its action
   * then does. Not for a gesture dropped as busy, nor while gestures are off or tap to order takes the taps.
   */
  readonly onZone?: (gesture: TouchGesture, zoneId: string | null) => void;
}

/** The log's line for a step done: "paused Deep work", "marked Take vitamins done". */
function done(step: GestureStep, name: string, point: boolean): string {
  if (step.kind === "track") return point ? `marked ${name} done` : `started ${name}`;
  const verb = { pause: "paused", stop: "stopped", pin: "pinned", unpin: "unpinned" }[step.kind];
  return `${verb} ${name}`;
}

/**
 * Returns what to call for each gesture the wall reports, with where it acts (`target`: the zone, whose member it is
 * for; left out, it is for `following`). The promise settles once its step is done (or not).
 */
export function createGestures(
  options: GestureOptions,
): (gesture: TouchGesture, target?: GestureTarget) => Promise<void> {
  const { actions, log } = options;
  let busy = false;
  // Never rejects: index.ts doesn't wait for it, so anything that goes wrong, reading included, is logged here.
  return async (gesture, target) => {
    if (busy) return;
    busy = true;
    let failure = `${gesture}: couldn't act on it`;
    try {
      const who = target ? target() : options.following();
      // Awaited below unless the gesture is ignored; a failure then is logged there, never left unhandled. A target
      // that answers at once isn't awaited, so the step starts in the same turn as before zones.
      if (who instanceof Promise) who.catch(() => {});
      const settings = options.settings();
      if (!settings.gestures || options.drafting()) return;
      const zone = who instanceof Promise ? await who : who;
      if (options.drafting()) return;
      let following: readonly string[];
      if (target) {
        const where = zone as GestureZone | null;
        try {
          options.onZone?.(gesture, where?.id ?? null);
        } catch (error) {
          log.warn(`${gesture}: couldn't say where it acts`, error);
        }
        if (where === null) return;
        following = where.following;
      } else following = zone as readonly string[];
      const { activities, sessions } = options.data();
      const step = resolveGesture(settings.gestureActions[gesture], activities, sessions, following);
      if (!step) return;
      const activity = activities.find((a) => a.id === step.activityId);
      const name = activity?.name ?? step.activityId;
      // An empty list would start or mark it for nobody, on purpose: with no roster, nobody can be named.
      if (step.kind === "track" && step.members.length === 0) {
        const verb = activity?.trackingType === "point" ? "mark" : "start";
        log.warn(`${gesture}: didn't ${verb} ${name}: Drift Beacon sent no workspace members, so nobody can be named`);
        return;
      }
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
      return actions.pause(step.sessionId, step.placedBy);
    case "stop":
      return actions.stop(step.sessionId);
    case "track":
      return actions.track(step.activityId, step.members);
    case "pin":
      return actions.pin(step.activityId, step.placedBy);
    case "unpin":
      return actions.unpin(step.activityId);
  }
}
