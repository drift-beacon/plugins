import type { AutoOrder, OrderMode, PanelOrder } from "../../../../shared/types.ts";

/*
 * How the editor's choices change the saved order. `ids` holds the hand-made (custom) order and survives a switch to
 * Auto or Random, which ignore it (order.ts resolveOrder), so choosing Custom again brings the hand-made order back.
 */

/** A hand-made order of `ids`, keeping the auto kind and seed for when the user switches back. */
export function customOrder(saved: PanelOrder, ids: readonly number[]): PanelOrder {
  return { mode: "custom", auto: saved.auto, seed: saved.seed, ids: [...ids] };
}

/**
 * The order after choosing `mode`. Custom restores the kept hand-made order, or, when there is none, freezes the
 * order showing now (`showing`) so nothing moves. Auto and Random keep `ids` untouched.
 */
export function orderForMode(saved: PanelOrder, mode: OrderMode, showing: readonly number[]): PanelOrder {
  if (mode === saved.mode) return saved;
  if (mode !== "custom") return { ...saved, mode };
  return saved.ids.length > 0 ? { ...saved, mode: "custom" } : customOrder(saved, showing);
}

/** An automatic order of `auto`, keeping any hand-made order for later. */
export function orderForAuto(saved: PanelOrder, auto: AutoOrder): PanelOrder {
  return { ...saved, mode: "auto", auto };
}

/** A random order from `seed`, keeping any hand-made order for later. */
export function orderForShuffle(saved: PanelOrder, seed: number): PanelOrder {
  return { ...saved, mode: "random", seed };
}

/** Whether choosing `mode` sets a hand-made order aside (worth an undo, though Custom brings it back too). */
export function leavesCustom(saved: PanelOrder, mode: OrderMode): boolean {
  return saved.mode === "custom" && mode !== "custom";
}
