import { cn } from "@heroui/theme";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { motion, Reorder, useDragControls, useReducedMotion } from "motion/react";
import {
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { cssRgb } from "../../../../shared/color.ts";
import type { PlacedPanel, Rgb } from "../../../../shared/types.ts";
import { inkOn } from "../../lib/color.ts";
import { panelName } from "../../lib/panels.ts";
import { EASE_OUT, SPRING_SETTLE } from "../../motion.ts";
import { ShapeGlyph } from "./ShapeGlyph.tsx";
import type { PanelFlash } from "./StageCanvas.tsx";

interface OrderListProps {
  readonly order: readonly number[];
  readonly panels: ReadonlyMap<number, PlacedPanel>;
  readonly focusId: number | null;
  /** A panel picked on the drawing or touched on the wall: its row rings once and scrolls into view. */
  readonly flash: PanelFlash | null;
  readonly accent: Rgb;
  /** Hover or keyboard focus on a row (null when it leaves). */
  onFocus(id: number | null): void;
  /** Move one panel a place earlier (-1) or later (1). */
  onMove(id: number, by: -1 | 1): void;
  /** A drag finished with a new order. */
  onCommit(ids: readonly number[]): void;
  /** The order while a row is being dragged (null once it's dropped), so the drawing's numbers follow live. */
  onPreview(ids: readonly number[] | null): void;
}

/**
 * The sequence as a list: drag a row by its handle, or use its earlier/later buttons from the keyboard. Hovering or
 * focusing a row lights its panel on the drawing (and on the wall).
 */
export function OrderList({
  order,
  panels,
  focusId,
  flash,
  accent,
  onFocus,
  onMove,
  onCommit,
  onPreview,
}: OrderListProps) {
  const [dragged, setDragged] = useState<number[] | null>(null);
  const rows = dragged ?? order;
  const n = rows.length;

  const finish = () => {
    if (!dragged) return;
    const changed = dragged.some((id, i) => id !== order[i]);
    setDragged(null);
    onPreview(null);
    if (changed) onCommit(dragged);
  };

  return (
    <Reorder.Group
      as="ol"
      axis="y"
      values={rows as number[]}
      onReorder={(next: number[]) => {
        setDragged(next);
        onPreview(next);
      }}
      layoutScroll
      className="-mx-1.5 max-h-[min(58vh,420px)] space-y-1 overflow-y-auto overscroll-contain px-1.5 py-0.5"
      aria-label="Fill order"
    >
      {rows.map((id, k) => {
        const panel = panels.get(id);
        if (!panel) return null;
        return (
          <Row
            key={id}
            panel={panel}
            index={k}
            count={n}
            focused={focusId === id}
            flash={flash?.id === id ? flash.n : 0}
            accent={accent}
            onFocus={onFocus}
            onMove={onMove}
            onDragEnd={finish}
          />
        );
      })}
    </Reorder.Group>
  );
}

interface RowProps {
  readonly panel: PlacedPanel;
  readonly index: number;
  readonly count: number;
  readonly focused: boolean;
  readonly flash: number;
  readonly accent: Rgb;
  onFocus(id: number | null): void;
  onMove(id: number, by: -1 | 1): void;
  onDragEnd(): void;
}

function Row({ panel, index, count, focused, flash, accent, onFocus, onMove, onDragEnd }: RowProps) {
  const controls = useDragControls();
  const reduced = useReducedMotion();
  const ref = useRef<HTMLLIElement>(null);
  const name = panelName(panel);
  // Bring a flashed row into view inside the list only: scrolling the page would yank the drawing away.
  useEffect(() => {
    const row = ref.current;
    const list = row?.parentElement;
    if (!flash || !row || !list) return;
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    const bottom = top + row.offsetHeight;
    const behavior = reduced ? "auto" : "smooth";
    if (top < list.scrollTop) list.scrollTo({ top: top - 4, behavior });
    else if (bottom > list.scrollTop + list.clientHeight)
      list.scrollTo({ top: bottom - list.clientHeight + 4, behavior });
  }, [flash, reduced]);

  const grab = (e: ReactPointerEvent) => {
    e.preventDefault();
    controls.start(e);
  };
  return (
    <Reorder.Item
      ref={ref}
      value={panel.id}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => onFocus(panel.id)}
      onDragEnd={(e) => {
        // A drag by the grip never moves DOM focus (touch least of all), so no blur would ever clear the highlight
        // (and the wall's identify) it set: let go of it here, unless the row holds focus or a mouse still hovers it.
        const row = ref.current;
        const hovered = "pointerType" in e && e.pointerType === "mouse" && row?.matches(":hover");
        if (!hovered && !row?.contains(document.activeElement)) onFocus(null);
        onDragEnd();
      }}
      transition={{ layout: reduced ? { duration: 0 } : SPRING_SETTLE }}
      whileDrag={{ boxShadow: "0 12px 28px -8px rgb(0 0 0 / 0.6)", zIndex: 10 }}
      onPointerEnter={(e) => e.pointerType === "mouse" && onFocus(panel.id)}
      onPointerLeave={(e) => e.pointerType === "mouse" && onFocus(null)}
      onFocus={() => onFocus(panel.id)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && onFocus(null)}
      className={cn(
        "group relative flex items-center gap-1.5 rounded-xl py-1 pr-1 pl-0.5 transition-colors duration-150",
        focused ? "bg-default-100" : "bg-content1",
      )}
    >
      <span
        onPointerDown={grab}
        className={cn(
          "grid h-8 w-6 shrink-0 cursor-grab touch-none place-items-center text-default-300 transition-colors",
          "duration-150 hover:text-default-500 active:cursor-grabbing",
        )}
        aria-hidden
      >
        <GripVertical className="h-4 w-4" />
      </span>
      <span
        className={cn(
          "grid h-7 w-7 shrink-0 place-items-center rounded-lg font-semibold text-xs tabular-nums transition-colors",
          "duration-150",
        )}
        style={focused ? { background: cssRgb(accent), color: inkOn(accent) } : undefined}
      >
        <span className={cn(!focused && "text-default-600")}>{index + 1}</span>
      </span>
      {/* The name says the shape too: the glyph goes first when the editor is narrow (beside the drawing). */}
      <ShapeGlyph kind={panel.kind} className="@xs:block hidden h-4 w-4 shrink-0 text-default-400" />
      {/* In a narrow editor the shape's name gives way before the id, which is what tells two panels apart. */}
      <span className="flex min-w-0 flex-1 items-baseline gap-1 text-sm">
        <span className="min-w-0 truncate">{name.slice(0, name.lastIndexOf(" "))}</span>
        <span className="shrink-0 text-default-500 text-xs tabular-nums">{panel.id}</span>
      </span>
      <MoveButton label={`Move ${name} earlier`} disabled={index === 0} onPress={() => onMove(panel.id, -1)}>
        <ChevronUp className="h-4 w-4" />
      </MoveButton>
      <MoveButton label={`Move ${name} later`} disabled={index === count - 1} onPress={() => onMove(panel.id, 1)}>
        <ChevronDown className="h-4 w-4" />
      </MoveButton>
      {flash > 0 && (
        <motion.span
          key={flash}
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2"
          style={{ "--tw-ring-color": cssRgb(accent) } as CSSProperties}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0] }}
          transition={{ duration: 0.9, times: [0, 0.15, 1], ease: EASE_OUT }}
        />
      )}
    </Reorder.Item>
  );
}

function MoveButton({
  label,
  disabled,
  onPress,
  children,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  // aria-disabled rather than disabled: a row moved to the top keeps keyboard focus on its button.
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-disabled={disabled}
      onClick={() => !disabled && onPress()}
      className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded-lg text-default-400",
        "transition-[background-color,color,transform,opacity] duration-150 ease-out hover:bg-default-200",
        "hover:text-foreground active:scale-[0.9] aria-disabled:cursor-default aria-disabled:bg-transparent",
        "aria-disabled:text-default-400 aria-disabled:opacity-25 aria-disabled:active:scale-100",
      )}
    >
      {children}
    </button>
  );
}
