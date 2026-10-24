import { cn } from "@heroui/theme";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { mulberry32 } from "../../../shared/order.ts";
import type { Rgb } from "../../../shared/types.ts";

interface Star {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly base: number;
  readonly speed: number;
  readonly phase: number;
  /** A few are brighter, with a soft halo. */
  readonly bright: boolean;
}

/** Stars for a box of `w` × `h` CSS px: about `density` per 10,000 px², the same sky for the same seed. */
function makeStars(w: number, h: number, density: number, seed: number): Star[] {
  const random = mulberry32(seed);
  const count = Math.round(((w * h) / 10_000) * density);
  return Array.from({ length: count }, () => {
    const bright = random() < 0.08;
    return {
      x: random() * w,
      y: random() * h,
      r: bright ? 1.3 + random() * 0.8 : 0.55 + random() * 0.6,
      base: bright ? 0.85 + random() * 0.15 : 0.4 + random() * 0.45,
      // Slow: 3 to 9 s a twinkle, never in step.
      speed: (Math.PI * 2) / (3000 + random() * 6000),
      phase: random() * Math.PI * 2,
      bright,
    };
  });
}

interface StarfieldProps {
  /** Stars per 10,000 px². */
  readonly density?: number;
  readonly seed?: number;
  /** The wall's light: stars near `glow` take this colour, more the nearer they are. */
  readonly tint?: Rgb | null;
  /** Where the light is, as fractions of the box (the drawing's middle). */
  readonly glow?: { readonly x: number; readonly y: number; readonly radius: number };
  /** 0 to 1: how bright the sky's stars are overall (the wall's brightness, for a lit sky). */
  readonly intensity?: number;
  readonly className?: string;
}

/**
 * A night sky drawn on a canvas: small stars that twinkle slowly and out of step (a sine on each one's opacity), a few
 * brighter ones with a halo. Still under reduced motion, paused while the page is hidden.
 */
export function Starfield({ density = 2.2, seed = 7, tint = null, glow, intensity = 1, className }: StarfieldProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion() ?? false;
  const live = useRef({ tint, glow, intensity });
  live.current = { tint, glow, intensity };

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    let stars: Star[] = [];
    let w = 0;
    let h = 0;
    const size = () => {
      const box = el.getBoundingClientRect();
      w = box.width;
      h = box.height;
      const dpr = window.devicePixelRatio || 1;
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = makeStars(w, h, density, seed);
    };
    const draw = (t: number) => {
      const { tint: rgb, glow: at, intensity: k } = live.current;
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        const twinkle = reduced ? 0.8 : 0.5 + 0.5 * Math.sin(t * s.speed + s.phase);
        let near = 0;
        if (rgb && at) {
          const dx = s.x / w - at.x;
          const dy = (s.y / h - at.y) * (h / w);
          near = Math.max(0, 1 - Math.hypot(dx, dy) / at.radius);
        }
        const a = Math.min(1, s.base * twinkle * (0.55 + 0.45 * k) * (1 + near * 0.6));
        const c: Rgb = rgb
          ? [255 + (rgb[0] - 255) * near, 255 + (rgb[1] - 255) * near, 255 + (rgb[2] - 255) * near]
          : [255, 255, 255];
        const css = `${Math.round(c[0])} ${Math.round(c[1])} ${Math.round(c[2])}`;
        if (s.bright) {
          const halo = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 6);
          halo.addColorStop(0, `rgb(${css} / ${a * 0.45})`);
          halo.addColorStop(1, `rgb(${css} / 0)`);
          ctx.fillStyle = halo;
          ctx.fillRect(s.x - s.r * 6, s.y - s.r * 6, s.r * 12, s.r * 12);
        }
        ctx.fillStyle = `rgb(${css} / ${a})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    size();
    const observer = new ResizeObserver(() => {
      size();
      draw(Date.now());
    });
    observer.observe(el);
    let frame = 0;
    const loop = () => {
      // Hidden (another tab of the phone layout) it has no size: nothing to draw.
      if (!document.hidden && w > 0 && h > 0) draw(Date.now());
      frame = requestAnimationFrame(loop);
    };
    draw(Date.now());
    if (!reduced) frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [density, seed, reduced]);

  return <canvas ref={canvas} aria-hidden className={cn("pointer-events-none absolute inset-0 h-full w-full", className)} />;
}
