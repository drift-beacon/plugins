import { Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { cn } from "@heroui/theme";
import { Check } from "lucide-react";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { ACTIVITIES, CATEGORIES, MDI, spanActivitiesIn } from "./fixtures";
import { type Mapping, mappingKey, sameMapping } from "./model";
import { EASE_OUT } from "./motion";

type Row = { key: string; mapping: Mapping; name: string; color: string; iconPath: string; disabled: boolean; /** Matches the search itself (not just shown for context). */ hit: boolean } & (
  | { kind: "category"; count: number }
  | { kind: "activity"; point: boolean }
);

function buildRows(query: string, categoriesOnly: boolean, taken: Set<string>): Row[] {
  const q = query.trim().toLowerCase();
  const rows: Row[] = [];
  for (const c of CATEGORIES) {
    const catHit = !q || c.name.toLowerCase().includes(q);
    const acts = categoriesOnly ? [] : ACTIVITIES.filter((x) => x.categoryId === c.id && (catHit || x.name.toLowerCase().includes(q)));
    if (!catHit && acts.length === 0) continue;
    const cm: Mapping = { type: "category", id: c.id };
    // A category whose activity matched still shows (as the group it belongs to), but isn't where the search lands.
    rows.push({ kind: "category", key: mappingKey(cm), mapping: cm, name: c.name, color: c.color, iconPath: c.iconPath, count: spanActivitiesIn(c.id).length, disabled: taken.has(mappingKey(cm)), hit: catHit });
    for (const x of acts) {
      const am: Mapping = { type: "activity", id: x.id };
      rows.push({ kind: "activity", key: mappingKey(am), mapping: am, name: x.name, color: x.color, iconPath: x.iconPath, point: x.trackingType === "point", disabled: taken.has(mappingKey(am)), hit: true });
    }
  }
  return rows;
}

interface PickerPanelProps {
  value: Mapping | null;
  onSelect: (m: Mapping | null) => void;
  onClose?: () => void;
  /** Choices already used elsewhere (the other side of a duel, picks already on the shortlist). */
  exclude?: (Mapping | null)[];
  categoriesOnly?: boolean;
  /** Offer a way to empty the slot. */
  clearLabel?: string;
  autoFocus?: boolean;
  className?: string;
}

/**
 * The one activity picker. Search on top, then each category as an "Any ‹Category›" row (a random draw) followed
 * by its activities. Arrow keys move, Enter picks, Esc closes. The current choice is checked.
 */
export function PickerPanel({ value, onSelect, onClose, exclude = [], categoriesOnly, clearLabel, autoFocus = true, className }: PickerPanelProps) {
  const [query, setQuery] = useState("");
  const taken = useMemo(() => new Set(exclude.filter((m): m is Mapping => !!m && !sameMapping(m, value)).map(mappingKey)), [exclude, value]);
  const rows = useMemo(() => buildRows(query, !!categoriesOnly, taken), [query, categoriesOnly, taken]);
  const selectable = rows.filter((r) => !r.disabled);
  const [active, setActive] = useState<string | null>(() => (value ? mappingKey(value) : (selectable[0]?.key ?? null)));
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Typing moves the highlight to the first real match (not a group shown only for context).
  useEffect(() => {
    if (query) setActive((selectable.find((r) => r.hit) ?? selectable[0])?.key ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  useEffect(() => {
    if (active) rowRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const move = (dir: 1 | -1) => {
    if (!selectable.length) return;
    const i = selectable.findIndex((r) => r.key === active);
    const next = selectable[(i + dir + selectable.length) % selectable.length];
    setActive(next.key);
  };

  return (
    <div className={cn("flex flex-col", className)}>
      <label className="flex items-center gap-2 border-b border-default-100 px-3.5 py-3">
        <Icon path={MDI.magnify} className="h-4 w-4 shrink-0 text-default-400" />
        <input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              const row = selectable.find((r) => r.key === active);
              if (row) onSelect(row.mapping);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose?.();
            }
          }}
          placeholder={categoriesOnly ? "Search categories" : "Search activities and categories"}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-default-400"
          role="combobox"
          aria-expanded
          aria-controls="picker-list"
          aria-activedescendant={active ? `pick-${active}` : undefined}
        />
      </label>

      <div id="picker-list" role="listbox" className="max-h-[320px] overflow-y-auto overscroll-contain p-1.5">
        {rows.length === 0 && <div className="px-3 py-6 text-center text-sm text-default-400">Nothing matches “{query}”</div>}
        {rows.map((r) => {
          const isOn = sameMapping(r.mapping, value);
          const isActive = active === r.key;
          return (
            <button
              key={r.key}
              id={`pick-${r.key}`}
              ref={(el) => {
                rowRefs.current[r.key] = el;
              }}
              type="button"
              role="option"
              aria-selected={isOn}
              aria-disabled={r.disabled}
              disabled={r.disabled}
              onPointerMove={() => !r.disabled && setActive(r.key)}
              onClick={() => onSelect(r.mapping)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-xl text-left",
                r.kind === "category" ? "mt-1 px-2 py-1.5 first:mt-0" : "py-1.5 pl-[46px] pr-2",
                isActive && "bg-default-100",
                r.disabled && "cursor-not-allowed opacity-40",
              )}
            >
              {r.kind === "category" ? (
                <>
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg" style={{ background: `${r.color}26` }}>
                    <Icon path={r.iconPath} color={r.color} className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">Any {r.name}</span>
                  <span className="flex shrink-0 items-center gap-1 text-xs text-default-400">
                    <Icon path={MDI.shuffle} className="h-3 w-3" />
                    {r.count}
                  </span>
                </>
              ) : (
                <>
                  <Icon path={r.iconPath} color={r.color} className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
                  {r.point && <span className="shrink-0 rounded-md bg-default-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-default-500">Point</span>}
                </>
              )}
              {r.disabled ? (
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-default-400">Taken</span>
              ) : (
                <Check className={cn("h-4 w-4 shrink-0 text-primary", !isOn && "invisible")} strokeWidth={2.5} />
              )}
            </button>
          );
        })}
      </div>

      {clearLabel && value && (
        <button type="button" onClick={() => onSelect(null)} className="border-t border-default-100 px-3.5 py-2.5 text-left text-sm text-default-500 hover:bg-default-50 hover:text-foreground">
          {clearLabel}
        </button>
      )}
    </div>
  );
}

// HeroUI animates the panel with these variants: out of the trigger (its placement sets the origin), fast out.
const POP_MOTION = {
  variants: {
    enter: { opacity: 1, scale: 1, transition: { duration: 0.18, ease: EASE_OUT } },
    exit: { opacity: 0, scale: 0.96, transition: { duration: 0.12, ease: EASE_OUT } },
  },
};

interface PickerPopoverProps extends Omit<PickerPanelProps, "onClose" | "className" | "autoFocus"> {
  /** The card that opens the picker. It gets told whether it's open, to show that it is. */
  children: (open: boolean) => ReactElement;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: "bottom" | "bottom-start" | "bottom-end" | "top" | "right" | "left";
}

/** Any card becomes the picker's trigger: the whole card, no separate dropdown inside it. */
export function PickerPopover({ children, isOpen, onOpenChange, placement = "bottom", onSelect, ...panel }: PickerPopoverProps) {
  const [inner, setInner] = useState(false);
  const open = isOpen ?? inner;
  const setOpen = (o: boolean) => (onOpenChange ? onOpenChange(o) : setInner(o));
  return (
    <Popover
      isOpen={open}
      onOpenChange={setOpen}
      placement={placement}
      offset={10}
      triggerScaleOnOpen={false}
      shouldBlockScroll={false}
      motionProps={POP_MOTION}
      classNames={{ content: "overflow-hidden rounded-2xl border-none bg-content1 p-0 shadow-2xl ring-1 ring-default-200" }}
    >
      <PopoverTrigger>{children(open)}</PopoverTrigger>
      <PopoverContent>
        <PickerPanel
          {...panel}
          className="w-[340px]"
          onClose={() => setOpen(false)}
          onSelect={(m) => {
            onSelect(m);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
