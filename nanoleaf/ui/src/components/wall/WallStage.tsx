import { cn } from "@heroui/theme";
import { ZoomIn, ZoomOut } from "lucide-react";
import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PlacedLayout, Rgb } from "../../../../shared/types.ts";
import { useMediaQuery } from "../../hooks/useMediaQuery.ts";
import type { RenderStateRef } from "../../hooks/useRenderState.ts";
import { withAlpha } from "../../lib/color.ts";
import { EASE_IN_OUT, EASE_OUT } from "../../motion.ts";
import { type NumbersLevel, StageBadges } from "./StageBadges.tsx";
import { type PanelFlash, StageCanvas } from "./StageCanvas.tsx";
import { StageToast, type ToastMessage } from "./StageToast.tsx";
import { layoutStage, type Stage, stageHeight, zoomFor } from "./stageLayout.ts";

/** The stage's own surface: the theme's surface, kept dark in a light theme (`.wall-stage` in wall.css). */
export const STAGE_BG = "var(--db-surface)";
/** The drawing takes at most about 60% of the frame's height, within these bounds. */
const MIN_CAP = 260;
const MAX_CAP = 640;
/** A turn of the drawing: something on screen moving, so ease-in-out, a touch slower than chrome. */
const TURN = { duration: 0.6, ease: EASE_IN_OUT } as const;

interface WallStageProps {
  readonly placed: PlacedLayout;
  /** The saved view rotation: a change turns the drawing. */
  readonly rotation: number;
  readonly stateRef: RenderStateRef;
  /** The resolved order the lights follow. */
  readonly order: readonly number[];
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
  readonly toast: ToastMessage | null;
  /** The header above the drawing and the controls below it. */
  readonly header: ReactNode;
  readonly footer?: ReactNode;
  /** A tighter limit on the drawing's height than the frame's ~60% (the phone layout pins the stage). */
  readonly cap?: number;
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

  const height = width > 0 ? stageHeight(placed, width, cap) : 0;
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

  const wash = props.wash
    ? `radial-gradient(90% 70% at 50% 45%, ${withAlpha(props.wash, 0.09)}, transparent 70%)`
    : undefined;

  return (
    <div
      className="wall-stage relative overflow-hidden rounded-3xl text-foreground ring-1 ring-default-100"
      style={{ background: STAGE_BG }}
    >
      {props.header}
      <div ref={area} className="relative w-full" style={{ height: height || 280, backgroundImage: wash }}>
        {stage && (
          <div
            ref={scroller}
            className={cn("absolute inset-0", z > 1 ? "overflow-auto overscroll-contain" : "overflow-hidden")}
          >
            <div className="relative" style={{ width: stage.width, height: stage.height }}>
              <div ref={turn} className="absolute inset-0" style={{ transformOrigin: "0 0" }}>
                <StageCanvas
                  stage={stage}
                  stateRef={props.stateRef}
                  order={props.order}
                  drafting={drafting}
                  muted={props.muted}
                  draft={props.draft}
                  focusId={props.focusId}
                  targetId={target}
                  flash={props.flash}
                  accent={props.accent}
                  label={props.label}
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
        {zoom > 1 && (
          <button
            type="button"
            aria-pressed={z > 1}
            aria-label={z > 1 ? "Fit the whole wall" : "Zoom in: bigger panels to tap"}
            title={z > 1 ? "Fit the whole wall" : "Zoom in: bigger panels to tap"}
            onClick={() => {
              auto.current.zoomed = false;
              setZoomOn(z === 1);
            }}
            className={cn(
              "absolute right-3 bottom-3 z-10 grid h-9 w-9 place-items-center rounded-xl bg-background/60",
              "text-default-600 ring-1 ring-white/10 backdrop-blur transition-[background-color,color,transform]",
              "duration-150 ease-out hover:bg-black/75 hover:text-foreground active:scale-[0.9]",
            )}
          >
            {z > 1 ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
          </button>
        )}
      </div>
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
