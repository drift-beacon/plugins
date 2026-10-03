import type { NanoleafModel } from "../model.ts";

/** Whether the wall itself is showing what the plugin decided, and if not, why not in a few words. */
export interface WallShowing {
  /** Main is driving the wall right now (`output.inControl`). */
  readonly showing: boolean;
  /** What the wall is actually doing instead, for a muted drawing's label; null while it's showing. */
  readonly reason: string | null;
}

type ShowingInput = Pick<NanoleafModel, "controller" | "settings" | "mainStatus" | "connection" | "output">;

/**
 * The wall shows the scene only while main says it is in control (`output.inControl`); a null output means main
 * isn't running. Otherwise the drawing is only what the wall *would* show, and this says why it doesn't.
 */
export function wallShowing(model: ShowingInput): WallShowing {
  if (model.output?.inControl === true) return { showing: true, reason: null };
  return { showing: false, reason: notShowingReason(model) };
}

function notShowingReason({ controller, settings, mainStatus, connection, output }: ShowingInput): string {
  const name = connection?.name ?? controller?.name ?? "the controller";
  if (!controller) return "Not paired yet";
  if (!settings.enabled) return "Paused: driving is off";
  if (mainStatus === "starting") return "The plugin is starting";
  if (mainStatus !== "running" || !output) return "The plugin isn't running";
  if (connection?.status === "unreachable") return `Can't reach ${name}`;
  if (connection?.status === "unauthorized") return `${name} needs pairing again`;
  if (connection?.status !== "connected") return `Connecting to ${name}`;
  switch (output.mode) {
    case "busy":
      return "Someone else is driving it";
    case "yielded":
      return "Changed somewhere else";
    case "paused":
      return "Paused: driving is off";
    case "idle":
      return output.detail ?? "Showing its own scene";
    case "disconnected":
      return `Can't reach ${name}`;
    default:
      return output.detail ?? "Not driven by the plugin right now";
  }
}
