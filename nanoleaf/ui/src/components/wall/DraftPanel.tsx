import { Button } from "@heroui/react";
import { Check, Eraser, Hand, MousePointerClick, Undo2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { cssRgb } from "../../../../shared/color.ts";
import type { Rgb } from "../../../../shared/types.ts";
import { Odometer } from "./Odometer.tsx";

/** A button with nothing to do yet: faded and inert, but still focusable. */
const EMPTY = "aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:active:scale-100";

/** Where the taps come from: the drawing, or the panels on the wall (touch events). */
export type DraftSource = "stage" | "wall";

interface DraftPanelProps {
  readonly source: DraftSource;
  /** Panels numbered so far. */
  readonly count: number;
  readonly total: number;
  readonly accent: Rgb;
  /** Take focus on arrival: the button that started tap to order is gone (unless a panel on the drawing took it). */
  readonly autoFocus?: boolean;
  onUndo(): void;
  onReset(): void;
  onCancel(): void;
  onDone(): void;
}

/**
 * Tap to order, the editor's side: what to do, how far along ("3 of 8"), and Undo / Start over / Cancel / Done.
 * Backspace undoes and Escape cancels, from anywhere but a text field. Undo, Start over and Done stay focusable when
 * there is nothing to act on (aria-disabled), so undoing down to zero never drops keyboard focus to the page.
 */
export function DraftPanel(props: DraftPanelProps) {
  const { source, count, total, accent, autoFocus, onUndo, onReset, onCancel, onDone } = props;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) root.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "Escape") onCancel();
      else if (e.key === "Backspace" && count > 0) {
        e.preventDefault();
        onUndo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, onCancel, onUndo]);

  const wall = source === "wall";
  const left = total - count;
  return (
    <div
      ref={root}
      tabIndex={-1}
      role="group"
      aria-label={wall ? "Tap on your wall" : "Tap to order"}
      className="space-y-4 outline-none"
    >
      <div className="flex items-start gap-3">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
          style={{ background: cssRgb(accent, 0.16), color: cssRgb(accent) }}
        >
          {wall ? <Hand className="wall-tap h-5 w-5" /> : <MousePointerClick className="h-5 w-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[10px] text-default-400 uppercase tracking-wider">
            {wall ? "Tap on your wall" : "Tap to order"}
          </div>
          <div className="text-sm leading-snug">
            {wall
              ? "Touch each panel on the wall once, in the order it should fill."
              : "Tap the panels in the order they should fill."}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <span className="font-bold text-2xl leading-none">
            <Odometer value={count} />
          </span>
          <span className="text-default-500 text-sm tabular-nums"> of {total}</span>
        </div>
      </div>

      <div className="flex h-1.5 gap-[3px]" aria-hidden>
        {Array.from({ length: Math.min(total, 48) }, (_, k) => (
          <span key={k} className="relative flex-1 overflow-hidden rounded-full bg-default-200">
            <span
              className="absolute inset-0 origin-left rounded-full"
              style={{
                background: cssRgb(accent),
                transform: `scaleX(${k < (count * Math.min(total, 48)) / total ? 1 : 0})`,
                transition: "transform 220ms cubic-bezier(0.23, 1, 0.32, 1)",
              }}
            />
          </span>
        ))}
      </div>

      {/* Two groups, so on a narrow column Cancel and Done wrap together and stay on the right. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="flat"
            radius="lg"
            startContent={<Undo2 className="h-4 w-4" />}
            aria-disabled={count === 0}
            className={EMPTY}
            onPress={() => count > 0 && onUndo()}
          >
            Undo
          </Button>
          <Button
            size="sm"
            variant="light"
            radius="lg"
            startContent={<Eraser className="h-4 w-4" />}
            aria-disabled={count === 0}
            className={EMPTY}
            onPress={() => count > 0 && onReset()}
          >
            Start over
          </Button>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="light" radius="lg" onPress={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            color="primary"
            radius="lg"
            startContent={<Check className="h-4 w-4" />}
            aria-disabled={count === 0}
            className={EMPTY}
            onPress={() => count > 0 && onDone()}
          >
            Done
          </Button>
        </div>
      </div>
      <p className="text-default-500 text-xs">
        {count > 0 && left > 0
          ? `Done adds the ${left} ${left === 1 ? "panel" : "panels"} you haven't tapped at the end, in path order.`
          : wall
            ? "You can tap the drawing too. Backspace undoes, Escape cancels."
            : "Backspace undoes, Escape cancels."}
      </p>
    </div>
  );
}
