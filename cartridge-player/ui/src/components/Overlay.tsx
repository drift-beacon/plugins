import { X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from "motion/react";
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx.ts";
import { EASE_DRAWER, EASE_OUT } from "../motion.ts";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])';

/**
 * While an overlay is open: Esc closes it, Tab stays inside it, focus starts on its first control (or `initial`), and
 * goes back to whatever opened it (or `returnTo`, when that control is going away) as it closes, so a keyboard user
 * carries on where they were. `present` is false while the panel plays its exit: it lets go at once, so a panel on
 * its way out never answers keys or takes focus back from whatever opened next.
 */
function useDialogFocus(
  panel: RefObject<HTMLElement | null>,
  present: boolean,
  onClose: () => void,
  initial?: RefObject<HTMLElement | null>,
  returnTo?: RefObject<HTMLElement | null>,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!present) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = panel.current;
    const first = initial?.current ?? node?.querySelector<HTMLElement>(FOCUSABLE) ?? node;
    first?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const [head, tail] = [items[0], items[items.length - 1]];
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head.focus();
      }
    };
    // After the overlay's own controls have had the key: a search with text in it takes Esc to clear itself first.
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const target = returnTo?.current ?? opener;
      // Only when focus is still the overlay's to give: the user may have clicked something else to close it.
      const held = !document.activeElement || document.activeElement === document.body || node?.contains(document.activeElement);
      if (target?.isConnected && held) target.focus({ preventScroll: true });
    };
  }, [panel, present, initial, returnTo]);
}

interface OverlayProps {
  readonly open: boolean;
  onClose(): void;
  /** The dialog's accessible name. */
  readonly label: string;
  /**
   * The overlay's body is a flex column. A child that scrolls as a whole is `shrink-0` (the overlay scrolls it); one
   * that holds a list is `flex min-h-0 flex-col` and lets the list take what height is left, so there is only ever
   * one scrolling region.
   */
  readonly children: ReactNode;
  /** Focus this instead of the first control when it opens. */
  readonly initialFocus?: RefObject<HTMLElement | null>;
  /** When set (its `current`), focus goes here as it closes instead of back to what opened it. */
  readonly returnFocus?: RefObject<HTMLElement | null>;
}

const GAP = 8;

/** Into the page's body, above everything; nothing while rendering to a string, where there is no page. */
export function portal(node: ReactNode): ReactNode {
  return typeof document === "undefined" ? null : createPortal(node, document.body);
}

export interface Place {
  readonly left: number;
  readonly width: number;
  readonly above: boolean;
  /** The edge it hangs from: `top` when below its anchor, `bottom` when above, so its other edge is free to move. */
  readonly top?: number;
  readonly bottom?: number;
  readonly maxHeight: number;
}

const samePlace = (a: Place | null, b: Place) =>
  a !== null && a.left === b.left && a.width === b.width && a.above === b.above && a.top === b.top && a.bottom === b.bottom && a.maxHeight === b.maxHeight;

/**
 * Where a floating panel goes: under its anchor, or above it when it doesn't fit there and above has more room, and
 * always inside the frame. `width` is the panel's, centred on the anchor, or "anchor" to match the anchor's own box.
 * The side is chosen once, on the panel's size as it opens, and the panel hangs from the edge next to its anchor:
 * content that grows or shrinks afterwards (a filtered list, a confirmation) moves its far edge and never detaches it.
 */
export function useAnchoredPlace(
  anchor: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  width: number | "anchor",
  minHeight = 160,
): Place | null {
  const [place, setPlace] = useState<Place | null>(null);
  const side = useRef<"above" | "below" | null>(null);

  useLayoutEffect(() => {
    const update = (event?: Event) => {
      // The panel's own list scrolling moves nothing.
      if (event?.target instanceof Node && panel.current?.contains(event.target)) return;
      const target = anchor.current?.getBoundingClientRect();
      const node = panel.current;
      if (!target || !node) return;
      // What's visible: on a phone the keyboard covers the bottom of the layout viewport.
      const frameHeight = window.visualViewport?.height ?? window.innerHeight;
      const w = width === "anchor" ? target.width : Math.min(width, window.innerWidth - 2 * GAP);
      const left = width === "anchor" ? target.left : Math.min(Math.max(GAP, target.left + target.width / 2 - w / 2), window.innerWidth - w - GAP);
      const below = frameHeight - target.bottom - 2 * GAP;
      const aboveRoom = target.top - 2 * GAP;
      side.current ??= node.scrollHeight > below && aboveRoom > below ? "above" : "below";
      const above = side.current === "above";
      const next: Place = {
        left,
        width: w,
        above,
        maxHeight: Math.max(minHeight, above ? aboveRoom : below),
        ...(above ? { bottom: window.innerHeight - target.top + GAP } : { top: target.bottom + GAP }),
      };
      setPlace((current) => (samePlace(current, next) ? current : next));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, [anchor, panel, width, minHeight]);

  return place;
}

/** Closes a floating panel when a press lands outside it and outside what opened it. */
export function useOutsidePress(enabled: boolean, inside: readonly RefObject<HTMLElement | null>[], onOutside: () => void) {
  const latest = useRef({ inside, onOutside });
  latest.current = { inside, onOutside };
  useEffect(() => {
    if (!enabled) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (latest.current.inside.some((ref) => ref.current?.contains(target))) return;
      latest.current.onOutside();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [enabled]);
}

type PopoverProps = OverlayProps & {
  readonly anchor: RefObject<HTMLElement | null>;
  readonly width?: number;
  /**
   * What the popover is about, when one popover serves several anchors (the shelf's cards). A different id is a
   * different panel: it opens at its own anchor with its own focus while the previous one fades out, instead of the
   * previous panel being reused where it stood.
   */
  readonly id?: string;
};

/**
 * A panel anchored under the control that opened it (above when there's no room below), kept inside the frame.
 * It's for the wide layout; phones get a `Sheet`. Clicking outside or Esc closes it.
 */
export function Popover({ id, width = 320, ...props }: PopoverProps) {
  return portal(<AnimatePresence>{props.open && <PopoverPanel key={id ?? "panel"} width={width} {...props} />}</AnimatePresence>);
}

function PopoverPanel({ anchor, width, onClose, label, children, initialFocus, returnFocus }: Omit<PopoverProps, "id"> & { readonly width: number }) {
  const panel = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionConfig();
  // False while it fades out: by then another panel may be open, and this one must not act on its presses or keys.
  const present = useIsPresent();
  const place = useAnchoredPlace(anchor, panel, width);
  useDialogFocus(panel, present, onClose, initialFocus, returnFocus);
  useOutsidePress(present, [panel, anchor], onClose);

  return (
    <motion.div
      ref={panel}
      role="dialog"
      aria-label={label}
      className={cx(
        "fixed z-50 flex flex-col overflow-y-auto overscroll-contain rounded-2xl bg-content1 text-foreground shadow-2xl ring-1 ring-default-200",
        !present && "pointer-events-none",
      )}
      style={{
        // Off screen until measured, but not hidden: focus moves into it as it opens.
        top: place ? place.top : -9999,
        bottom: place?.bottom,
        left: place?.left ?? 0,
        width: `min(${width}px, calc(100vw - ${2 * GAP}px))`,
        maxHeight: place?.maxHeight,
        transformOrigin: place?.above ? "50% 100%" : "50% 0%",
      }}
      initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "scale(0.96)" }}
      animate={reduced ? { opacity: 1 } : { opacity: 1, transform: "scale(1)" }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, transform: "scale(0.96)", transition: { duration: 0.12, ease: EASE_OUT } }}
      transition={{ duration: 0.18, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}

/**
 * A sheet from the bottom edge over the whole frame, for phones: a scrim behind it, its own scrolling body, and a
 * close button. Tapping the scrim or Esc closes it. The page behind stays where it is while the sheet is open.
 */
export function Sheet(props: OverlayProps & { readonly title: string }) {
  return portal(<AnimatePresence>{props.open && <SheetPanel key="sheet" {...props} />}</AnimatePresence>);
}

function SheetPanel({ onClose, label, title, children, initialFocus, returnFocus }: OverlayProps & { readonly title: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionConfig();
  const present = useIsPresent();
  useDialogFocus(panel, present, onClose, initialFocus, returnFocus);

  // The document is the frame's scroller: locked while the sheet covers it, so a drag on the scrim or past the end of
  // the sheet's own list doesn't scroll the page (and its pinned stage) underneath.
  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = before;
    };
  }, []);

  return (
    <>
      <motion.div
        className="fixed inset-0 z-40 touch-none bg-black/50"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2, ease: EASE_OUT }}
      />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="cp-sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-3xl bg-content1 text-foreground"
        initial={reduced ? { opacity: 0 } : { transform: "translateY(100%)" }}
        animate={reduced ? { opacity: 1 } : { transform: "translateY(0%)" }}
        exit={reduced ? { opacity: 0 } : { transform: "translateY(100%)", transition: { duration: 0.2, ease: EASE_OUT } }}
        transition={{ duration: reduced ? 0.15 : 0.28, ease: EASE_DRAWER }}
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-1">
          <h2 className="min-w-0 truncate text-base font-semibold">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="cp-press grid h-11 w-11 shrink-0 place-items-center rounded-full text-default-500 hover:bg-default-100 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </motion.div>
    </>
  );
}
