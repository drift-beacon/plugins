import { Check, Search } from "lucide-react";
import { type ComponentPropsWithoutRef, type KeyboardEvent, type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import { cx } from "../lib/cx.ts";
import { useModel } from "../model.ts";
import { flatten, pickerGroups } from "../view/picker.ts";
import { Icon } from "./Icon.tsx";
import { portal, useAnchoredPlace, useOutsidePress } from "./Overlay.tsx";

interface ActivityPickerProps {
  /** The activity the cartridge carries now: checked in the list, and where the highlight starts. */
  readonly value?: string | null;
  onPick(activityId: string): void;
  /** The search field's accessible name, and its placeholder. */
  readonly label: string;
  /**
   * `inline`: the list is always there under the search, in an overlay the user opened; it takes the height the
   * overlay has left and is its one scrolling region. `typeahead`: the list floats under the field once the user
   * types or presses Down, over the page rather than in it, so a prompt on the stage keeps its height while it's used.
   */
  readonly mode?: "inline" | "typeahead";
  readonly autoFocus?: boolean;
  /** Changes can't be made now (main isn't running). */
  readonly disabled?: boolean;
  /**
   * A pick is on its way to main. The field keeps its focus and its text and the list stays where it is, dimmed;
   * both ignore input until the answer arrives, so a failure leaves the user exactly where they were.
   */
  readonly pending?: boolean;
  readonly className?: string;
}

/** The floating list is never taller than this, however much room there is. */
const FLOATING_MAX = 256;

/**
 * The one activity picker: a search field over the activities grouped by category (uncategorised last, archived left
 * out), each with its icon and colour. A combobox: arrow keys move through the list while focus stays in the field,
 * Enter picks, Esc clears the search. The highlight starts on the cartridge's current activity, so Enter changes
 * nothing until the user has moved it or typed, and it only shows while the field has focus or the pointer is over
 * the list: on a touch screen the check mark alone says what's selected.
 */
export function ActivityPicker({ value = null, onPick, label, mode = "inline", autoFocus, disabled, pending = false, className }: ActivityPickerProps) {
  const { activities, categories } = useModel();
  const listId = useId();
  const fieldRef = useRef<HTMLLabelElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const floating = mode === "typeahead";
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(!floating);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const groups = useMemo(() => pickerGroups(activities, categories, query), [activities, categories, query]);
  const options = useMemo(() => flatten(groups), [groups]);
  const [active, setActive] = useState<string | null>(null);
  const has = (id: string | null) => id !== null && options.some((option) => option.id === id);
  // Where the user moved it; else the current activity while nothing is typed; else the first match.
  const activeId = has(active) ? active : !query.trim() && has(value) ? value : (options[0]?.id ?? null);
  const optionId = (id: string) => `${listId}-${id}`;
  const shown = open && !disabled;

  useEffect(() => {
    if (!shown || !activeId) return;
    const row = document.getElementById(optionId(activeId));
    const list = listRef.current;
    if (!row || !list) return;
    // Scroll only the list: scrolling the page would move a popover's anchor away from it.
    const item = row.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    if (item.top < bounds.top) list.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
  }, [activeId, shown]);

  const move = (step: number) => {
    if (!options.length) return;
    const index = options.findIndex((o) => o.id === activeId);
    setActive(options[(index + step + options.length) % options.length].id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (pending) return;
      if (!open) setOpen(true);
      else move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && shown && activeId) {
      event.preventDefault();
      if (!pending) onPick(activeId);
    } else if (event.key === "Escape" && (query || (open && floating))) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      if (floating) setOpen(false);
    }
  };

  const listProps = {
    id: listId,
    role: "listbox",
    "aria-label": label,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  } as const;
  const rows = (
    <div className={cx(pending && "pointer-events-none opacity-50")}>
      {groups.map((group) => (
        <div key={group.category.id || "none"} role="group" aria-labelledby={`${listId}-g-${group.category.id || "none"}`}>
          <div
            id={`${listId}-g-${group.category.id || "none"}`}
            className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-default-400"
          >
            {group.category.name}
          </div>
          {group.activities.map((activity) => {
            const current = activity.id === value;
            return (
              <div
                key={activity.id}
                id={optionId(activity.id)}
                role="option"
                aria-selected={current}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActive(activity.id)}
                onClick={() => onPick(activity.id)}
                className={cx(
                  "cp-touch flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm",
                  activity.id === activeId && (focused || hovered) ? "bg-default-100 text-foreground" : "text-default-600",
                )}
              >
                <span
                  aria-hidden="true"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
                  style={{ background: `color-mix(in srgb, ${activity.color} 18%, transparent)` }}
                >
                  <Icon path={activity.iconPath} color={activity.color} className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1 truncate">{activity.name}</span>
                {activity.point && <span className="shrink-0 text-[11px] text-default-400">Marks</span>}
                {current && <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-default-500" />}
              </div>
            );
          })}
        </div>
      ))}
      {options.length === 0 && (
        <p className="px-2 py-3 text-sm text-default-500">
          {activities.some((a) => !a.archived)
            ? `Nothing matches “${query.trim()}”.`
            : "There are no activities yet. Create one in Drift Beacon, then label the cartridge with it."}
        </p>
      )}
    </div>
  );

  return (
    <div className={cx("min-w-0", !floating && "flex min-h-0 flex-col", className)}>
      <label ref={fieldRef} className="relative block shrink-0">
        <span className="sr-only">{label}</span>
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-default-400" />
        <input
          type="text"
          role="combobox"
          aria-expanded={shown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown && activeId ? optionId(activeId) : undefined}
          aria-disabled={pending || undefined}
          aria-busy={pending || undefined}
          autoComplete="off"
          spellCheck={false}
          // Only when the user opened the picker themselves: never on a cartridge arriving.
          autoFocus={autoFocus}
          disabled={disabled}
          readOnly={pending}
          placeholder={label}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(null);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            // A floating list belongs to the field while it's being used; options keep focus in the field when clicked.
            if (floating) setOpen(false);
          }}
          className="cp-touch h-10 w-full rounded-xl bg-default-100 pr-3 pl-9 text-sm text-foreground outline-none placeholder:text-default-400 focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 aria-disabled:opacity-60"
        />
      </label>
      {shown &&
        (floating ? (
          <FloatingList anchor={fieldRef} list={listRef} onDismiss={() => setOpen(false)} {...listProps}>
            {rows}
          </FloatingList>
        ) : (
          <div ref={listRef} {...listProps} className="mt-2 min-h-0 overflow-y-auto overscroll-contain rounded-xl min-[600px]:max-h-72">
            {rows}
          </div>
        ))}
    </div>
  );
}

/**
 * The typeahead's list as a panel over the page, hung from the field (under it, or above when there's no room): it
 * has its own height limit, scrolls itself, and closes on a press anywhere else. It's portalled because the stage
 * clips what's inside it.
 */
function FloatingList({
  anchor,
  list,
  onDismiss,
  children,
  ...props
}: { anchor: RefObject<HTMLElement | null>; list: RefObject<HTMLDivElement | null>; onDismiss(): void } & ComponentPropsWithoutRef<"div">) {
  const place = useAnchoredPlace(anchor, list, "anchor", 120);
  useOutsidePress(true, [anchor, list], onDismiss);
  return portal(
    <div
      ref={list}
      {...props}
      className="cp-pop fixed z-50 overflow-y-auto overscroll-contain rounded-xl bg-content1 p-1 text-foreground shadow-xl ring-1 ring-default-200"
      style={{
        // Off screen until measured.
        top: place ? place.top : -9999,
        bottom: place?.bottom,
        left: place?.left ?? 0,
        width: place?.width,
        maxHeight: Math.min(place?.maxHeight ?? FLOATING_MAX, FLOATING_MAX),
        transformOrigin: place?.above ? "50% 100%" : "50% 0%",
      }}
    >
      {children}
    </div>,
  );
}
