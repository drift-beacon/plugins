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
}

/** The kinds that aren't a direction, as Compass stacks them beside the pad. */
export const KINDS: Record<Exclude<Kind, "sweep">, Choice> = {
  path: { label: "Path", icon: Route },
  shuffle: { label: "Shuffle", icon: Shuffle },
  custom: { label: "My own", icon: Hand },
};

/** The directions, named for the way the light travels. */
export const DIRECTIONS: Record<Direction, Choice> = {
  "left-right": { label: "Right", icon: ArrowRight },
  "right-left": { label: "Left", icon: ArrowLeft },
  "bottom-up": { label: "Up", icon: ArrowUp },
  "top-down": { label: "Down", icon: ArrowDown },
};

export function kindOf(order: PanelOrder): Kind {
  if (order.mode === "random") return "shuffle";
  if (order.mode === "custom") return "custom";
  return order.auto === "path" ? "path" : "sweep";
}

export function directionOf(order: PanelOrder): Direction | null {
  return order.mode === "auto" && order.auto !== "path" ? order.auto : null;
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
