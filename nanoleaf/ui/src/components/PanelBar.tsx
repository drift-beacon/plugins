import { cn } from "@heroui/theme";
import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Scene } from "../../../shared/types.ts";
import { barBrightness, barFill, barMoves } from "./bar-light.ts";
import { tint } from "./tint.ts";

/**
 * Calls `draw(t)` with the drawing's clock (epoch ms, as useLights uses): once whenever `draw` changes, and every
 * animation frame while `moving` and the page is visible. Writes go through refs, never React state.
 */
export function useLightClock(moving: boolean, draw: (t: number) => void): void {
  const latest = useRef(draw);
  useLayoutEffect(() => {
    latest.current = draw;
    draw(Date.now());
  }, [draw]);
  useEffect(() => {
    if (!moving) return;
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (document.visibilityState === "visible") latest.current(Date.now());
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [moving]);
}

interface PanelBarProps {
  /** What the wall shows: its colour, goal, level and motion. */
  readonly scene: Scene;
  /** Panels in the order: one segment each. */
  readonly n: number;
  /** Hold still and grey out: the wall isn't showing this scene, only would. */
  readonly muted?: boolean;
  readonly className?: string;
  /** Optional description for the card’s goal or no-goal context. */
  readonly ariaLabel?: string;
}

/**
 * A thin segmented bar that mirrors the panels in fill order: segment k is as full as panel k (clamp(f·n − k, 0, 1))
 * and as bright as the wall lights it, pulse and breath included, on the drawing's clock (bar-light.ts). Between the
 * 1 s ticks the fill creeps linearly, like time does.
 */
export function PanelBar({ scene, n, muted = false, className, ariaLabel }: PanelBarProps) {
  const reduced = useReducedMotion() ?? false;
  const lights = useRef<(HTMLSpanElement | null)[]>([]);
  const fill = barFill(scene, n);
  const track = scene.track && scene.progress !== null;
  const moving = !muted && !reduced && barMoves(scene, n);

  // Rebuilt when the scene changes (each second while a goal ticks), which redraws once; the loop runs in between.
  const draw = useCallback(
    (t: number) => {
      barBrightness(scene, n, t, reduced || muted).forEach((level, k) => {
        const el = lights.current[k];
        if (el) el.style.opacity = level.toFixed(3);
      });
    },
    [scene, n, reduced, muted],
  );
  useLightClock(moving, draw);

  if (n <= 0) return null;
  const filled = fill.reduce((sum, p) => sum + p, 0);
  return (
    <div
      className={cn(
        "flex h-1.5 w-full transition-[filter,opacity] duration-300",
        n > 24 ? "gap-px" : "gap-[3px]",
        muted && "opacity-50 grayscale",
        className,
      )}
      role="img"
      aria-label={
        ariaLabel ??
        (scene.progress === null ? `All ${n} panels lit` : `${Math.round(filled * 10) / 10} of ${n} panels lit`)
      }
    >
      {fill.map((p, k) => (
        <span
          key={k}
          className="relative flex-1 overflow-hidden rounded-full"
          style={{
            background: track ? tint(scene.cssColor, 0.16) : "hsl(var(--heroui-default-100))",
          }}
        >
          <span
            ref={(el) => {
              lights.current[k] = el;
            }}
            className="absolute inset-0 rounded-full transition-[clip-path] duration-1000 ease-linear"
            style={{
              background: tint(scene.cssColor, 1),
              // A clip rather than scaleX keeps the rounded ends round while the segment fills.
              clipPath: `inset(0 ${Math.round((1 - p) * 1000) / 10}% 0 0 round 999px)`,
            }}
          />
        </span>
      ))}
    </div>
  );
}
