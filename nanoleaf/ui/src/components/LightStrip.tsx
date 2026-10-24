import { cn } from "@heroui/theme";
import { useReducedMotion } from "motion/react";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import { cssRgb, lightOpacity, parseColor, toLedRgb, WARM_WHITE } from "../../../shared/color.ts";
import { ALERT_MS, initialRenderState, isAnimating, renderFrame, withAlert } from "../../../shared/render.ts";
import type { PinnedStyle, RenderState, Rgb, Scene } from "../../../shared/types.ts";

/*
 * The settings' one picture: a strip of Shapes triangles lit by the wall's own renderer (render.ts) and drawn the way
 * the drawing draws light (`lightOpacity`), so each setting looks here as it will on the wall, on the same clock
 * (epoch ms): Glow and Pulse, a pin's goal, the faint track, a schedule's swell (played every few seconds), another
 * plugin's effect.
 */

const SIDE = 22;
const H = (SIDE * Math.sqrt(3)) / 2;

/** `count` triangles side by side, alternating up and down, each shrunk toward its centre so the seams show. */
function strip(count: number): string[] {
  return Array.from({ length: count }, (_, k) => {
    const x = (k * SIDE) / 2;
    const up = k % 2 === 0;
    const corners = up
      ? [
          [x, H],
          [x + SIDE / 2, 0],
          [x + SIDE, H],
        ]
      : [
          [x, 0],
          [x + SIDE, 0],
          [x + SIDE / 2, H],
        ];
    const cx = (corners[0][0] + corners[1][0] + corners[2][0]) / 3;
    const cy = (corners[0][1] + corners[1][1] + corners[2][1]) / 3;
    return corners.map(([px, py]) => `${(cx + (px - cx) * 0.86).toFixed(2)},${(cy + (py - cy) * 0.86).toFixed(2)}`).join(" ");
  });
}

/** How long a schedule's swell waits before playing again in a preview. */
const ALERT_EVERY_MS = ALERT_MS + 1600;

/** A pinned activity's scene for a preview. */
export function pinScene(color: string, style: PinnedStyle, level: number, progress: boolean, track: boolean): Scene {
  return {
    kind: "pinned",
    key: `preview:pin:${style}`,
    activityId: null,
    cssColor: color,
    rgb: toLedRgb(parseColor(color) ?? WARM_WHITE),
    progress: progress
      ? { goal: { type: "count", count: 5 }, period: null, current: 2.2, target: 5, fraction: 0.44 }
      : null,
    level,
    style,
    track,
  };
}

/** A live session part-way to its goal, for a preview. */
export function liveScene(color: string, track: boolean): Scene {
  return {
    kind: "live",
    key: "preview:live",
    activityId: null,
    cssColor: color,
    rgb: toLedRgb(parseColor(color) ?? WARM_WHITE),
    progress: { goal: { type: "duration", seconds: 3600 }, period: null, current: 1500, target: 3600, fraction: 0.42 },
    level: 1,
    style: "glow",
    track,
  };
}

/** Another plugin's effect (Magic Cube's palette shuffling across the panels), for a preview. */
export function pluginScene(): Scene {
  const colors: Rgb[] = [
    [255, 64, 129],
    [64, 196, 255],
    [255, 214, 0],
  ];
  return {
    kind: "control",
    key: "preview:control",
    holder: "magic-cube",
    effect: { id: "preview", type: "shuffle", colors, periodMs: 2400, color: null, startedAt: 0 },
    activityId: null,
    cssColor: "#ff4081",
    rgb: colors[0],
    progress: null,
    level: 1,
    style: "glow",
    track: false,
  };
}

interface LightStripProps {
  readonly scene: Scene;
  /** Swell every few seconds in this colour (a schedule firing); null: never. */
  readonly alert?: string | null;
  readonly count?: number;
  /** Dim the whole strip: what it would show, not what it does now. */
  readonly dim?: boolean;
  readonly className?: string;
}

/** Whether an element is on screen: a preview loop has no reason to run while it's scrolled away. */
function useOnScreen(ref: RefObject<Element | null>): RefObject<boolean> {
  const visible = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      visible.current = entry.isIntersecting;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return visible;
}

/**
 * The strip, drawing through refs from one requestAnimationFrame loop (React state never changes per frame) while it
 * moves and is on screen; a still scene draws once.
 */
export function LightStrip({ scene: given, alert = null, count = 5, dim = false, className }: LightStripProps) {
  const reduced = useReducedMotion() ?? false;
  const svg = useRef<SVGSVGElement>(null);
  const onScreen = useOnScreen(svg);
  // The same scene from a new object (a re-render) keeps the animation going rather than restarting it.
  const sceneKey = JSON.stringify(given);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on what the scene says, not on its identity.
  const scene = useMemo(() => given, [sceneKey]);
  const lights = useRef<(SVGPolygonElement | null)[]>([]);
  const glows = useRef<(SVGPolygonElement | null)[]>([]);
  const panels = useMemo(() => strip(count), [count]);
  const order = useMemo(() => panels.map((_, k) => k), [panels]);
  const alertRgb = useMemo(() => (alert ? toLedRgb(parseColor(alert) ?? WARM_WHITE) : null), [alert]);

  useEffect(() => {
    let frame = 0;
    const t0 = Date.now();
    let state: RenderState = initialRenderState(scene, t0);
    let alertAt = -Infinity;
    const draw = () => {
      const t = Date.now();
      if (alertRgb && !reduced && t - alertAt >= ALERT_EVERY_MS) {
        alertAt = t;
        state = withAlert(state, alertRgb, t + 400);
      }
      const frameLights = renderFrame(state, order, t, { reducedMotion: reduced });
      for (const k of order) {
        const light = frameLights.get(k);
        const fill = light ? cssRgb(light.rgb) : "transparent";
        const opacity = light ? lightOpacity(light.level) : 0;
        lights.current[k]?.setAttribute("fill", fill);
        lights.current[k]?.setAttribute("fill-opacity", opacity.toFixed(3));
        glows.current[k]?.setAttribute("fill", fill);
        glows.current[k]?.setAttribute("fill-opacity", (opacity * 0.9).toFixed(3));
      }
    };
    const loop = () => {
      if (onScreen.current && !document.hidden) draw();
      frame = requestAnimationFrame(loop);
    };
    draw();
    if ((alertRgb && !reduced) || (!reduced && isAnimating(state, t0))) frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [scene, alertRgb, order, reduced, onScreen]);

  const width = (count + 1) * (SIDE / 2);
  return (
    <svg
      ref={svg}
      viewBox={`-6 -6 ${width + 12} ${H + 12}`}
      className={cn("block w-full overflow-visible transition-opacity duration-200", dim && "opacity-40", className)}
      aria-hidden
    >
      <g style={{ filter: "blur(4px)" }}>
        {panels.map((points, k) => (
          <polygon
            key={k}
            ref={(el) => {
              glows.current[k] = el;
            }}
            points={points}
            fillOpacity={0}
          />
        ))}
      </g>
      {panels.map((points, k) => (
        <g key={k}>
          <polygon
            points={points}
            fill="var(--db-surface-raised)"
            stroke="var(--db-border)"
            strokeWidth={0.6}
            strokeLinejoin="round"
          />
          <polygon
            ref={(el) => {
              lights.current[k] = el;
            }}
            points={points}
            fillOpacity={0}
            strokeLinejoin="round"
          />
        </g>
      ))}
    </svg>
  );
}
