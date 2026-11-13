import { useReducedMotion } from "motion/react";
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { isAnimating } from "../../../shared/render.ts";
import type { PanelLight } from "../../../shared/types.ts";
import { renderZones, type ZoneStates } from "../../../shared/zone-render.ts";
import type { ZoneFill } from "../../../shared/zones.ts";

/**
 * Draws one frame: every lit panel's light at time `t` (epoch ms). It writes DOM attributes through refs and never
 * sets React state. A new function (new drawing) forces a redraw.
 */
export type FrameWriter = (lights: ReadonlyMap<number, PanelLight>, t: number) => void;

/**
 * What the light loop draws: each zone's render state over its own fill (zones.ts `zoneFills`), merged into one frame
 * (`renderZones`). One zone is the whole wall, light for light as the engine drew it before zones.
 */
export interface LightSource {
  readonly states: ZoneStates;
  readonly fills: readonly ZoneFill[];
  /** Each zone's level scale (lib/zones.ts `zoneLevels`); null draws every zone at 1. */
  readonly scales: ReadonlyMap<string, number> | null;
  /** Draw only this zone, the others dark (tap to order on a split wall). */
  readonly only: string | null;
}

/** The light source the loop reads each frame. A ref, so feeding it never re-renders anything. */
export type LightSourceRef = RefObject<LightSource>;

function animating(states: ZoneStates, t: number): boolean {
  for (const state of states.values()) if (isAnimating(state, t)) return true;
  return false;
}

/**
 * The one light loop: a `requestAnimationFrame` loop that runs the shared `renderZones` over the source and hands the
 * result to `onFrame`. It skips frames while nothing moves (drawing once more as motion ends, so the last frame is
 * exact), pauses while the document is hidden, and passes the user's reduced-motion preference to the renderer.
 */
export function useLights(sourceRef: LightSourceRef, onFrame: FrameWriter): void {
  const reduced = useReducedMotion() ?? false;
  const latest = useRef({ onFrame, reduced });
  useLayoutEffect(() => {
    latest.current = { onFrame, reduced };
  }, [onFrame, reduced]);

  useEffect(() => {
    let raf = 0;
    let drawn: { source: LightSource | null; onFrame: unknown; reduced: boolean } = {
      source: null,
      onFrame: null,
      reduced: false,
    };
    let moving = false;

    const draw = () => {
      const { onFrame, reduced } = latest.current;
      const source = sourceRef.current;
      const t = Date.now();
      const changed = source !== drawn.source || onFrame !== drawn.onFrame || reduced !== drawn.reduced;
      const now = animating(source.states, t);
      // One more frame after motion stops lands every panel exactly on its resting value.
      if (!changed && !now && !moving) return;
      moving = now;
      drawn = { source, onFrame, reduced };
      onFrame(
        renderZones(source.states, source.fills, t, {
          reducedMotion: reduced,
          scales: source.scales,
          only: source.only,
        }),
        t,
      );
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
  }, [sourceRef]);
}
