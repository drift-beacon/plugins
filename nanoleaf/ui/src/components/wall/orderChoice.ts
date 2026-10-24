import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Hand, type LucideIcon, Route, Shuffle } from "lucide-react";
import type { AutoOrder, OrderMode, PanelOrder } from "../../../../shared/types.ts";

/*
 * The fill order as what it is: one choice of how a goal's fill travels, of four kinds. The wall's own path, a sweep
 * in one of four directions, a shuffle (rolled again on purpose), and your own order (made by tapping the drawing or
 * touching the wall).
 */

export type Kind = "path" | "sweep" | "shuffle" | "custom";
export type Direction = Exclude<AutoOrder, "path">;

interface Choice {
  readonly label: string;
  readonly icon: LucideIcon;
  /** What it does, in one sentence. */
  readonly hint: string;
}

/** The kinds that aren't a direction, as Compass stacks them beside the pad. */
export const KINDS: Record<Exclude<Kind, "sweep">, Choice> = {
  path: { label: "Path", icon: Route, hint: "Walks from each panel to a neighbour, so the fill reads as one line." },
  shuffle: { label: "Shuffle", icon: Shuffle, hint: "A fresh mix of the panels. Press Shuffle again for another." },
  custom: { label: "My own", icon: Hand, hint: "The panels in the order you choose, one by one." },
};

/** The directions, named for the way the light travels. */
export const DIRECTIONS: Record<Direction, Choice> = {
  "left-right": { label: "Right", icon: ArrowRight, hint: "Sweeps across from the left." },
  "right-left": { label: "Left", icon: ArrowLeft, hint: "Sweeps across from the right." },
  "bottom-up": { label: "Up", icon: ArrowUp, hint: "Rises from the bottom, like a glass filling up." },
  "top-down": { label: "Down", icon: ArrowDown, hint: "Pours down from the top." },
};

export function kindOf(order: PanelOrder): Kind {
  if (order.mode === "random") return "shuffle";
  if (order.mode === "custom") return "custom";
  return order.auto === "path" ? "path" : "sweep";
}

export function directionOf(order: PanelOrder): Direction | null {
  return order.mode === "auto" && order.auto !== "path" ? order.auto : null;
}

/** The chosen order's name, as the line under the compass says it. */
export function nameFor(order: PanelOrder): string {
  const direction = directionOf(order);
  if (direction) return `Sweep ${DIRECTIONS[direction].label.toLowerCase()}`;
  const kind = kindOf(order);
  return kind === "sweep" ? "Sweep" : KINDS[kind].label;
}

/** What the chosen order does, in one sentence (a sweep: two, the second saying how it fills). */
export function hintFor(order: PanelOrder): string {
  const direction = directionOf(order);
  if (direction) {
    const fill = order.sweepFill === "line" ? "A straight edge crosses the wall, as far as the goal has got." : "One panel at a time.";
    return `${DIRECTIONS[direction].hint} ${fill}`;
  }
  const kind = kindOf(order);
  if (kind === "custom" && order.ids.length === 0) return "Not made yet: number the panels yourself.";
  return kind === "sweep" ? "" : KINDS[kind].hint;
}

interface ChoiceHandlers {
  onMode(mode: OrderMode): void;
  onAuto(auto: AutoOrder): void;
  onShuffle(): void;
}

/**
 * Choosing by kind and direction. Choosing what's already chosen does nothing, but Shuffle: chosen again, it rolls a
 * fresh mix.
 */
export function orderChoice(order: PanelOrder, handlers: ChoiceHandlers) {
  const kind = kindOf(order);
  const direction = directionOf(order);
  return {
    kind,
    direction,
    chooseKind(next: Exclude<Kind, "sweep">) {
      if (next === kind) {
        if (next === "shuffle") handlers.onShuffle();
        return;
      }
      if (next === "path") handlers.onAuto("path");
      else if (next === "shuffle") handlers.onShuffle();
      else handlers.onMode("custom");
    },
    chooseDirection(next: Direction) {
      if (next !== direction) handlers.onAuto(next);
    },
  };
}
