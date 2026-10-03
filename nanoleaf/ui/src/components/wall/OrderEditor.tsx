import { cn } from "@heroui/theme";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Dices,
  Hand,
  type LucideIcon,
  MousePointerClick,
  Play,
  Route,
  Square,
  Undo2,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cssRgb } from "../../../../shared/color.ts";
import type { AutoOrder, OrderMode, PanelOrder, PlacedLayout, Rgb } from "../../../../shared/types.ts";
import { AUTO_ORDERS } from "../../lib/panels.ts";
import { rovingStep } from "../../lib/roving.ts";
import { EASE_OUT } from "../../motion.ts";
import type { DraftSource } from "./DraftPanel.tsx";
import { OrderThumb } from "./OrderThumb.tsx";

/** Every way to fill the wall, as one choice: the five automatic orders, a shuffle, and your own. */
type Choice = AutoOrder | "random" | "custom";

/** The arrows read as the way the light travels, so they sit on the side of the wall it travels towards. */
const SWEEPS: readonly { readonly id: AutoOrder; readonly Glyph: LucideIcon; readonly place: string }[] = [
  { id: "left-right", Glyph: ArrowRight, place: "col-start-3 row-start-2" },
  { id: "right-left", Glyph: ArrowLeft, place: "col-start-1 row-start-2" },
  { id: "bottom-up", Glyph: ArrowUp, place: "col-start-2 row-start-1" },
  { id: "top-down", Glyph: ArrowDown, place: "col-start-2 row-start-3" },
];

/** The orders that aren't a direction. */
const OTHERS: readonly { readonly id: Choice; readonly label: string; readonly Glyph: LucideIcon }[] = [
  { id: "path", label: "Path", Glyph: Route },
  { id: "random", label: "Shuffle", Glyph: Dices },
  { id: "custom", label: "My own", Glyph: Hand },
];

/** Arrow keys walk the choices in this order. */
const CHOICES: readonly Choice[] = [...OTHERS.map((o) => o.id), ...SWEEPS.map((s) => s.id)];

const RANDOM_HINT = "A fresh mix of the panels. Choose Shuffle again to re-roll.";

/** The chosen state: an accent tint and outline over a neutral button, so a pale accent still reads as chosen. */
function chosen(accent: Rgb) {
  return { backgroundImage: tint(accent, 0.18), boxShadow: `inset 0 0 0 1.5px ${cssRgb(accent)}` };
}

/** An accent wash as a background image, layered over a neutral background colour so it reads on any theme. */
function tint(accent: Rgb, alpha: number): string {
  const c = cssRgb(accent, alpha);
  return `linear-gradient(${c}, ${c})`;
}

/** How long "Custom order kept · Undo" stays: long enough to notice a mis-tap and take it back. */
const UNDO_MS = 6000;

/** A change the editor can take back (leaving a hand-made order), keyed so a repeat restarts its timer. */
export interface UndoOffer {
  readonly id: number;
  readonly text: string;
}

interface OrderEditorProps {
  readonly placed: PlacedLayout;
  /** The order showing now, first fills first. */
  readonly resolved: readonly number[];
  readonly order: PanelOrder;
  readonly accent: Rgb;
  /** The controller's event stream is open, so panels touched on the wall can be numbered. */
  readonly canTouch: boolean;
  readonly playing: boolean;
  /** Tap to order just ended from this button: it takes keyboard focus back once it's here. */
  readonly refocus: DraftSource | null;
  readonly undo: UndoOffer | null;
  onMode(mode: OrderMode): void;
  onAuto(kind: AutoOrder): void;
  onShuffle(): void;
  /** Start tap to order; `keyboard` when the button was pressed from the keyboard (focus then goes to a panel). */
  onDraft(source: DraftSource, keyboard: boolean): void;
  onPlay(): void;
  onRefocused(): void;
  onUndo(): void;
  onUndoDone(): void;
}

/**
 * The order editor, as a compass: the wall in miniature with the order drawn through it, an arrow on each side for
 * the way the light should travel, and under it the three orders that aren't a direction (follow the shape, shuffle,
 * your own). One choice, not a mode and then a kind. Play sweeps the order across the drawing.
 */
export function OrderEditor(props: OrderEditorProps) {
  const { order, accent, refocus, onRefocused } = props;
  const reduced = useReducedMotion();
  const [rolls, setRolls] = useState(0);
  const current: Choice = order.mode === "auto" ? order.auto : order.mode;

  const choose = (choice: Choice) => {
    if (choice === "custom") return props.onMode("custom");
    if (choice !== "random") return props.onAuto(choice);
    setRolls((n) => n + 1);
    // Already shuffled: choosing it again rolls a new mix.
    if (order.mode === "random") props.onShuffle();
    else props.onMode("random");
  };
  const roving = useRoving(CHOICES, choose);

  // Tap to order hands focus back to the button that started it (CustomTools); with Custom no longer chosen there
  // is no such button, so the hand-back is just acknowledged.
  useEffect(() => {
    if (refocus && current !== "custom") onRefocused();
  }, [refocus, current, onRefocused]);

  const choice = (id: Choice, label: string, className: string, children: ReactNode) => {
    const active = id === current;
    const index = CHOICES.indexOf(id);
    return (
      <button
        key={id}
        ref={roving.ref(index)}
        type="button"
        role="radio"
        aria-checked={active}
        aria-label={label}
        title={label}
        tabIndex={active ? 0 : -1}
        onClick={() => choose(id)}
        onKeyDown={(e) => roving.onKeyDown(e, index)}
        className={cn(
          "flex items-center justify-center gap-1.5 rounded-xl bg-default-100 font-medium text-sm",
          "transition-[background-color,box-shadow,color,transform] duration-150 ease-out active:scale-[0.95]",
          active ? "text-foreground" : "text-default-500 hover:bg-default-200 hover:text-foreground",
          className,
        )}
        style={active ? chosen(accent) : undefined}
      >
        {children}
      </button>
    );
  };

  const hint = current === "random" ? RANDOM_HINT : AUTO_ORDERS.find((a) => a.id === current)?.hint;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[10px] text-default-400 uppercase tracking-wider">Fill order</div>
          <div className="text-default-500 text-sm">Which panel lights first as a goal fills</div>
        </div>
        <PlayButton playing={props.playing} onPress={props.onPlay} />
      </div>

      <UndoBar offer={props.undo} onUndo={props.onUndo} onDone={props.onUndoDone} />

      <div role="radiogroup" aria-label="Fill order" className="space-y-2">
        <div className="grid grid-cols-[40px_minmax(0,1fr)_40px] grid-rows-[40px_auto_40px] gap-2">
          {SWEEPS.map((s) =>
            choice(s.id, AUTO_ORDERS.find((a) => a.id === s.id)?.label ?? s.id, s.place, <s.Glyph className="h-4 w-4" />),
          )}
          <div className="col-start-2 row-start-2 rounded-2xl bg-default-100/50 p-2 ring-1 ring-default-100">
            <OrderThumb placed={props.placed} ids={props.resolved} accent={accent} width={240} height={120} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {OTHERS.map((o) =>
            choice(
              o.id,
              o.label,
              "h-10",
              <>
                {o.id === "random" ? (
                  // The die turns over with each roll; the numbers fly to their new panels on the stage.
                  <motion.span
                    className="grid place-items-center"
                    animate={{ transform: `rotate(${reduced ? 0 : rolls * 360}deg)` }}
                    transition={{ type: "spring", duration: 0.6, bounce: 0.25 }}
                  >
                    <o.Glyph className="h-4 w-4" />
                  </motion.span>
                ) : (
                  <o.Glyph className="h-4 w-4" />
                )}
                {o.label}
              </>,
            ),
          )}
        </div>
      </div>

      {current === "custom" ? (
        <CustomTools
          canTouch={props.canTouch}
          accent={accent}
          refocus={refocus}
          onRefocused={onRefocused}
          onDraft={props.onDraft}
        />
      ) : (
        <p className="text-default-500 text-xs leading-snug">{hint}</p>
      )}
    </div>
  );
}

/**
 * Roving focus for a radio group (WAI-ARIA): one Tab stop, the arrows move the choice and focus together.
 * Returns the key handler for choice `index`; `refs` holds the buttons.
 */
function useRoving<T>(options: readonly T[], onChange: (value: T) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const next = rovingStep(e.key, index, options.length);
    if (next === null) return;
    // Handled here: nothing further up (a page-level shortcut) should act on the same arrow.
    e.preventDefault();
    e.stopPropagation();
    const value = options[next];
    if (value !== undefined && next !== index) onChange(value);
    refs.current[next]?.focus();
  };
  const ref = (index: number) => (el: HTMLButtonElement | null) => {
    refs.current[index] = el;
  };
  return { onKeyDown, ref };
}

/**
 * "Custom order kept · Undo", right under the mode switch after leaving a hand-made order: the switch is a tap away
 * from a mis-tap, so it says the order isn't lost (Custom brings it back) and offers to take the switch back.
 */
function UndoBar({ offer, onUndo, onDone }: { offer: UndoOffer | null; onUndo: () => void; onDone: () => void }) {
  const reduced = useReducedMotion();
  const done = useRef(onDone);
  useLayoutEffect(() => {
    done.current = onDone;
  }, [onDone]);
  useEffect(() => {
    if (!offer) return;
    const timer = window.setTimeout(() => done.current(), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [offer]);
  return (
    <AnimatePresence initial={false}>
      {offer && (
        <motion.div
          key="undo"
          className="overflow-hidden"
          initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: EASE_OUT }}
        >
          <div role="status" className="flex items-center gap-2 rounded-xl bg-default-100/60 py-1 pr-1 pl-3 text-xs">
            <span className="min-w-0 flex-1 text-default-600">{offer.text}</span>
            <button
              type="button"
              onClick={onUndo}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1 rounded-lg px-2.5 font-medium text-foreground",
                "transition-[background-color,transform] duration-150 ease-out hover:bg-default-200",
                "active:scale-[0.97]",
              )}
            >
              <Undo2 className="h-3.5 w-3.5" />
              Undo
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Custom: number the panels by tapping the drawing, or the wall itself. */
function CustomTools({
  canTouch,
  accent,
  refocus,
  onRefocused,
  onDraft,
}: {
  canTouch: boolean;
  accent: Rgb;
  refocus: DraftSource | null;
  onRefocused: () => void;
  onDraft: (s: DraftSource, keyboard: boolean) => void;
}) {
  const stageButton = useRef<HTMLButtonElement>(null);
  const wallButton = useRef<HTMLButtonElement>(null);
  // Back from tap to order (Done, Cancel, Escape): focus returns to the button that started it, not to the page.
  useEffect(() => {
    if (!refocus) return;
    const el = (refocus === "wall" ? wallButton.current : null) ?? stageButton.current;
    el?.focus({ preventScroll: true });
    onRefocused();
  }, [refocus, onRefocused]);
  return (
    <div className="space-y-2.5">
      <div className="grid @xs:grid-cols-2 gap-2">
        <button
          ref={stageButton}
          type="button"
          // A click from the keyboard (Enter, Space, a screen reader) has no pointer: detail is 0.
          onClick={(e) => onDraft("stage", e.detail === 0)}
          className={cn(
            "flex h-11 items-center justify-center gap-2 rounded-xl bg-default-100 font-semibold text-foreground",
            "text-sm",
            "transition-[filter,transform] duration-150 ease-out hover:brightness-110 active:scale-[0.97]",
          )}
          // The label stays in the theme's ink (an activity colour can be too pale to read on a light theme); the
          // accent tints the button and colours the icon.
          style={{ backgroundImage: tint(accent, 0.2), boxShadow: `inset 0 0 0 1px ${cssRgb(accent, 0.45)}` }}
        >
          <MousePointerClick className="h-4 w-4" style={{ color: cssRgb(accent) }} />
          Tap to order
        </button>
        {canTouch && (
          <button
            ref={wallButton}
            type="button"
            onClick={(e) => onDraft("wall", e.detail === 0)}
            className={cn(
              "flex h-11 items-center justify-center gap-2 rounded-xl bg-default-100 font-medium text-sm",
              "transition-[background-color,transform] duration-150 ease-out hover:bg-default-200 active:scale-[0.97]",
            )}
          >
            <Hand className="h-4 w-4" />
            Tap on your wall
          </button>
        )}
      </div>
      <p className="text-default-500 text-xs">Or drag a number on the drawing onto another panel to swap the two.</p>
    </div>
  );
}

/** Play the order as a sweep (and stop it). The icons crossfade: the swap is feedback, not decoration. */
function PlayButton({ playing, onPress }: { playing: boolean; onPress: () => void }) {
  const reduced = useReducedMotion();
  const icon = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, transform: "scale(0.7)" },
        animate: { opacity: 1, transform: "scale(1)" },
        exit: { opacity: 0, transform: "scale(0.7)" },
      };
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={playing}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-default-100 pr-3.5 pl-2.5 font-medium text-sm",
        "transition-[background-color,transform] duration-150 ease-out hover:bg-default-200 active:scale-[0.97]",
      )}
    >
      <span className="grid h-4 w-4 place-items-center">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={playing ? "stop" : "play"} {...icon} transition={{ duration: 0.15, ease: EASE_OUT }}>
            {playing ? <Square className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5 fill-current" />}
          </motion.span>
        </AnimatePresence>
      </span>
      {playing ? "Stop" : "Play order"}
    </button>
  );
}
