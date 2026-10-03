import { Switch } from "@heroui/react";
import { cn } from "@heroui/theme";
import { X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type CSSProperties, useId, useLayoutEffect, useRef } from "react";
import { cssRgb } from "../../../../shared/color.ts";
import type { Rgb } from "../../../../shared/types.ts";
import { EASE_OUT } from "../../motion.ts";
import { scrubberReadout } from "./readout.ts";

/** Past this many panels the track is one bar: segments would be slivers. */
const MAX_SEGMENTS = 36;

interface ScrubberProps {
  /** Panels in the order (the track's segments). */
  readonly n: number;
  /** The previewed fraction, or null while the drawing shows the real scene. */
  readonly value: number | null;
  /** The live goal's fraction, shown at rest so the track mirrors the wall. */
  readonly now: number | null;
  readonly accent: Rgb;
  /** The controller is connected, so the wall can show the preview too. */
  readonly canWall: boolean;
  readonly onWall: boolean;
  onChange(fraction: number): void;
  onEnd(): void;
  onWallChange(on: boolean): void;
}

/**
 * "Preview a goal": drag from 0 to 100% and the drawing (and, with Show on wall, the wall) fills the way it will as a
 * goal closes in. The track is the panels themselves, one segment each, filling like the wall does.
 */
export function Scrubber({ n, value, now, accent, canWall, onWall, onChange, onEnd, onWallChange }: ScrubberProps) {
  const id = useId();
  const reduced = useReducedMotion();
  const range = useRef<HTMLInputElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const active = value !== null;
  const fraction = Math.min(1, Math.max(0, value ?? now ?? 0));
  const readout = scrubberReadout(value, now, n);
  const percent = readout.percent;
  const segments = Math.min(n, MAX_SEGMENTS);
  const filled = fraction * segments;
  const style = { "--wall-accent": cssRgb(accent) } as CSSProperties;

  // "Back to what's live" leaves as the preview ends (pressed, or the idle timeout): focus stays with the range.
  useLayoutEffect(() => {
    if (!active && close.current && close.current === document.activeElement) range.current?.focus();
  }, [active]);
  const closeMotion = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0, transition: { duration: 0.12 } } }
    : {
        initial: { opacity: 0, transform: "scale(0.8)" },
        animate: { opacity: 1, transform: "scale(1)" },
        exit: { opacity: 0, transform: "scale(0.8)", transition: { duration: 0.12, ease: EASE_OUT } },
      };

  return (
    <div className="space-y-2 @md:px-5 px-4 pt-3 pb-4" style={style}>
      <div className="flex min-h-8 items-center gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="block font-semibold text-[10px] text-default-400 uppercase tracking-wider">
            Preview a goal
          </label>
          <div className="flex h-5 items-center gap-x-2">
            {/* While previewing, both readouts hold their widest width, so the close button stays put on a drag. */}
            <label
              htmlFor={id}
              className={cn(
                "inline-grid font-semibold text-sm tabular-nums",
                active ? "text-foreground" : "text-default-500",
              )}
            >
              {active && (
                <span className="invisible col-start-1 row-start-1" aria-hidden>
                  100%
                </span>
              )}
              <span className="col-start-1 row-start-1">{readout.value ?? "Drag to try it"}</span>
            </label>
            {readout.caption !== null && (
              <label htmlFor={id} className="inline-grid whitespace-nowrap text-default-500 text-xs tabular-nums">
                {active && (
                  <span className="invisible col-start-1 row-start-1" aria-hidden>
                    panel {n} of {n} filling
                  </span>
                )}
                <span className="col-start-1 row-start-1">{readout.caption}</span>
              </label>
            )}
            <AnimatePresence initial={false}>
              {active && (
                <motion.button
                  ref={close}
                  type="button"
                  aria-label="Back to what's live"
                  title="Back to what's live"
                  onClick={() => {
                    // Its button is about to leave: keep keyboard focus on the range instead of dropping it to the page.
                    range.current?.focus();
                    onEnd();
                  }}
                  {...closeMotion}
                  transition={{ duration: 0.18, ease: EASE_OUT }}
                  className={cn(
                    "grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/5 text-default-400 transition-colors",
                    "duration-150 hover:bg-white/10 hover:text-foreground",
                  )}
                >
                  <X className="h-3 w-3" />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>
        {canWall && (
          <Switch
            size="sm"
            isSelected={onWall}
            onValueChange={onWallChange}
            classNames={{ label: "text-xs text-default-500" }}
          >
            Show on wall
          </Switch>
        )}
      </div>

      <div className="relative h-7">
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
          className="wall-range absolute inset-0"
        />
      </div>
    </div>
  );
}
