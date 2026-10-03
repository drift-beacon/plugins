/**
 * Whether there is a player and whether it's reachable, in two or three words and a sentence. Presence is main's
 * published `player` state (online/offline needs main's heartbeat timer); while main isn't running only storage's
 * `lastHeardAt` is known, so the interface says what it knows and no more.
 */
import { NO_PLAYER, type PresenceState } from "../../../shared/state.ts";
import type { DeviceRecord, PlayerRecord } from "../../../shared/storage.ts";
import { epoch, relative } from "./format.ts";

/**
 * - none: no player has ever reported; unknown: main isn't running, so nobody is listening
 * - online / offline: main's verdict on the player, from its heartbeat
 * - waiting: a player main hasn't heard yet since it started: neither, for a minute or so
 */
export type Health = "none" | "online" | "offline" | "waiting" | "unknown";

export interface PresenceView {
  readonly health: Health;
  /** Two or three words for the pill. */
  readonly label: string;
  /** A sentence for the Player panel. */
  readonly detail: string;
  readonly lastHeardAt: number | null;
  readonly name: string | null;
  readonly firmware: string | null;
  readonly readerFault: boolean;
}

const text = (value: unknown, max = 64) => (typeof value === "string" && value ? value.slice(0, max) : null);
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Main's published `player` state, tolerant of a missing or older value. */
export function readPresence(value: unknown): PresenceState {
  if (!isRecord(value)) return NO_PLAYER;
  return {
    online: typeof value.online === "boolean" ? value.online : null,
    lastHeardAt: text(value.lastHeardAt),
    deviceId: text(value.deviceId, 32),
    name: text(value.name, 32),
    firmware: text(value.firmware, 32),
    reader: value.reader === "ok" || value.reader === "fault" ? value.reader : null,
  };
}

/** Whether any player has ever reported to this plugin. */
export function everHeard(record: PlayerRecord): boolean {
  return Object.values(record.devices).some((device) => device.lastHeardAt !== null || device.slot !== null);
}

/**
 * The player as the interface describes it. `presence` is null while main isn't running (its state is gone with it);
 * `device` is the stage's device from storage.
 */
export function presenceView(
  presence: PresenceState | null,
  device: DeviceRecord | null,
  now: number,
  locale?: string,
): PresenceView {
  const heardAt = Math.max(epoch(presence?.lastHeardAt) ?? -Infinity, epoch(device?.lastHeardAt) ?? -Infinity);
  const lastHeardAt = Number.isFinite(heardAt) ? heardAt : null;
  const heard = lastHeardAt === null ? null : relative(lastHeardAt, now, locale);
  const base = {
    lastHeardAt,
    name: presence?.name ?? device?.name ?? null,
    firmware: presence?.firmware ?? device?.fw ?? null,
    readerFault: presence?.reader === "fault",
  };
  if (!presence) {
    return {
      ...base,
      health: "unknown",
      label: "Player status unknown",
      detail: heard ? `Last heard ${heard}. The plugin isn't running, so it can't hear the player now.` : "The plugin isn't running, so it can't hear the player now.",
    };
  }
  if (lastHeardAt === null) {
    return { ...base, health: "none", label: "No player yet", detail: "No player has reported to this plugin yet." };
  }
  if (presence.online === true) {
    return {
      ...base,
      health: "online",
      label: base.readerFault ? "Reader fault" : "Player online",
      detail: base.readerFault
        ? "The player is online but its reader isn't answering, so it can't tell what's in the slot. It keeps retrying."
        : "It's on and reporting to this plugin.",
    };
  }
  if (presence.online === false) {
    return {
      ...base,
      health: "offline",
      label: "Player offline",
      detail: `Last heard ${heard}. Check it has power and Wi-Fi; it reports again by itself once it's back.`,
    };
  }
  // Main has just started (an update, a hub restart) and gives the player a heartbeat or two to report before it
  // calls it offline. Nothing is wrong yet, so this neither alarms nor claims the player is there.
  return {
    ...base,
    health: "waiting",
    label: "Waiting for player",
    detail: `Last heard ${heard}. The plugin has just started and is waiting to hear from the player again; one that's on reports within a minute or so.`,
  };
}
