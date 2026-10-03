import { useReducedMotion } from "motion/react";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import { cssRgb, lightOpacity, parseColor, toLedRgb, WARM_WHITE } from "../../../shared/color.ts";
import { initialRenderState, isAnimating, renderFrame } from "../../../shared/render.ts";
import type { PinnedStyle, Scene } from "../../../shared/types.ts";

const SIDE = 22;
const H = (SIDE * Math.sqrt(3)) / 2;
const ORDER = [0, 1, 2];

/** Three triangles in a strip (up, down, up), each shrunk toward its centre so the seams show. */
const PANELS = [
  [
    [0, H],
    [SIDE / 2, 0],
    [SIDE, H],
  ],
  [
    [SIDE / 2, 0],
    [SIDE * 1.5, 0],
    [SIDE, H],
  ],
  [
    [SIDE, H],
    [SIDE * 1.5, 0],
    [SIDE * 2, H],
  ],
].map((corners) => {
  const cx = (corners[0][0] + corners[1][0] + corners[2][0]) / 3;
  const cy = (corners[0][1] + corners[1][1] + corners[2][1]) / 3;
  return corners.map(([x, y]) => `${(cx + (x - cx) * 0.84).toFixed(2)},${(cy + (y - cy) * 0.84).toFixed(2)}`).join(" ");
});

interface PinnedPreviewProps {
  readonly style: PinnedStyle;
  /** 0–1: the pinned brightness. */
  readonly level: number;
  readonly color: string;
  /** Show a goal part-way through (Show goal progress). */
  readonly progress: boolean;
  readonly track: boolean;
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
 * Three tiny panels lit by the wall's own renderer (render.ts) and drawn the way the drawing draws light
 * (`lightOpacity`), so Glow and Pulse look here as they will on the wall, on the same clock (epoch ms), so a pulse
 * here keeps step with the wall's. It draws through refs from one requestAnimationFrame loop, never through React
 * state; a glow is still, so it draws once.
 */
export function PinnedPreview({ style, level, color, progress, track }: PinnedPreviewProps) {
  const reduced = useReducedMotion() ?? false;
  const svg = useRef<SVGSVGElement>(null);
  const lights = useRef<(SVGPolygonElement | null)[]>([]);
  const glows = useRef<(SVGPolygonElement | null)[]>([]);
  const onScreen = useOnScreen(svg);

  const state = useMemo(() => {
    const scene: Scene = {
      kind: "pinned",
      key: `preview:${style}`,
      activityId: null,
      cssColor: color,
      rgb: toLedRgb(parseColor(color) ?? WARM_WHITE),
      progress: progress
        ? { goal: { type: "count", count: 3 }, period: null, current: 1.65, target: 3, fraction: 0.55 }
        : null,
      level,
      style,
      track,
    };
    return initialRenderState(scene, 0);
  }, [style, level, color, progress, track]);

  useEffect(() => {
    let frame = 0;
    const draw = (t: number) => {
      const frameLights = renderFrame(state, ORDER, t, { reducedMotion: reduced });
      ORDER.forEach((k) => {
        const light = frameLights.get(k);
        const fill = light ? cssRgb(light.rgb) : "transparent";
        const opacity = light ? lightOpacity(light.level) : 0;
        lights.current[k]?.setAttribute("fill", fill);
        lights.current[k]?.setAttribute("fill-opacity", opacity.toFixed(3));
        glows.current[k]?.setAttribute("fill", fill);
        glows.current[k]?.setAttribute("fill-opacity", (opacity * 0.9).toFixed(3));
      });
    };
    const loop = () => {
      if (onScreen.current && !document.hidden) draw(Date.now());
      frame = requestAnimationFrame(loop);
    };
    const t0 = Date.now();
    draw(t0);
    if (!reduced && isAnimating(state, t0)) frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [state, reduced, onScreen]);

  return (
    <svg
      ref={svg}
      viewBox={`-6 -6 ${SIDE * 2 + 12} ${H + 12}`}
      className="h-14 w-full overflow-visible rounded-lg bg-content1"
      aria-hidden
    >
      <g style={{ filter: "blur(4px)" }}>
        {PANELS.map((points, k) => (
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
      {PANELS.map((points, k) => (
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
