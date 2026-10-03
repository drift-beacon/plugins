/**
 * The private channel's handlers (shared/ui-channel.ts): the interface changes labels and starts cartridges through
 * main, never by writing storage, so a label and a device event can't overwrite each other. Inputs are checked
 * against the shared schemas before a handler runs; refusals are `PluginError`s the interface shows as they are.
 */
import type { MainContext } from "@drift-beacon/plugin";
import { LABEL_INPUT, START_INPUT, TAG_INPUT } from "../../shared/ui-channel.ts";
import type { Player } from "./player.ts";

export function registerChannel(ctx: MainContext, player: Player): void {
  ctx.ui.handle("label", (input) => player.label(input.tag, input.activityId), { input: LABEL_INPUT });
  ctx.ui.handle("forget", (input) => player.forget(input.tag), { input: TAG_INPUT });
  ctx.ui.handle("dismiss", (input) => player.dismiss(input.tag), { input: TAG_INPUT });
  ctx.ui.handle("start", (input) => player.start(input.deviceId), { input: START_INPUT });
}
