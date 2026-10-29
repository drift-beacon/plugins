import { cn } from "@heroui/theme";
import { MousePointerClick } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import type { AutoOrder, OrderMode, PanelOrder, SweepFill } from "../../../../shared/types.ts";
import { rovingStep } from "../../lib/roving.ts";
import { EASE_OUT } from "../../motion.ts";
import { type Direction, DIRECTIONS, type Kind, KINDS, orderChoice } from "./orderChoice.ts";

/** The pad's cells, by row: the arrows where they point, the middle left as the wall the light crosses. */
const PAD: readonly (Direction | "centre" | null)[] = [
  null,
  "bottom-up",
  null,
  "right-left",
  "centre",
  "left-right",
  null,
  "top-down",
  null,
];

const OTHERS: readonly Exclude<Kind, "sweep">[] = ["path", "shuffle", "custom"];

type ChoiceId = Exclude<Kind, "sweep"> | Direction;
/** The seven as one radio group, in the order the arrow keys walk them: the three kinds, then the pad by reading. */
const ROVING: readonly ChoiceId[] = ["path", "shuffle", "custom", "bottom-up", "right-left", "left-right", "top-down"];
const isDirection = (id: ChoiceId): id is Direction => id in DIRECTIONS;

const PICKED = "bg-foreground text-background";
const IDLE = "bg-default-100 text-default-600 hover:bg-default-200";
/** An action that belongs to a choice: quieter than a choice, so it never reads as one. */
const ACTION =
  "flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-default-100 px-3.5 font-medium text-sm transition-[background-color,transform] duration-150 ease-out hover:bg-default-200 active:scale-[0.97]";

interface CompassProps {
  readonly order: PanelOrder;
  /** Tap to order just ended: its button takes keyboard focus back once it's here. */
  readonly refocus: boolean;
  onMode(mode: OrderMode): void;
  onAuto(auto: AutoOrder): void;
  onShuffle(): void;
  /** A sweep fills as a line or one panel at a time (the pad's centre). */
  onSweepFill(fill: SweepFill): void;
  /** The chosen direction pressed again: play the order once. */
  onPreview(): void;
  /** Start tap to order; `keyboard` when the button was pressed from the keyboard (focus then goes to a panel). */
  onDraft(keyboard: boolean): void;
  onRefocused(): void;
}

/**
 * The fill order as a compass: a sweep's direction drawn as a direction. The four arrows sit on a cross where they
 * point, the way a sweep fills in the middle (as a line, or one panel at a time); Path, Shuffle and My own stack
 * beside it. A chosen arrow pressed again plays the order, and Shuffle pressed again rolls a fresh mix. Under both,
 * for My own only, the button that starts numbering the panels.
 */
export function Compass(props: CompassProps) {
  const { order, refocus, onRefocused } = props;
  const reduced = useReducedMotion();
  const choice = orderChoice(order, props);
  const chosen: ChoiceId = choice.direction ?? (choice.kind === "sweep" ? "left-right" : choice.kind);
  const pick = (id: ChoiceId) => (isDirection(id) ? choice.chooseDirection(id) : choice.chooseKind(id));

  // Roving focus (WAI-ARIA radio group): one Tab stop, the chosen order; the arrows, Home and End move the choice and
  // focus together, wrapping (`rovingStep`).
  const buttons = useRef<Partial<Record<ChoiceId, HTMLButtonElement | null>>>({});
  const roving = (id: ChoiceId) => ({
    ref: (el: HTMLButtonElement | null) => {
      buttons.current[id] = el;
    },
    tabIndex: id === chosen ? 0 : -1,
    onKeyDown: (e: KeyboardEvent) => {
      const next = rovingStep(e.key, ROVING.indexOf(id), ROVING.length);
      if (next === null) return;
      // Handled here: nothing further up (a page-level shortcut) should act on the same arrow.
      e.preventDefault();
      e.stopPropagation();
      const nextId = ROVING[next];
      if (nextId !== id) pick(nextId);
      buttons.current[nextId]?.focus();
    },
  });

  // Back from tap to order on another kind (it was cancelled into one): nothing to focus here.
  useEffect(() => {
    if (refocus && choice.kind !== "custom") onRefocused();
  }, [refocus, choice.kind, onRefocused]);

  return (
    <div>
      <div role="radiogroup" aria-label="Fill order" className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
        <div role="group" aria-label="Sweep" className="grid grid-cols-3 gap-1.5">
          {PAD.map((cell, k) => {
            if (cell === null) return <span key={k} aria-hidden className="h-12 w-12" />;
            if (cell === "centre") {
              return choice.direction ? (
                <SweepFillToggle
                  key={k}
                  direction={choice.direction}
                  fill={order.sweepFill}
                  onChange={props.onSweepFill}
                />
              ) : (
                // Only a sweep has a way to fill across the wall: under the others the centre rests.
                <span key={k} aria-hidden className="grid h-12 w-12 place-items-center">
                  <span className="h-2.5 w-2.5 rounded-full bg-default-300" />
                </span>
              );
            }
            const { label, icon: Icon } = DIRECTIONS[cell];
            const on = choice.direction === cell;
            const name = `Sweep ${label.toLowerCase()}`;
            return (
              <button
                key={cell}
                {...roving(cell)}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={name}
                title={on ? `${name}: press again to play it` : name}
                onClick={() => (on ? props.onPreview() : choice.chooseDirection(cell))}
                className={cn(
                  "grid h-12 w-12 place-items-center rounded-xl",
                  "transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.94]",
                  on ? PICKED : IDLE,
                )}
              >
                <Icon className="h-5 w-5" aria-hidden />
              </button>
            );
          })}
        </div>
        <div className="flex flex-col justify-center gap-1.5">
          {OTHERS.map((id) => {
            const { label, icon: Icon } = KINDS[id];
            const on = choice.kind === id;
            return (
              <button
                key={id}
                {...roving(id)}
                type="button"
                role="radio"
                aria-checked={on}
                title={on && id === "shuffle" ? "Shuffle: press again for a fresh mix" : undefined}
                onClick={() => choice.chooseKind(id)}
                className={cn(
                  "flex h-12 items-center gap-2.5 rounded-xl px-3.5 font-medium text-sm",
                  "transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.97]",
                  on ? PICKED : IDLE,
                )}
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {choice.kind === "custom" && (
          <motion.div
            key="custom"
            className="mt-3 border-default-100 border-t pt-3"
            initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(4px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
          >
            <MakeOwn refocus={refocus} onRefocused={onRefocused} onDraft={props.onDraft} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Which way each sweep's miniature points: it is drawn left to right. */
const TURN: Record<Direction, number> = { "left-right": 0, "right-left": 180, "bottom-up": -90, "top-down": 90 };

/**
 * The pad's centre: how a sweep fills, a press switching it. It shows the fill in miniature, pointing the way the
 * sweep goes: three dots lighting one after another (one panel at a time), or a bar filling smoothly (a line). It
 * plays once whenever the fill changes, its kind or its direction, then rests lit (wall.css: fill-dot, fill-bar).
 */
function SweepFillToggle({
  direction,
  fill,
  onChange,
}: {
  direction: Direction;
  fill: SweepFill;
  onChange(fill: SweepFill): void;
}) {
  const line = fill === "line";
  return (
    <button
      type="button"
      aria-pressed={line}
      aria-label="Fill as a line"
      title={line ? "Fills as a line: press to fill one panel at a time" : "Fills one panel at a time: press to fill as a line"}
      onClick={() => onChange(line ? "panels" : "line")}
      className={cn(
        "grid h-12 w-12 place-items-center rounded-xl",
        "transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.94]",
        IDLE,
      )}
    >
      <span
        aria-hidden
        className="grid place-items-center transition-transform duration-200 ease-out"
        style={{ transform: `rotate(${TURN[direction]}deg)` }}
      >
        {/* Keyed by the fill, so it plays once whenever the fill changes. */}
        {line ? (
          <span key={`line-${direction}`} className="block h-2.5 w-7 overflow-hidden rounded-full bg-current/20">
            <span className="fill-bar block h-full w-full rounded-full bg-current" />
          </span>
        ) : (
          <span key={`panels-${direction}`} className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="fill-dot block h-1.5 w-1.5 rounded-full bg-current"
                style={{ animationDelay: `${120 + i * 220}ms` }}
              />
            ))}
          </span>
        )}
      </span>
    </button>
  );
}

/** My own's two ways to number the panels: tap the drawing, or touch the wall itself (when it reports touches). */
function MakeOwn({
  refocus,
  onRefocused,
  onDraft,
}: Pick<CompassProps, "refocus" | "onRefocused" | "onDraft">) {
  const button = useRef<HTMLButtonElement>(null);
  // Back from tap to order (Done, Cancel, Escape): focus returns to the button that started it, not to the page.
  useEffect(() => {
    if (!refocus) return;
    button.current?.focus({ preventScroll: true });
    onRefocused();
  }, [refocus, onRefocused]);
  return (
    <button
      ref={button}
      type="button"
      // A click from the keyboard (Enter, Space, a screen reader) has no pointer: detail is 0.
      onClick={(e) => onDraft(e.detail === 0)}
      className={cn(ACTION, "w-full")}
    >
      <MousePointerClick className="h-4 w-4" aria-hidden />
      Edit panel order
    </button>
  );
}
