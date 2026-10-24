import { cn } from "@heroui/theme";
import { X } from "lucide-react";
import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cssRgb } from "../../../../shared/color.ts";
import { orderSweep } from "../../../../shared/render.ts";
import { progressPercent } from "../../../../shared/scene.ts";
import type { Rgb } from "../../../../shared/types.ts";

/** Past this many panels the track is one bar: segments would be slivers. */
const MAX_SEGMENTS = 36;

interface ScrubberProps {
  /** Panels in the order (the track's segments). */
  readonly n: number;
  /** The previewed fraction, or null while the drawing shows the real scene. */
  readonly value: number | null;
  /** The order playing over `n` panels (a new `id` is a new play): the track follows its sweep. */
  readonly sweep: { readonly id: number; readonly n: number } | null;
  /** The live goal's fraction, shown at rest so the track mirrors the wall. */
  readonly now: number | null;
  readonly accent: Rgb;
  onChange(fraction: number): void;
  onEnd(): void;
}

/**
 * "Preview a goal": drag from 0 to 100% and the drawing and the wall fill the way they will as a goal closes in. The
 * track is the panels themselves, one segment each, filling like the wall does; "Back to what's live" sits at its end.
 * While the order plays, the track and thumb follow the sweep.
 */
export function Scrubber({ n, value, sweep, now, accent, onChange, onEnd }: ScrubberProps) {
  const id = useId();
  const range = useRef<HTMLInputElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const swept = useSweep(sweep);
  const shown = swept ?? value;
  const active = shown !== null;
  const fraction = Math.min(1, Math.max(0, shown ?? now ?? 0));
  // The shared rounding, so the scrubber and the Now card never disagree by one.
  const percent = progressPercent(shown ?? now ?? 0);
  const segments = Math.min(n, MAX_SEGMENTS);
  const filled = fraction * segments;
  const style = { "--wall-accent": cssRgb(accent) } as CSSProperties;

  // "Back to what's live" is disabled once the preview ends (pressed, or the idle timeout): focus stays with the range.
  useLayoutEffect(() => {
    if (!active && close.current && close.current === document.activeElement) range.current?.focus();
  }, [active]);

  return (
    <div className="space-y-1 @md:px-5 px-4 pt-3 pb-4" style={style}>
      <label htmlFor={id} className="block font-semibold text-[10px] text-default-400 uppercase tracking-wider">
        Preview a goal
      </label>
      <div className="flex items-center gap-3">
        <div className="relative h-8 min-w-0 flex-1">
          {/* The panels as a track, inset by half a thumb so the thumb's centre meets the fill's edge. */}
          <div
            className="pointer-events-none absolute inset-x-[9px] top-1/2 flex h-2 -translate-y-1/2 gap-[3px]"
            aria-hidden
          >
            {Array.from({ length: segments }, (_, k) => {
              const amount = Math.min(1, Math.max(0, filled - k));
              return (
                <span key={k} className="relative h-full flex-1 overflow-hidden rounded-full bg-white/[0.07]">
                  <span
                    className="absolute inset-0 origin-left rounded-full"
                    style={{
                      background: "var(--wall-accent)",
                      opacity: active ? 1 : 0.55,
                      transform: `scaleX(${amount})`,
                      transition: "opacity 200ms ease",
                    }}
                  />
                </span>
              );
            })}
          </div>
          <input
            ref={range}
            id={id}
            type="range"
            min={0}
            max={100}
            step={1}
            value={percent}
            onChange={(e) => onChange(Number(e.currentTarget.value) / 100)}
            aria-valuetext={`${percent}% of the goal`}
            className="wall-range absolute inset-x-0 top-1/2 -translate-y-1/2"
          />
        </div>
        {/* Always there, so the track never changes length; it only wakes while a preview runs. */}
        <button
          ref={close}
          type="button"
          aria-label="Back to what's live"
          title="Back to what's live"
          disabled={!active}
          onClick={() => {
            // It's about to be disabled: keep keyboard focus on the range instead of dropping it to the page.
            range.current?.focus();
            onEnd();
          }}
          className={cn(
            "grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/[0.07] text-default-500",
            "transition-[background-color,color,opacity,transform] duration-150 ease-out",
            "enabled:hover:bg-white/10 enabled:hover:text-foreground enabled:active:scale-[0.94] disabled:opacity-40",
          )}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** The goal a playing sweep shows, frame by frame from when it started (the drawing's sweep starts with it). */
function useSweep(sweep: ScrubberProps["sweep"]): number | null {
  const [swept, setSwept] = useState<number | null>(null);
  const playId = sweep?.id;
  const panels = sweep?.n;
  useEffect(() => {
    if (playId === undefined || panels === undefined) {
      setSwept(null);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = () => {
      setSwept(Math.min(1, orderSweep(panels, performance.now() - start) / panels));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [playId, panels]);
  return swept;
}
