import { type RefObject, useLayoutEffect, useRef } from "react";
import { initialRenderState, withPreview } from "../../../shared/render.ts";
import type { Preview, RenderState, Scene } from "../../../shared/types.ts";
import { stepRenderState } from "../lib/renderState.ts";

/** The render state the light loop reads each frame. A ref, so feeding it never re-renders anything. */
export type RenderStateRef = RefObject<RenderState>;

/**
 * Keeps a `RenderState` in step with the scene and the local preview, through the same `advance`/`withPreview` main
 * uses, so the drawing crossfades, shimmers and previews exactly like the wall. Updated before paint, so the next
 * animation frame already sees the change. A new preview object that equals the running sweep restarts it
 * (`stepRenderState`): the caller asked for a fresh sweep (a second save, Play), not a renewal.
 */
export function useRenderState(scene: Scene, preview: Preview | null): RenderStateRef {
  const ref = useRef<RenderState | null>(null);
  const last = useRef<Preview | null>(preview);
  if (ref.current === null) {
    const now = Date.now();
    ref.current = withPreview(initialRenderState(scene, now), preview, now);
  }
  useLayoutEffect(() => {
    const fresh = preview !== last.current;
    last.current = preview;
    ref.current = stepRenderState(ref.current as RenderState, scene, preview, fresh, Date.now());
  }, [scene, preview]);
  return ref as RenderStateRef;
}
