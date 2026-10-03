/**
 * Who main has heard from, in memory: a player is online until OFFLINE_AFTER_MS pass without a report (a
 * timer per device, cleared on stop). A stored player main hasn't heard since it started is neither (`expect`): it
 * gets the same wait to report before it counts as offline, so a restart never reads as "the player is gone".
 * Nothing here touches storage; player.ts writes `lastHeardAt` with its changes, on its own at most every
 * PRESENCE_WRITE_MS, and when a player goes offline.
 */
import { OFFLINE_AFTER_MS } from "../../shared/protocol.ts";
import type { Clock, Timers } from "./ports.ts";

export type ReaderHealth = "ok" | "fault" | null;

export interface Presence {
  /** `deviceId` was just heard from. Says whether that brought it online, and its reader's health before. */
  heard(deviceId: string, reader: ReaderHealth): { readonly cameOnline: boolean; readonly readerWas: ReaderHealth };
  /** A stored player not heard since main started: `online` is null until it reports or its wait is over. */
  expect(deviceId: string): void;
  /** Heard from within OFFLINE_AFTER_MS; null while main is still waiting to hear from it. */
  online(deviceId: string): boolean | null;
  reader(deviceId: string): ReaderHealth;
  /** When it was last heard from since main started (epoch ms), or null. */
  lastHeard(deviceId: string): number | null;
  /** Drops a device main no longer keeps, and its timer. */
  forget(deviceId: string): void;
  stop(): void;
}

interface Entry {
  at: number | null;
  online: boolean | null;
  reader: ReaderHealth;
  timer: unknown;
}

export function createPresence(options: {
  readonly now: Clock;
  readonly timers: Timers;
  /** A player went OFFLINE_AFTER_MS without a report (or never reported since main started). */
  readonly onOffline: (deviceId: string) => void;
}): Presence {
  const { now, timers } = options;
  const devices = new Map<string, Entry>();
  let stopped = false;

  /** Starts `entry`'s wait: OFFLINE_AFTER_MS without another report and it's offline. Nothing waits once stopped. */
  function wait(deviceId: string, entry: Entry): void {
    if (stopped) return;
    entry.timer = timers.setTimeout(() => {
      entry.timer = undefined;
      entry.online = false;
      options.onOffline(deviceId);
    }, OFFLINE_AFTER_MS);
  }

  function drop(entry: Entry | undefined): void {
    if (entry?.timer !== undefined) timers.clearTimeout(entry.timer);
    if (entry) entry.timer = undefined;
  }

  return {
    heard(deviceId, reader) {
      const before = devices.get(deviceId);
      drop(before);
      const entry: Entry = { at: now(), online: true, reader, timer: undefined };
      wait(deviceId, entry);
      devices.set(deviceId, entry);
      return { cameOnline: before?.online !== true, readerWas: before?.reader ?? null };
    },
    expect(deviceId) {
      if (devices.has(deviceId)) return;
      const entry: Entry = { at: null, online: null, reader: null, timer: undefined };
      wait(deviceId, entry);
      devices.set(deviceId, entry);
    },
    online(deviceId) {
      const entry = devices.get(deviceId);
      return entry ? entry.online : false;
    },
    reader: (deviceId) => devices.get(deviceId)?.reader ?? null,
    lastHeard: (deviceId) => devices.get(deviceId)?.at ?? null,
    forget(deviceId) {
      drop(devices.get(deviceId));
      devices.delete(deviceId);
    },
    stop() {
      stopped = true;
      for (const entry of devices.values()) drop(entry);
    },
  };
}
