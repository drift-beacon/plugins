import { motion } from "motion/react";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { cx } from "../lib/cx.ts";
import { SPRING_SNAP } from "../motion.ts";

interface SegmentedProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  onChange(value: T): void;
  readonly className?: string;
}

/**
 * A radio group drawn as a segmented control, as the siblings draw theirs: one tab stop, arrow keys (and Home, End)
 * move the choice, and the highlight slides on a critically damped spring. A keyboard change jumps instead of
 * sliding, since the eye is already where focus went.
 */
export function Segmented<T extends string>({ label, value, options, onChange, className }: SegmentedProps<T>) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [keyboard, setKeyboard] = useState(false);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const last = options.length - 1;
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? (index + 1) % options.length
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? (index + last) % options.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setKeyboard(true);
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={label} className={cx("relative flex w-fit rounded-full bg-default-100 p-1", className)}>
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={(event) => {
              setKeyboard(event.detail === 0);
              onChange(option.value);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cx(
              "cp-press cp-touch relative rounded-full px-3 py-1.5 text-xs font-medium",
              active ? "text-foreground" : "text-default-500 hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId={`segment-${id}`}
                className="absolute inset-0 rounded-full bg-background shadow-sm ring-1 ring-default-200"
                transition={keyboard ? { duration: 0 } : SPRING_SNAP}
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
