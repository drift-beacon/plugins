import type { ControllerChange } from "../../../../shared/ui-channel.ts";

/** Where a setup is: looking for a controller, pairing with one, or showing the arrival. */
export type SetupStepKind = "find" | "pair" | "done";

/**
 * Whether a setup at `step` steps aside for the wall on the news that the controller changed (`onControllerChanged`).
 * Only one still at Find does, when a controller was paired: there is nothing left to find. Every copy hears every
 * change, its own included, so this must hold for a copy's own pairing too: that happens at Pair, where the news
 * changes nothing (the request's answer moves the step on to Done, which hands over when its arrival has played),
 * and a forgetting never closes a setup (App opens one when the stored controller goes). Closing is `setSetup(null)`
 * in App, so hearing the same news twice, or the news and the stored controller both, closes once.
 */
export function stepsAside(step: SetupStepKind, change: ControllerChange): boolean {
  return step === "find" && change === "paired";
}
