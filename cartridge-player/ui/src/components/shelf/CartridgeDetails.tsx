import { ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery.ts";
import { useRequest } from "../../hooks/useRequest.ts";
import { cx } from "../../lib/cx.ts";
import { useModel } from "../../model.ts";
import { duration, since } from "../../view/format.ts";
import { FORGET_CLEARS_SLOT, forgetBlockedNote, forgetRefusal, forgetState, type LibraryItem, trackingNote } from "../../view/library.ts";
import { ActivityPicker } from "../ActivityPicker.tsx";
import { Icon } from "../Icon.tsx";
import { Button, InlineError } from "../kit.tsx";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-default-500">{label}</div>
    </div>
  );
}

/**
 * One cartridge up close: its numbers, its label, and forgetting it. It stays compact: the label is one row with
 * Change, which swaps the body for the activity picker (and back), so the overlay never holds a scrolling list inside
 * a scrolling panel and Forget is always in view. Relabelling a playing cartridge is allowed and says what it does:
 * the running session carries on, and the new label applies next time it goes in. Forgetting asks first, and is off
 * only while main would refuse it (`forgetState`): the cartridge is tracking, or it's in a player that is online.
 * One that a slot holds on the word of a player that isn't online can be forgotten, and the confirmation says that
 * this clears the slot too; if main refuses after all (it knows of players this copy can't see), that is worded here.
 *
 * Focus follows each swap: into the search (on a touch screen onto Back, so the keyboard waits for a tap on the
 * search), back to Change, onto Keep, back to Forget.
 */
export function CartridgeDetails({
  item,
  now,
  readOnly,
  className,
  onRelabelled,
  onForgotten,
}: {
  item: LibraryItem;
  now: number;
  readOnly: boolean;
  /** The overlay's padding, which this applies to whichever body it shows. */
  className?: string;
  onRelabelled(tag: string): void;
  onForgotten(tag: string): void;
}) {
  const { actions, record, live, presence } = useModel();
  const touch = useMediaQuery("(pointer: coarse)");
  const relabel = useRequest();
  const forget = useRequest();
  const [picking, setPicking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const change = useRef<HTMLButtonElement>(null);
  const forgetButton = useRef<HTMLButtonElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  // Which control to hand focus back to when a body or the confirmation closes; null while nothing was opened here.
  const back = useRef<"change" | "forget" | null>(null);
  const { activity } = item;
  const note = trackingNote(item);
  const forgetting = forgetState(record, item.tag, live, presence);
  const canForget = forgetting === "free" || forgetting === "held";
  const blocked = canForget ? null : forgetBlockedNote(forgetting);
  // The confirmation is for a forget that is on offer: if the cartridge starts tracking or its player comes online
  // while it's open, the button's explanation takes its place.
  const confirming = confirm && canForget;
  useEffect(() => {
    if (!canForget) setConfirm(false);
  }, [canForget]);

  useEffect(() => {
    if (picking || confirming) return;
    if (back.current === "change") change.current?.focus();
    if (back.current === "forget") forgetButton.current?.focus();
    back.current = null;
  }, [picking, confirming]);

  // The confirmation is taller than the button it replaces: bring it into the overlay's view.
  useEffect(() => {
    if (confirming) confirmation.current?.scrollIntoView({ block: "nearest" });
  }, [confirming]);

  if (picking) {
    return (
      <div className={cx("flex min-h-0 flex-col gap-2", className)}>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            tone="light"
            className="-ml-2"
            autoFocus={touch}
            icon={<ChevronLeft aria-hidden="true" className="h-4 w-4" />}
            onClick={() => {
              back.current = "change";
              setPicking(false);
            }}
          >
            Back
          </Button>
          <h3 className="min-w-0 truncate text-sm font-semibold">{activity ? "Change label" : "Label cartridge"}</h3>
        </div>
        {note && <p className="shrink-0 text-xs leading-snug text-default-500">{note}</p>}
        <ActivityPicker
          label="Search activities"
          autoFocus={!touch}
          value={activity?.id ?? null}
          disabled={readOnly}
          pending={relabel.pending}
          onPick={async (id) => {
            if (id === item.activityId) {
              back.current = "change";
              setPicking(false);
              return;
            }
            const result = await relabel.run(() => actions.label(item.tag, id));
            if (result) onRelabelled(item.tag);
          }}
        />
        {relabel.error && <InlineError className="shrink-0">{relabel.error}</InlineError>}
      </div>
    );
  }

  return (
    <div className={cx("shrink-0 space-y-4", className)}>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-xl", !activity && "bg-default-100 text-default-400")}
          style={{ background: activity ? `color-mix(in srgb, ${activity.color} 20%, transparent)` : undefined }}
        >
          <Icon path={activity?.iconPath ?? null} color={activity?.color} className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <div className="line-clamp-2 font-semibold leading-snug [overflow-wrap:anywhere]">
            {activity?.name ?? <span className="text-danger">Activity deleted</span>}
            {activity?.archived && (
              <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 align-middle text-[11px] font-medium text-warning">Archived</span>
            )}
          </div>
          <div className="truncate font-mono text-[11px] text-default-400">{item.tag}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-xl bg-default-100 p-2.5 text-center">
        <Stat label="Plays" value={String(item.plays)} />
        <Stat label="Played" value={duration(item.playedMs)} />
        <Stat label="Last" value={item.inSlot ? "In now" : item.seenAt === null ? "Never" : since(item.seenAt, now)} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-default-500">Label</h3>
            <div className="truncate text-sm">{activity?.name ?? "None: its activity was deleted"}</div>
          </div>
          <Button ref={change} size="sm" tone="flat" disabled={readOnly} onClick={() => setPicking(true)}>
            {activity ? "Change" : "Label"}
          </Button>
        </div>
        {note && <p className="text-xs leading-snug text-default-500">{note}</p>}
      </div>

      {confirming ? (
        <div ref={confirmation} className="space-y-2 rounded-xl bg-danger/10 p-3 text-sm">
          <p>Forget this cartridge? Next time it goes in, the player treats it as new. Its plays and time go too.</p>
          {forgetting === "held" && <p>{FORGET_CLEARS_SLOT}</p>}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              tone="light"
              // The safe answer has focus: Enter on "Forget cartridge" never forgets by itself.
              autoFocus
              disabled={forget.pending}
              onClick={() => {
                back.current = "forget";
                setConfirm(false);
              }}
            >
              Keep
            </Button>
            <Button
              size="sm"
              tone="danger"
              pending={forget.pending}
              onClick={async () => {
                const done = await forget.run(() => actions.forget(item.tag).then(() => true));
                if (done) onForgotten(item.tag);
              }}
            >
              Forget
            </Button>
          </div>
          {forget.error && <InlineError>{forgetRefusal(forget.cause, forgetting) ?? forget.error}</InlineError>}
        </div>
      ) : (
        <Button
          ref={forgetButton}
          size="sm"
          tone="danger-light"
          className="w-full"
          disabled={readOnly || !canForget}
          onClick={() => setConfirm(true)}
        >
          {canForget ? "Forget cartridge" : "Take it out of the player to forget it"}
        </Button>
      )}
      {blocked && <p className="text-xs leading-snug text-default-500">{blocked}</p>}
      {readOnly && <p className="text-xs text-default-500">Changes need the plugin running.</p>}
    </div>
  );
}
