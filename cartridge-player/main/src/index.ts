/**
 * Cartridge Player: slide a labelled NFC cartridge into the player and its activity starts; pull it out and it stops.
 * onStart wires the player (player.ts: the slot state machine, its queue and presence) to the HTTP routes the device
 * calls, the private channel the interface uses, and workspace data changes, which only ever republish state. It is
 * synchronous, so the routes answer as soon as it returns and the probe never waits on storage.
 */
import { definePlugin, type MainContext, type PluginDefinition } from "@drift-beacon/plugin";
import { STORAGE_KEYS } from "../../shared/storage.ts";
import { registerChannel } from "./channel.ts";
import { createPlayer } from "./player.ts";
import { type Clock, GLOBAL_TIMERS, type Timers } from "./ports.ts";
import { registerRoutes } from "./routes.ts";

/** Knobs for tests: a clock and timers to drive presence; production uses the real ones. */
export interface CartridgePlayerOptions {
  readonly now?: Clock;
  readonly timers?: Timers;
}

/** A plugin definition with these options; the default export uses none. */
export function createPlugin(options: CartridgePlayerOptions = {}): PluginDefinition {
  return definePlugin({
    onStart(ctx) {
      startCartridgePlayer(ctx, options);
    },
  });
}

export default createPlugin();

/** Builds and wires one instance: its state lives here, never at module scope (one module serves every instance). */
export function startCartridgePlayer(ctx: MainContext, options: CartridgePlayerOptions = {}): void {
  const player = createPlayer(ctx, { now: options.now ?? Date.now, timers: options.timers ?? GLOBAL_TIMERS });
  registerRoutes(ctx, player);
  registerChannel(ctx, player);
  player.open();
  // Whether a slot is playing is read from the workspace: a data change can change the phase, never start or end.
  ctx.onDataChange(() => player.publish());
  ctx.storage.onChange((key) => {
    if (key === STORAGE_KEYS.player || key === STORAGE_KEYS.mappings) player.publish();
  });
  ctx.onStop(() => player.stop());
}
