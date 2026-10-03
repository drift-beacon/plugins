import { cn } from "@heroui/theme";
import { motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { SPRING_SNAP } from "../motion.ts";

/** One choice of a segmented control; `preview` turns the choice into a tile with a picture of what it does. */
export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
  readonly icon?: ReactNode;
  readonly preview?: ReactNode;
}

interface SegmentedProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly options: readonly SegmentedOption<T>[];
  onChange(value: T): void;
  readonly className?: string;
}

/**
 * A radio group drawn as a segmented control: the selection slides between choices (a critically damped spring, so
 * it never overshoots), arrow keys move it, and choices with a preview become tiles.
 */
export function Segmented<T extends string>({ label, value, options, onChange, className }: SegmentedProps<T>) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const tiles = options.some((o) => o.preview);

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "relative grid gap-1 rounded-xl bg-default-100 p-1",
        tiles ? "grid-cols-2" : "auto-cols-fr grid-flow-col",
        className,
      )}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            title={o.preview ? undefined : o.hint}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "relative rounded-lg text-sm transition-[color,transform] duration-150 ease-out active:scale-[0.97]",
              tiles
                ? "flex flex-col items-stretch gap-2 p-2 text-left"
                : "flex items-center justify-center gap-1.5 px-3 py-1.5",
              active ? "text-foreground" : "text-default-500 hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId={`segment-${id}`}
                className="absolute inset-0 rounded-lg bg-background shadow-sm ring-1 ring-default-200"
                transition={SPRING_SNAP}
              />
            )}
            {o.preview && <span className="relative block">{o.preview}</span>}
            <span className={cn("relative flex items-center gap-1.5", tiles ? "px-1 font-medium" : "font-medium")}>
              {o.icon}
              {o.label}
            </span>
            {tiles && o.hint && (
              <span className="relative px-1 pb-0.5 text-default-400 text-xs leading-snug">{o.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
