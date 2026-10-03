import { cn } from "@heroui/theme";
import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react";
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cssRgb } from "../../../../shared/color.ts";
import type { Rgb } from "../../../../shared/types.ts";
import { inkOn } from "../../lib/color.ts";
import { EASE_OUT, SPRING_POP, SPRING_SETTLE } from "../../motion.ts";
import {
  BADGE_BASE as BASE,
  type BadgeFit,
  badgeSlots,
  badgeTransform,
  dropSnap,
  fitBadges,
  swapIds,
} from "./badges.ts";
import type { Stage } from "./stageLayout.ts";

/** A press becomes a drag after this many pixels. */
const DRAG_THRESHOLD = 6;

/** How numbers rest: faint (view), fully shown (while editing) or hidden (the user switched them off). */
export type NumbersLevel = "dim" | "full" | "off";

interface StageBadgesProps {
  readonly stage: Stage;
  /** The order the numbers show (the list's live order while a row is dragged). */
  readonly order: readonly number[];
  readonly drafting: boolean;
  readonly draft: readonly number[];
  readonly numbers: NumbersLevel;
  readonly focusId: number | null;
  readonly accent: Rgb;
  /** Clicking a number counts as clicking its panel. */
  onActivate(id: number): void;
  /** The panel a dragged number is over (null when none, or the drag ended). */
  onTarget(id: number | null): void;
  /** Drop a number on another panel: swap the two. */
  onSwap(a: number, b: number): void;
}

/**
 * Sequence numbers over the drawing: the fill order at rest, or the tap-to-order draft. Each panel's badge is sized
 * and placed once per stage (`fitBadges`): legible digits, nudged apart where panels are tiny, and hidden until
 * hovered or focused when there's no room at all.
 */
export function StageBadges(props: StageBadgesProps) {
  const fits = useMemo(() => fitBadges(props.stage, props.stage.panels.length), [props.stage]);
  return (
    <div className="pointer-events-none absolute inset-0">
      <AnimatePresence initial={false}>
        {props.drafting ? (
          <DraftBadges key="draft" {...props} fits={fits} />
        ) : (
          <OrderBadges key="order" {...props} fits={fits} />
        )}
      </AnimatePresence>
    </div>
  );
}

type BadgeLayerProps = StageBadgesProps & { readonly fits: ReadonlyMap<number, BadgeFit> };

const layerMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: 0.15, ease: EASE_OUT } },
};

interface Drag {
  readonly id: number;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  dragging: boolean;
  target: number | null;
}

/**
 * The numbers at rest. When the order changes each one flies to its new panel (a short stagger along the order);
 * any number can be dragged onto another panel to swap the two, and the displaced number slides over while hovering.
 */
function OrderBadges({ stage, fits, order, numbers, focusId, onActivate, onTarget, onSwap }: BadgeLayerProps) {
  const reduced = useReducedMotion();
  const layer = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<{ id: number; label: number } | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  // A dropped swap shows at once, before the saved order comes back.
  const [pending, setPending] = useState<{ a: number; b: number; from: readonly number[] } | null>(null);
  const snap = useRef<number | null>(null);

  // Resizes and rotations move numbers instantly; only a new order makes them fly.
  const geometry = [stage.width, stage.height, stage.scale.toFixed(4), stage.tx.toFixed(1), stage.ty.toFixed(1)].join();
  const lastGeometry = useRef(geometry);
  const moved = lastGeometry.current !== geometry;
  useLayoutEffect(() => {
    lastGeometry.current = geometry;
  });
  useEffect(() => {
    if (pending && order !== pending.from) setPending(null);
  }, [order, pending]);
  useEffect(() => {
    snap.current = null;
  });

  let shown = order;
  if (pending && order === pending.from) shown = swapIds(order, pending.a, pending.b);

  const end = (e: ReactPointerEvent | null, commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (e && (e.currentTarget as Element).hasPointerCapture?.(e.pointerId)) {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    }
    if (!d.dragging) {
      if (commit) onActivate(d.id);
      return;
    }
    setTarget(null);
    onTarget(null);
    const el = ghost.current;
    if (commit && d.target !== null && d.target !== d.id) {
      snap.current = dropSnap({ id: d.id, target: d.target });
      setPending({ a: d.id, b: d.target, from: order });
      setDragging(null);
      if (el) el.style.opacity = "0";
      onSwap(d.id, d.target);
      return;
    }
    // Nowhere to land: the number flies home, then the one it came from lights up again.
    const home = fits.get(d.id);
    if (!el || !home || reduced) {
      if (el) el.style.opacity = "0";
      setDragging(null);
      return;
    }
    void animate(el, { transform: badgeTransform(home) }, { duration: 0.22, ease: EASE_OUT }).then(() => {
      el.style.opacity = "0";
      setDragging(null);
    });
  };

  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && end(null, false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const handlers = (id: number, label: number) => ({
    onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
      if (e.button !== 0 || drag.current) return;
      // Capture keeps the drag alive outside the badge; a pointer that can't be captured still drags while over it.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Not an active pointer (a synthetic event): nothing to capture.
      }
      drag.current = {
        id,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        dragging: false,
        target: null,
      };
    },
    onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.dragging) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
        d.dragging = true;
        setDragging({ id, label });
      }
      const el = ghost.current;
      const box = layer.current?.getBoundingClientRect();
      if (el && box) {
        const x = e.clientX - box.left - BASE / 2;
        const y = e.clientY - box.top - BASE / 2;
        el.style.transform = `translate(${x}px, ${y}px) scale(1.2)`;
        el.style.opacity = "1";
      }
      const next = panelUnder(e.clientX, e.clientY);
      const over = next === d.id ? null : next;
      if (over !== d.target) {
        d.target = over;
        setTarget(over);
        onTarget(over);
      }
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => end(e, true),
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => end(e, false),
  });

  const slots = badgeSlots(
    shown,
    dragging ? { id: dragging.id, target } : null,
    snap.current,
    moved || reduced === true,
  );
  return (
    <motion.div ref={layer} className="absolute inset-0" {...layerMotion}>
      {slots.map((slot, k) => {
        const { id, label } = slot;
        const fit = fits.get(slot.spot);
        if (!fit || !stage.byId.has(id)) return null;
        const swapping = slot.spot !== id;
        const focused = focusId === id;
        // No room on this panel: its number waits for hover or focus (or a drag, which needs every target).
        const room = !(fits.get(id)?.hidden ?? false);
        const opacity = slot.dragged
          ? 0.22
          : !room && !focused && !dragging
            ? 0
            : dragging || focused || numbers === "full"
              ? 1
              : numbers === "dim"
                ? 0.42
                : 0;
        const s = fit.scale * (focused && !dragging ? 1.12 : 1);
        return (
          <motion.div
            key={slot.key}
            className={cn(
              "absolute top-0 left-0 grid cursor-grab touch-none place-items-center rounded-full font-semibold",
              "text-white tabular-nums leading-none",
              "bg-black/65 shadow-[0_2px_10px_rgb(0_0_0/0.45)] ring-1 ring-white/20",
              focused && "ring-2 ring-white/90",
              opacity > 0 ? "pointer-events-auto" : "pointer-events-none",
            )}
            style={{ width: BASE, height: BASE, fontSize: fit.font, zIndex: focused ? 1 : undefined }}
            initial={false}
            animate={{ transform: badgeTransform(fit, s), opacity }}
            transition={{
              transform: slot.instant
                ? { duration: 0 }
                : { ...SPRING_SETTLE, delay: swapping ? 0 : Math.min(k, 20) * 0.012 },
              opacity: { duration: 0.18, ease: EASE_OUT },
            }}
            aria-hidden
            {...handlers(id, label)}
          >
            {label}
          </motion.div>
        );
      })}
      <div
        ref={ghost}
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-0 left-0 grid place-items-center rounded-full bg-white font-semibold",
          "text-[13px] text-black tabular-nums shadow-[0_8px_24px_rgb(0_0_0/0.55)]",
        )}
        style={{ width: BASE, height: BASE, opacity: 0 }}
      >
        {dragging?.label}
      </div>
    </motion.div>
  );
}

/**
 * Tap to order: every panel waits behind a dashed ring (they clear in fill order as the mode starts); a tap pops the
 * next number onto it in the accent colour. Hovering or focusing a waiting panel previews the number it would get.
 */
function DraftBadges({ stage, fits, order, draft, focusId, accent }: BadgeLayerProps) {
  const reduced = useReducedMotion();
  // Rings clear in along the fill order as the mode starts; one that comes back after an undo appears at once.
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setEntering(false), 700);
    return () => window.clearTimeout(id);
  }, []);
  const rank = new Map(order.map((id, k) => [id, k]));
  const bg = cssRgb(accent);
  const ink = inkOn(accent);
  return (
    <motion.div className="absolute inset-0" {...layerMotion}>
      {stage.panels.map((p) => {
        const fit = fits.get(p.id);
        if (!fit) return null;
        const n = draft.indexOf(p.id) + 1;
        const focused = focusId === p.id;
        return (
          <div
            key={p.id}
            className={cn(
              "absolute top-0 left-0 grid transition-opacity duration-150",
              fit.hidden && !focused && "opacity-0",
            )}
            style={{ width: BASE, height: BASE, fontSize: fit.font, transform: badgeTransform(fit) }}
          >
            <AnimatePresence initial>
              {n > 0 ? (
                <motion.div
                  key="n"
                  className={cn(
                    "grid place-items-center rounded-full font-bold tabular-nums leading-none",
                    "shadow-[0_2px_10px_rgb(0_0_0/0.4)] [grid-area:1/1]",
                  )}
                  style={{ background: bg, color: ink }}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "scale(0.5)" }}
                  animate={{ opacity: 1, transform: "scale(1)" }}
                  exit={
                    reduced
                      ? { opacity: 0, transition: { duration: 0.12, ease: EASE_OUT } }
                      : { opacity: 0, transform: "scale(0.6)", transition: { duration: 0.12, ease: EASE_OUT } }
                  }
                  transition={reduced ? { duration: 0.15 } : SPRING_POP}
                >
                  {n}
                </motion.div>
              ) : (
                <motion.div
                  key="ring"
                  className={cn(
                    "grid place-items-center rounded-full border-[1.5px] border-dashed font-semibold",
                    "tabular-nums leading-none [grid-area:1/1]",
                    focused ? "border-white/85 bg-white/10 text-white/70" : "border-white/45 text-transparent",
                  )}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "scale(0.85)" }}
                  animate={{ opacity: 1, transform: "scale(1)" }}
                  exit={{ opacity: 0, transition: { duration: 0.1 } }}
                  transition={{
                    duration: 0.22,
                    ease: EASE_OUT,
                    delay: entering && !reduced ? Math.min(rank.get(p.id) ?? 0, 24) * 0.018 : 0,
                  }}
                >
                  {draft.length + 1}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </motion.div>
  );
}

/** The light panel under a screen point, from the drawing's hit outlines. */
function panelUnder(x: number, y: number): number | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const id = (el as HTMLElement | SVGElement).dataset?.panel;
    if (id !== undefined) return Number(id);
  }
  return null;
}
