import { useMemo, useSyncExternalStore } from "react";
import type { Preview, Rgb } from "../../../shared/types.ts";
import { drawnLevel, wallBrightness } from "../lib/brightness.ts";
import { useModel } from "../model.ts";
import { useScene } from "./useScene.ts";

/** A brightness slider being dragged: its value, and the colour its preview shows in (null: what shows). */
export interface BrightnessDrag {
  readonly value: number;
  readonly rgb: Rgb | null;
}

// One interface per iframe: the sliders and the drawings share this, wherever the layout puts them.
let drag: BrightnessDrag | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Tap to order holds the wall: the brightness sliders leave it alone (no preview, no override) until it ends. */
let drafting = false;
const draftListeners = new Set<() => void>();
const subscribeDrafting = (listener: () => void) => {
  draftListeners.add(listener);
  return () => draftListeners.delete(listener);
};

/** Says tap to order started or ended. */
export function setDrafting(next: boolean): void {
  if (drafting === next) return;
  drafting = next;
  for (const listener of draftListeners) listener();
}

/** Whether tap to order holds the wall now. */
export function useDrafting(): boolean {
  return useSyncExternalStore(
    subscribeDrafting,
    () => drafting,
    () => false,
  );
}

/** Says a brightness slider is being dragged (null once it lets go), for the drawings to preview it too. */
export function setBrightnessDrag(next: BrightnessDrag | null): void {
  if (drag?.value === next?.value && drag?.rgb === next?.rgb) return;
  drag = next;
  for (const listener of listeners) listener();
}

/**
 * How a drawing lights the wall: the preview it shows over the scene (a dragged brightness slider's full fill, else
 * `local`, the drawing's own) and the `level` to draw light at, from the brightness the wall is driven at.
 */
export function useDrawnLight(local: Preview | null): { readonly preview: Preview | null; readonly level: number } {
  const { settings } = useModel();
  const scene = useScene();
  const dragged = useSyncExternalStore(
    subscribe,
    () => drag,
    () => null,
  );
  const dragging = dragged !== null;
  const rgb = dragged?.rgb ?? null;
  // Its own object only when the drag starts or changes colour: the value alone changes the level, not the preview.
  const fill = useMemo<Preview | null>(() => (dragging ? { mode: "fill", fraction: 1, rgb } : null), [dragging, rgb]);
  const preview = fill ?? local;
  const level = drawnLevel(
    wallBrightness(settings, scene.kind === "pinned", preview?.mode ?? null, dragged?.value ?? null),
  );
  return { preview, level };
}
