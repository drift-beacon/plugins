import { Search } from "lucide-react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNow } from "../../hooks/useNow.ts";
import { cx } from "../../lib/cx.ts";
import { useModel } from "../../model.ts";
import { EASE_OUT, SPRING_SETTLE } from "../../motion.ts";
import { count, duration, relative } from "../../view/format.ts";
import { buildLibrary, itemLabel, type SortKey, SORTS, sortLibrary, unknownItems } from "../../view/library.ts";
import { fold } from "../../view/picker.ts";
import { Popover, Sheet } from "../Overlay.tsx";
import { Segmented } from "../Segmented.tsx";
import { CartridgeDetails } from "./CartridgeDetails.tsx";
import { ShelfCartridge } from "./ShelfCartridge.tsx";
import { UnknownList } from "./UnknownList.tsx";

/** Past this many cartridges the shelf stops animating reorders (and offers a filter): measuring each costs. */
const MANY = 24;
/** Past this many, a filter field appears above the shelf. */
const FILTER_FROM = 12;
/** How long a freshly relabelled cartridge's sticker keeps its "just applied" look. */
const FRESH_MS = 2200;

/**
 * The shelf: every labelled cartridge as an object, sortable, each opening its details (a popover here, a sheet on a
 * phone); above it, the cartridges seen but not labelled. Read-only while main isn't running.
 */
export function Shelf({ stageTag, readOnly, phone, heard }: { stageTag: string | null; readOnly: boolean; phone: boolean; heard: boolean }) {
  const model = useModel();
  const reduced = useReducedMotionConfig();
  const now = useNow(60_000);
  const [sort, setSort] = useState<SortKey>("recent");
  const [filter, setFilter] = useState("");
  const [openTag, setOpenTag] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // Where focus goes when the details close, when it shouldn't be the card that opened them (it was forgotten).
  const returnTo = useRef<HTMLElement | null>(null);
  // The shelf's own arrival staggers its cards in; cartridges added later just fade in.
  const firstMount = useRef(true);
  useEffect(() => {
    firstMount.current = false;
  }, []);
  useEffect(() => {
    if (!fresh) return;
    const id = window.setTimeout(() => setFresh(null), FRESH_MS);
    return () => window.clearTimeout(id);
  }, [fresh]);

  const library = useMemo(
    () => buildLibrary(model.mappings, model.record, model.lookup, model.live),
    [model.mappings, model.record, model.lookup, model.live],
  );
  const sorted = useMemo(() => sortLibrary(library, sort), [library, sort]);
  const shown = useMemo(() => {
    const q = fold(filter);
    return q ? sorted.filter((item) => fold(`${item.activity?.name ?? ""} ${item.activity?.categoryName ?? ""} ${item.tag}`).includes(q)) : sorted;
  }, [sorted, filter]);
  const unknown = useMemo(() => unknownItems(model.record, model.mappings, stageTag), [model.record, model.mappings, stageTag]);
  const openItem = openTag ? (library.find((item) => item.tag === openTag) ?? null) : null;
  const animateLayout = !reduced && library.length <= MANY;

  const onOpen = useCallback((tag: string, button: HTMLButtonElement) => {
    anchor.current = button;
    returnTo.current = null;
    setOpenTag((current) => (current === tag ? null : tag));
  }, []);
  const close = useCallback(() => setOpenTag(null), []);
  const cardOf = (tag: string) => list.current?.querySelector<HTMLElement>(`[data-cartridge="${tag}"]`) ?? null;

  /** A forgotten cartridge's card is leaving the shelf: focus goes to its neighbour, or the shelf's heading. */
  const onForgotten = (tag: string) => {
    const index = shown.findIndex((item) => item.tag === tag);
    const neighbour = shown[index + 1] ?? shown[index - 1];
    const target = (neighbour && cardOf(neighbour.tag)) || heading.current;
    returnTo.current = target;
    // Storage can answer before the request does: the details have then closed already and handed focus back to the
    // leaving card (or lost it), so it's moved on from there.
    const active = document.activeElement;
    if (!active || active === document.body || active === cardOf(tag)) target?.focus();
    close();
  };

  const details = openItem && (
    <CartridgeDetails
      key={openItem.tag}
      item={openItem}
      now={now}
      readOnly={readOnly}
      className={phone ? undefined : "p-3.5"}
      onRelabelled={(tag) => {
        setFresh(tag);
        close();
      }}
      onForgotten={onForgotten}
    />
  );
  const title = openItem?.activity?.name ?? "Cartridge";

  return (
    <section aria-labelledby="cp-shelf" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 ref={heading} id="cp-shelf" tabIndex={-1} className="text-lg font-semibold">
            Your cartridges
          </h2>
          <p className="text-sm text-default-500">
            {library.length ? `${count(library.length, "cartridge")} labelled` : "None labelled yet"}
            {library.length > 0 && " · insert a blank one to add it here"}
          </p>
        </div>
        {library.length > 1 && <Segmented<SortKey> label="Sort cartridges" value={sort} options={SORTS} onChange={setSort} />}
      </div>

      <UnknownList items={unknown} now={now} readOnly={readOnly} phone={phone} fallbackFocus={heading} />

      {library.length > FILTER_FROM && (
        <label className="relative block max-w-sm">
          <span className="sr-only">Filter cartridges</span>
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-default-400" />
          <input
            type="search"
            value={filter}
            placeholder="Filter cartridges"
            onChange={(event) => setFilter(event.target.value)}
            className="cp-touch h-9 w-full rounded-full bg-default-100 pr-3 pl-9 text-sm outline-none placeholder:text-default-400 focus-visible:ring-2 focus-visible:ring-focus"
          />
        </label>
      )}

      {library.length === 0 ? (
        <EmptyShelf heard={heard} noActivities={!model.activities.some((a) => !a.archived)} />
      ) : (
        <ul ref={list} className={cx("grid", phone ? "grid-cols-2 gap-x-3 gap-y-5" : "grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5")}>
          <AnimatePresence mode="popLayout">
            {shown.map((item, index) => {
              const lastSeen = item.seenAt === null ? null : relative(item.seenAt, now);
              const played = duration(item.playedMs);
              return (
                <motion.li
                  key={item.tag}
                  layout={animateLayout ? "position" : false}
                  initial={firstMount.current && !reduced ? { opacity: 0, transform: "translateY(8px)" } : { opacity: 0 }}
                  animate={{ opacity: 1, transform: "translateY(0px)" }}
                  exit={{ opacity: 0, transition: { duration: 0.15, ease: EASE_OUT } }}
                  transition={{
                    duration: 0.3,
                    ease: EASE_OUT,
                    delay: firstMount.current && !reduced ? Math.min(index, 8) * 0.04 : 0,
                    layout: SPRING_SETTLE,
                  }}
                >
                  <ShelfCartridge
                    item={item}
                    lastSeen={lastSeen}
                    played={played}
                    label={itemLabel(item, lastSeen, played)}
                    fresh={fresh === item.tag}
                    open={openTag === item.tag}
                    onOpen={onOpen}
                  />
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
      {library.length > 0 && shown.length === 0 && <p className="text-sm text-default-500">No cartridge matches “{filter.trim()}”.</p>}

      {phone ? (
        <Sheet open={!!openItem} onClose={close} label={title} title="Cartridge" returnFocus={returnTo}>
          {details}
        </Sheet>
      ) : (
        <Popover id={openItem?.tag} open={!!openItem} onClose={close} anchor={anchor} label={title} width={320} returnFocus={returnTo}>
          {details}
        </Popover>
      )}
    </section>
  );
}

/** No cartridges yet: one dashed ghost of a cartridge that says how to add one. */
function EmptyShelf({ heard, noActivities }: { heard: boolean; noActivities: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      <div className="col-span-2 flex aspect-[8/5] items-center justify-center rounded-2xl border border-dashed border-default-200 p-5 text-center sm:col-span-1 sm:aspect-[4/5]">
        <p className="text-sm leading-snug text-default-500">
          {noActivities
            ? "Create an activity in Drift Beacon first, then label a cartridge with it."
            : heard
              ? "Insert a blank cartridge to label it."
              : "Set up your player, then insert a blank cartridge to label it."}
        </p>
      </div>
    </div>
  );
}
