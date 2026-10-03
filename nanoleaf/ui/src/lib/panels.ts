import { shapeLabel } from "../../../shared/geometry.ts";
import type { AutoOrder } from "../../../shared/types.ts";

/** How a panel is named in lists and announcements: its shape and the id the controller (and Nanoleaf app) uses. */
export function panelName(panel: { readonly shapeType: number; readonly id: number }): string {
  return `${shapeLabel(panel.shapeType)} ${panel.id}`;
}

/** The automatic orders, in the order the editor offers them. */
export const AUTO_ORDERS: readonly { readonly id: AutoOrder; readonly label: string; readonly hint: string }[] = [
  { id: "path", label: "Path", hint: "Walks from each panel to a neighbour, so the fill reads as one line" },
  { id: "left-right", label: "Left → right", hint: "Sweeps across the drawing from the left" },
  { id: "right-left", label: "Right → left", hint: "Sweeps across the drawing from the right" },
  { id: "bottom-up", label: "Bottom → top", hint: "Rises from the bottom, like a glass filling up" },
  { id: "top-down", label: "Top → bottom", hint: "Pours down from the top" },
];

/** A fresh seed for a random order: a positive 31-bit integer, never the one it replaces. */
export function nextSeed(previous: number, random: () => number = Math.random): number {
  let seed = previous;
  while (seed === previous) seed = 1 + Math.floor(random() * 0x7ffffffe);
  return seed;
}
