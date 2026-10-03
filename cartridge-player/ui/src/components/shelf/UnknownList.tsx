import { CircleHelp, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { type RefObject, useRef, useState } from "react";
import { useRequest } from "../../hooks/useRequest.ts";
import { useModel } from "../../model.ts";
import { EASE_OUT } from "../../motion.ts";
import { relative } from "../../view/format.ts";
import type { UnknownItem } from "../../view/library.ts";
import { ActivityPicker } from "../ActivityPicker.tsx";
import { Button, InlineError } from "../kit.tsx";
import { Popover, Sheet } from "../Overlay.tsx";

/**
 * Cartridges the player has seen that nobody labelled: the player has one slot, so these are ones that went in and
 * came out again. Each can be labelled from here, or dismissed. Either removes its row, so focus moves on to the next
 * row (else the one before, else `fallbackFocus`) instead of being lost with it.
 */
export function UnknownList({
  items,
  now,
  readOnly,
  phone,
  fallbackFocus,
}: {
  items: readonly UnknownItem[];
  now: number;
  readOnly: boolean;
  phone: boolean;
  fallbackFocus: RefObject<HTMLElement | null>;
}) {
  const reduced = useReducedMotionConfig();
  const list = useRef<HTMLUListElement>(null);
  if (!items.length) return null;

  /** The control that takes over from `tag`'s row: read from the page, where a row on its way out still is. */
  const after = (tag: string): HTMLElement | null => {
    const labels = [...(list.current?.querySelectorAll<HTMLElement>("[data-unknown]") ?? [])];
    const index = labels.findIndex((button) => button.dataset.unknown === tag);
    return (index < 0 ? null : (labels[index + 1] ?? labels[index - 1])) ?? fallbackFocus.current;
  };

  return (
    <section aria-labelledby="cp-unknown" className="rounded-2xl bg-content1 p-1 ring-1 ring-default-100">
      <h3 id="cp-unknown" className="px-3 pt-2.5 pb-1 text-xs font-semibold uppercase tracking-wider text-default-500">
        Seen, not labelled
      </h3>
      <ul ref={list}>
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.li
              key={item.tag}
              className="overflow-hidden"
              initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0, transition: { duration: 0.15, ease: EASE_OUT } }}
              transition={{ duration: 0.22, ease: EASE_OUT }}
            >
              <UnknownRow item={item} now={now} readOnly={readOnly} phone={phone} after={after} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

function UnknownRow({
  item,
  now,
  readOnly,
  phone,
  after,
}: {
  item: UnknownItem;
  now: number;
  readOnly: boolean;
  phone: boolean;
  after(tag: string): HTMLElement | null;
}) {
  const { actions } = useModel();
  const row = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const label = useRequest();
  const dismiss = useRequest();
  const close = () => setOpen(false);

  const picker = (
    <div className={phone ? "flex min-h-0 flex-col gap-2" : "flex min-h-0 flex-col gap-2 p-3"}>
      <ActivityPicker
        label="Search activities"
        autoFocus
        pending={label.pending}
        onPick={async (id) => {
          const result = await label.run(() => actions.label(item.tag, id));
          if (!result) return;
          // Labelled: this row goes, and its Label button with it.
          returnTo.current = after(item.tag);
          close();
        }}
      />
      {label.error && <InlineError className="shrink-0">{label.error}</InlineError>}
    </div>
  );

  const onDismiss = async () => {
    const done = await dismiss.run(() => actions.dismiss(item.tag).then(() => true));
    // Only when focus is still this row's to give (or was lost with it): the user may have moved on meanwhile.
    const active = document.activeElement;
    if (done && (!active || active === document.body || row.current?.contains(active))) after(item.tag)?.focus();
  };

  return (
    <div ref={row} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-3 py-2">
      <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-warning/15 text-warning">
        <CircleHelp className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs">{item.tag}</div>
        <div className="text-xs text-default-500">Seen {relative(item.lastSeenAt, now)}</div>
      </div>
      <Button
        ref={anchor}
        size="sm"
        tone="flat"
        disabled={readOnly}
        data-unknown={item.tag}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          returnTo.current = null;
          setOpen((o) => !o);
        }}
      >
        Label
      </Button>
      <Button
        size="sm"
        tone="light"
        className="w-8 px-0 [@media(pointer:coarse)]:w-11"
        aria-label={`Dismiss cartridge ${item.tag}`}
        disabled={readOnly}
        pending={dismiss.pending}
        onClick={() => void onDismiss()}
        icon={<X aria-hidden="true" className="h-4 w-4" />}
      />
      {dismiss.error && <InlineError className="basis-full">{dismiss.error}</InlineError>}
      {phone ? (
        <Sheet open={open} onClose={close} label="Label this cartridge" title="Label this cartridge" returnFocus={returnTo}>
          {picker}
        </Sheet>
      ) : (
        <Popover open={open} onClose={close} anchor={anchor} label="Label this cartridge" returnFocus={returnTo}>
          {picker}
        </Popover>
      )}
    </div>
  );
}
