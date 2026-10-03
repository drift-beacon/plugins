import type { Scene } from "../../../shared/types.ts";
import { wallShowing } from "../lib/showing.ts";
import type { NanoleafModel } from "../model.ts";
import { lightCount } from "./format.ts";

export type Tone = "live" | "accent" | "muted" | "warning" | "danger";

/** The status pill: what the wall is doing, in two or three words. */
export interface WallStatus {
  readonly label: string;
  readonly tone: Tone;
  readonly dot: "ping" | "pulse" | "steady" | "none";
}

/**
 * What the wall is doing: problems come from main's status and published state. The scene is decided locally, but
 * the wall shows it only while main drives it (`output.inControl`), so Live and Pinned wait for that.
 */
export function wallStatus(model: NanoleafModel, scene: Scene): WallStatus {
  if (!model.controller) return { label: "Not paired", tone: "muted", dot: "none" };
  if (!model.settings.enabled) return { label: "Paused", tone: "warning", dot: "steady" };
  switch (model.mainStatus) {
    case "running":
      break;
    case "connecting":
      return { label: "Connecting", tone: "muted", dot: "steady" };
    case "starting":
      return { label: "Starting", tone: "muted", dot: "steady" };
    case "disabled":
      return { label: "Switched off", tone: "warning", dot: "steady" };
    default:
      return { label: "Not running", tone: "danger", dot: "steady" };
  }
  const connection = model.connection?.status;
  if (connection === "unreachable") return { label: "Offline", tone: "danger", dot: "steady" };
  if (connection === "unauthorized") return { label: "Needs pairing", tone: "danger", dot: "steady" };
  if (connection !== "connected" || !model.output) return { label: "Connecting", tone: "muted", dot: "steady" };
  const output = model.output;
  switch (output.mode) {
    case "busy":
      return { label: "Busy", tone: "warning", dot: "steady" };
    case "yielded":
      return { label: "Stepped aside", tone: "warning", dot: "steady" };
    case "preview":
      return { label: "Previewing", tone: "accent", dot: "steady" };
    case "disconnected":
      return { label: "Offline", tone: "danger", dot: "steady" };
  }
  if (scene.kind === "off") return { label: "Idle", tone: "muted", dot: "none" };
  // Main hasn't taken the wall for this scene yet: it's on its way (a session just started), or main says why not.
  if (!output.inControl) {
    return output.detail
      ? { label: "Not showing", tone: "warning", dot: "steady" }
      : { label: "Starting", tone: "muted", dot: "steady" };
  }
  if (scene.kind === "live") return { label: "Live", tone: "live", dot: "ping" };
  if (scene.kind === "control") return { label: "Controlled", tone: "accent", dot: "pulse" };
  const pulse = scene.style === "pulse";
  return { label: pulse ? "Pinned · Pulse" : "Pinned · Glow", tone: "accent", dot: pulse ? "pulse" : "steady" };
}

/**
 * Whether the wall shows the scene, and if not why, in the same words the drawing uses (lib/showing.ts). While the
 * page hasn't heard main's status yet it says so, rather than that the plugin isn't running.
 */
export function onWall(model: NanoleafModel): { readonly showing: boolean; readonly reason: string | null } {
  const shown = wallShowing(model);
  if (shown.showing || model.mainStatus !== "connecting") return shown;
  return { showing: false, reason: "Connecting to Drift Beacon" };
}

/**
 * What dragging Max brightness does on the wall: adjusts the scene main is showing, lights a preview when nothing
 * is live or pinned, or nothing while main can't drive the wall. Decided from the scene, not from whether main is in
 * control, so the preview it starts doesn't flip the hint mid-drag.
 */
export function brightnessFeedback(model: NanoleafModel, scene: Scene): "adjust" | "preview" | "none" {
  const { output } = model;
  if (model.mainStatus !== "running" || model.connection?.status !== "connected" || !output) return "none";
  if (!model.settings.enabled || output.mode === "busy" || output.mode === "yielded") return "none";
  if (lightCount(model.layout) === 0) return "none";
  return scene.kind === "off" ? "preview" : "adjust";
}

/** Text as a sentence: trimmed, with a full stop unless it already ends in punctuation (platform reasons don't). */
export function sentence(text: string): string {
  const t = text.trim();
  return t === "" || /[.!?…]$/.test(t) ? t : `${t}.`;
}
