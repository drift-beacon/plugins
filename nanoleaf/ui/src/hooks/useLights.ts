import { useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { isAnimating, renderFrame } from "../../../shared/render.ts";
import type { PanelLight, RenderState } from "../../../shared/types.ts";
import type { RenderStateRef } from "./useRenderState.ts";

/**
 * Draws one frame: every ordered panel's light at time `t` (epoch ms). It writes DOM attributes through refs and never
 * sets React state. A new function (new drawing) forces a redraw.
 */
export type FrameWriter = (lights: ReadonlyMap<number, PanelLight>, t: number) => void;

/**
 * The one light loop: a `requestAnimationFrame` loop that runs the shared `renderFrame` over `order` and hands the
 * result to `onFrame`. It skips frames while nothing moves (drawing once more as motion ends, so the last frame is
 * exact), pauses while the document is hidden, and passes the user's reduced-motion preference to the renderer.
 */
export function useLights(stateRef: RenderStateRef, order: readonly number[], onFrame: FrameWriter): void {
  const reduced = useReducedMotion() ?? false;
  const latest = useRef({ order, onFrame, reduced });
  useLayoutEffect(() => {
    latest.current = { order, onFrame, reduced };
  }, [order, onFrame, reduced]);

  useEffect(() => {
    let raf = 0;
    let drawn: { state: RenderState | null; order: unknown; onFrame: unknown; reduced: boolean } = {
      state: null,
      order: null,
      onFrame: null,
      reduced: false,
    };
    let moving = false;

    const draw = () => {
      const { order, onFrame, reduced } = latest.current;
      const state = stateRef.current;
      const t = Date.now();
      const changed =
        state !== drawn.state || order !== drawn.order || onFrame !== drawn.onFrame || reduced !== drawn.reduced;
      const animating = isAnimating(state, t);
      // One more frame after motion stops lands every panel exactly on its resting value.
      if (!changed && !animating && !moving) return;
      moving = animating;
      drawn = { state, order, onFrame, reduced };
      onFrame(renderFrame(state, order, t, { reducedMotion: reduced }), t);
    };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      draw();
    };
    const start = () => {
      if (raf === 0 && document.visibilityState === "visible") raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());

    document.addEventListener("visibilitychange", onVisibility);
    // Paint the first frame now, visible or not, so the drawing is never blank while the loop waits.
    draw();
    start();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [stateRef]);
}
