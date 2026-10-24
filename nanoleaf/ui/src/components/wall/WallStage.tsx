import { cn } from "@heroui/theme";
import { ZoomIn, ZoomOut } from "lucide-react";
import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FillSpan, PlacedLayout, Rgb } from "../../../../shared/types.ts";
import { useMediaQuery } from "../../hooks/useMediaQuery.ts";
import type { RenderStateRef } from "../../hooks/useRenderState.ts";
import { withAlpha } from "../../lib/color.ts";
import { EASE_IN_OUT, EASE_OUT } from "../../motion.ts";
import { type NumbersLevel, StageBadges } from "./StageBadges.tsx";
import { type PanelFlash, StageCanvas } from "./StageCanvas.tsx";
import { Horizon } from "./Horizon.tsx";
import { StageToast, type ToastMessage } from "./StageToast.tsx";
import { layoutStage, type Stage, steadyHeight, zoomFor } from "./stageLayout.ts";

/** The stage's own surface: the theme's surface, kept dark in a light theme (`.wall-stage` in wall.css). */
export const STAGE_BG = "var(--db-surface)";
/** The drawing takes at most about 60% of the frame's height, within these bounds. */
const MIN_CAP = 260;
const MAX_CAP = 640;
/** A turn of the drawing: something on screen moving, so ease-in-out, a touch slower than chrome. */
const TURN = { duration: 0.6, ease: EASE_IN_OUT } as const;

interface WallStageProps {
  readonly placed: PlacedLayout;
  /** The wall at every view rotation: when given, the drawing keeps the tallest of their heights through a turn. */
  readonly turns?: readonly PlacedLayout[];
  /** The saved view rotation: a change turns the drawing. */
  readonly rotation: number;
  readonly stateRef: RenderStateRef;
  /** The resolved order the lights follow. */
  readonly order: readonly number[];
  /** Each panel's share of a goal when the order fills as a line (null one panel at a time). */
  readonly spans?: readonly FillSpan[] | null;
  /** The order the numbers show (differs while a list row is being dragged). */
  readonly numberOrder: readonly number[];
  readonly drafting: boolean;
  readonly draft: readonly number[];
  readonly numbers: NumbersLevel;
  readonly focusId: number | null;
  readonly flash: PanelFlash | null;
  readonly accent: Rgb;
  /** The activity colour the wall shows, for a faint wash behind the drawing. */
  readonly wash: string | null;
  /** The wall isn't showing what the drawing shows: the light is drawn muted and `status` says why. */
  readonly muted: boolean;
  readonly status: string | null;
  readonly label: string;
  /**
   * On the night sky: no surface, ring, colour wash or floor glow, so the stars show through, and the wall's light
   * lies under the drawing as a horizon instead; the zoom button rises clear of what sits over the drawing's foot.
   */
  readonly sky?: boolean;
  /** How strongly light is drawn, from the wall's brightness (StageCanvas). */
  readonly level?: number;
  readonly toast: ToastMessage | null;
  /** The header above the drawing and the controls below it. */
  readonly header: ReactNode;
  readonly footer?: ReactNode;
  /** A tighter limit on the drawing's height than the frame's ~60% (the phone layout pins the stage). */
  readonly cap?: number;
  /** Icon buttons that join the zoom button in one group on the drawing (`toolClass` styles them). */
  readonly tools?: ReactNode;
  onToastDone(): void;
  onHover(id: number | null): void;
  onActivate(id: number): void;
  onSwap(a: number, b: number): void;
}

/**
 * The stage: the wall drawn to its container's width (ResizeObserver), at the wall's own proportions up to ~60% of
 * the frame's height. A new view rotation turns the drawing into place, rescaling on the way, instead of jumping.
 * When the smallest panels are under a finger's width (a big wall on a phone) it offers zoom: the drawing grows by
 * `zoomFor` and pans inside the same frame, and tap to order on a touch screen zooms in by itself.
 */
export function WallStage(props: WallStageProps) {
  const { placed, rotation, drafting } = props;
  const reduced = useReducedMotion();
  const area = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const turn = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const frameCap = useHeightCap();
  const cap = Math.min(frameCap, props.cap ?? frameCap);
  const [target, setTarget] = useState<number | null>(null);
  const [zoomOn, setZoomOn] = useState(false);
  const coarse = useMediaQuery("(pointer: coarse)");

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const measure = () => setWidth(Math.round(el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const height = width > 0 ? steadyHeight(placed, props.turns, width, cap) : 0;
  const fitted = useMemo(() => (width > 0 ? layoutStage(placed, width, height) : null), [placed, width, height]);
  const zoom = fitted ? zoomFor(fitted) : 1;
  const z = zoomOn && zoom > 1 ? zoom : 1;
  const stage = useMemo(
    () => (!fitted || z === 1 ? fitted : layoutStage(placed, Math.round(width * z), Math.round(height * z))),
    [fitted, placed, width, height, z],
  );

  // Tap to order on a touch screen needs finger-sized panels: zoom in for it when they're small, and back out after
  // (unless the user had zoomed in already).
  const auto = useRef({ zoomed: false, want: false, on: false });
  useLayoutEffect(() => {
    auto.current.want = coarse && zoom > 1;
    auto.current.on = zoomOn;
  });
  useEffect(() => {
    const a = auto.current;
    if (drafting && a.want && !a.on) {
      a.zoomed = true;
      setZoomOn(true);
    } else if (!drafting && a.zoomed) {
      a.zoomed = false;
      setZoomOn(false);
    }
  }, [drafting]);

  // A new zoom starts centred on the wall.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || z === 1) return;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  }, [z]);

  // Turning: start the new drawing mapped exactly onto the old one (the rotation delta, the scale ratio and both
  // translations), then ease that mapping away. See DESIGN.md "Controls".
  const last = useRef<{ rotation: number; stage: Stage; height: number } | null>(null);
  useLayoutEffect(() => {
    const prev = last.current;
    if (stage) last.current = { rotation, stage, height };
    if (!stage || !prev || prev.rotation === rotation || reduced || !turn.current || !area.current) return;
    const delta = ((((rotation - prev.rotation) % 360) + 540) % 360) - 180;
    const k = prev.stage.scale / stage.scale;
    const back = `translate(${-stage.tx}px, ${-stage.ty}px)`;
    const from = `translate(${prev.stage.tx}px, ${prev.stage.ty}px) rotate(${delta}deg) scale(${k}) ${back}`;
    const to = `translate(${stage.tx}px, ${stage.ty}px) rotate(0deg) scale(1) ${back}`;
    turn.current.style.transform = from;
    const turning = animate(turn.current, { transform: [from, to] }, TURN);
    const growing =
      prev.height !== height ? animate(area.current, { height: [`${prev.height}px`, `${height}px`] }, TURN) : null;
    // Interrupted (the column resized mid-turn, say): land on the new drawing rather than freeze part-way.
    return () => {
      turning.complete();
      growing?.complete();
    };
  }, [rotation, stage, height, reduced]);

  // Offered only when the smallest panels are under a finger's width.
  const zoomButton =
    zoom > 1 ? (
      <button
        type="button"
        aria-pressed={z > 1}
        aria-label={z > 1 ? "Fit the whole wall" : "Zoom in: bigger panels to tap"}
        title={z > 1 ? "Fit the whole wall" : "Zoom in: bigger panels to tap"}
        onClick={() => {
          auto.current.zoomed = false;
          setZoomOn(z === 1);
        }}
        className={toolClass(z > 1)}
      >
        {z > 1 ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
      </button>
    ) : null;

  const wash = props.wash && !props.sky
    ? `radial-gradient(90% 70% at 50% 45%, ${withAlpha(props.wash, 0.09)}, transparent 70%)`
    : undefined;

  return (
    <div
      className={cn(
        "wall-stage relative text-foreground",
        props.sky ? "overflow-visible" : "overflow-hidden rounded-3xl ring-1 ring-default-100",
      )}
      style={{ background: props.sky ? undefined : STAGE_BG }}
    >
      {props.header}
      {/* Holding a number to drag it, or a panel on a touch screen, must never select the numbers or call up the
          long-press menu. */}
      <div
        ref={area}
        className="relative w-full select-none [-webkit-touch-callout:none]"
        style={{ height: height || 280, backgroundImage: wash }}
      >
        {/* On the sky the wall's light lies under the drawing as a horizon (its floor glow steps aside). */}
        {props.sky && <Horizon />}
        {stage && (
          <div
            ref={scroller}
            className={cn(
              "absolute inset-0",
              z > 1 ? "overflow-auto overscroll-contain" : "overflow-hidden",
            )}
          >
            <div className="relative" style={{ width: stage.width, height: stage.height }}>
              <div ref={turn} className="absolute inset-0" style={{ transformOrigin: "0 0" }}>
                <StageCanvas
                  stage={stage}
                  stateRef={props.stateRef}
                  order={props.order}
                  spans={props.spans}
                  drafting={drafting}
                  muted={props.muted}
                  draft={props.draft}
                  focusId={props.focusId}
                  targetId={target}
                  flash={props.flash}
                  accent={props.accent}
                  label={props.label}
                  floor={!props.sky}
                  level={props.level}
                  onHover={props.onHover}
                  onActivate={props.onActivate}
                />
                <StageBadges
                  stage={stage}
                  order={props.numberOrder}
                  drafting={drafting}
                  draft={props.draft}
                  numbers={props.numbers}
                  focusId={props.focusId}
                  accent={props.accent}
                  onActivate={props.onActivate}
                  onTarget={setTarget}
                  onSwap={props.onSwap}
                />
              </div>
            </div>
          </div>
        )}
        <StageToast toast={props.toast} onDone={props.onToastDone} />
        {/* Zoom alone floats on the drawing; with tools it joins them in the row under it. */}
        {props.tools == null && zoomButton && (
          <div
            className={cn(
              "absolute right-3 z-10 rounded-full bg-background/70 p-1 ring-1 ring-white/10 backdrop-blur",
              props.sky ? "bottom-12" : "bottom-3",
            )}
          >
            {zoomButton}
          </div>
        )}
      </div>
      {/* The drawing's tools as one segmented group under it, right-aligned, zoom last. */}
      {props.tools != null && (
        <div className="flex justify-end px-3 pt-1 pb-3">
          <div role="group" aria-label="Drawing" className="flex w-fit items-center gap-0.5 rounded-full bg-default-100 p-1">
            {props.tools}
            {zoomButton}
          </div>
        </div>
      )}
      {/* Under the drawing, not over it: on a phone the sentence wraps and would cover the bottom row of panels. */}
      <AnimatePresence initial={false}>
        {props.status && (
          <motion.div
            key="status"
            className="overflow-hidden"
            initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
          >
            <div className="flex items-start gap-2 @md:px-5 px-4 pb-2.5 text-default-600 text-xs leading-snug">
              <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-default-500" aria-hidden />
              <span className="min-w-0">Not on your wall · {props.status}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {props.footer != null && <div className="border-white/5 border-t">{props.footer}</div>}
    </div>
  );
}

/** One icon button in the drawing's tool group; `on` while it's pressed (zoomed in, numbers showing…). */
export function toolClass(on: boolean): string {
  return cn(
    "grid h-9 w-9 place-items-center rounded-full transition-[background-color,color,transform] duration-150 ease-out",
    "active:scale-[0.9]",
    on ? "bg-white/15 text-foreground" : "text-default-600 hover:bg-white/10 hover:text-foreground",
  );
}

/** About 60% of the frame's height, kept current as the frame resizes. */
function useHeightCap(): number {
  const read = () => Math.round(Math.min(MAX_CAP, Math.max(MIN_CAP, window.innerHeight * 0.6)));
  const [cap, setCap] = useState(read);
  useLayoutEffect(() => {
    const onResize = () => setCap(read());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return cap;
}
