/**
 * What main publishes (manifest.json `provides`): its own interface reads it through `ctx.plugins.self.state`, and
 * Home Assistant and other plugins can too. Published state lives only while main runs, so main republishes it from
 * storage in `onStart`. The schemas in manifest.json describe exactly these shapes.
 */
import type { Tag } from "./tags.ts";

/**
 * `player`: whether the player is reachable. `online` is null when that isn't known: before any player is heard, and
 * for a stored player main hasn't heard since it started, for at most OFFLINE_AFTER_MS (then it's offline). Changes
 * when the player comes online or goes offline or another one takes over, not on every heartbeat.
 */
export interface PresenceState {
  readonly online: boolean | null;
  /** As stored: to within PRESENCE_WRITE_MS while it's online (heartbeats aren't written), exact once it's offline. */
  readonly lastHeardAt: string | null;
  readonly deviceId: string | null;
  readonly name: string | null;
  readonly firmware: string | null;
  readonly reader: "ok" | "fault" | null;
}

/**
 * The slot, as other plugins and Home Assistant care about it:
 * - empty; playing (its session is live); marked (a point activity was marked when it went in)
 * - ready: labelled and in, nothing tracking (labelled while in, or its session was ended elsewhere)
 * - unknown: unlabelled; orphan / archived: its activity was deleted / archived; error: starting it failed
 */
export type SlotPhase = "empty" | "playing" | "marked" | "ready" | "unknown" | "orphan" | "archived" | "error";

export interface SlotState {
  readonly phase: SlotPhase;
  readonly tag: Tag | null;
  readonly activityId: string | null;
  readonly sessionId: string | null;
  readonly since: string | null;
  readonly deviceId: string | null;
}

/** Event `inserted`: a cartridge went in. `result` is the report result (shared/protocol.ts). */
export interface InsertedEvent {
  readonly tag: Tag;
  readonly activityId: string | null;
  readonly result: "started" | "marked" | "resumed" | "unknown" | "orphan" | "archived" | "error";
}

/** Event `ejected`: a cartridge came out. `durationMs`: how long its session ran while it was in, if one did. */
export interface EjectedEvent {
  readonly tag: Tag;
  readonly activityId: string | null;
  readonly durationMs: number | null;
}

export const EMPTY_SLOT: SlotState = Object.freeze({
  phase: "empty",
  tag: null,
  activityId: null,
  sessionId: null,
  since: null,
  deviceId: null,
});

export const NO_PLAYER: PresenceState = Object.freeze({
  online: null,
  lastHeardAt: null,
  deviceId: null,
  name: null,
  firmware: null,
  reader: null,
});
