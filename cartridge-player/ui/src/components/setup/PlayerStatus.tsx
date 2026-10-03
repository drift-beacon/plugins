import { ChevronDown, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DeviceRecord } from "../../../../shared/storage.ts";
import { useNow } from "../../hooks/useNow.ts";
import { cx } from "../../lib/cx.ts";
import { useModel } from "../../model.ts";
import { relative } from "../../view/format.ts";
import { type Health, presenceView, type PresenceView } from "../../view/presence.ts";
import { Button } from "../kit.tsx";
import { Popover, Sheet } from "../Overlay.tsx";
import { SetupGuide } from "./SetupGuide.tsx";

const DOT: Record<Health, string> = {
  online: "bg-success",
  offline: "bg-danger",
  // Not a fault and not yet good news: the same quiet dot as "nobody is listening".
  waiting: "bg-default-300",
  none: "bg-default-300",
  unknown: "bg-default-300",
};

/**
 * The player's presence as a pill that opens the Player panel: who it is, when it was last heard, and setting up a
 * player. Relative times refresh every 30 seconds here, and nowhere else re-renders for them.
 */
export function PlayerStatus({ device, phone }: { device: DeviceRecord | null; phone: boolean }) {
  const { presence } = useModel();
  const now = useNow(30_000);
  const view = presenceView(presence, device, now);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const fault = view.readerFault || view.health === "offline";

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "cp-press cp-touch flex min-w-0 items-center gap-1.5 rounded-full py-1 pr-2 pl-2.5 text-xs hover:bg-default-100",
          fault ? "text-danger" : "text-default-500 hover:text-foreground",
        )}
      >
        <span aria-hidden="true" className={cx("h-1.5 w-1.5 shrink-0 rounded-full", DOT[view.health])} />
        <span className="truncate">{view.label}</span>
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>
      {phone ? (
        <Sheet open={open} onClose={() => setOpen(false)} label="Player" title="Player">
          <PlayerPanel view={view} now={now} />
        </Sheet>
      ) : (
        <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label="Player" width={400}>
          <div className="shrink-0 p-4">
            <PlayerPanel view={view} now={now} />
          </div>
        </Popover>
      )}
    </>
  );
}

function PlayerPanel({ view, now }: { view: PresenceView; now: number }) {
  const [setup, setSetup] = useState(view.health === "none");
  const guide = useRef<HTMLHeadingElement>(null);
  // The button that opens the guide goes away when it does: focus moves to the guide's heading rather than nowhere.
  const opened = useRef(false);
  useEffect(() => {
    if (setup && opened.current) guide.current?.focus();
  }, [setup]);

  const rows: [string, string][] = [];
  if (view.name) rows.push(["Name", view.name]);
  if (view.firmware) rows.push(["Firmware", view.firmware]);
  // An online player's last report is moments old; main doesn't republish every heartbeat, so don't print a stale one.
  if (view.lastHeardAt !== null && view.health !== "online") rows.push(["Last heard", relative(view.lastHeardAt, now)]);

  return (
    <div className="shrink-0 space-y-4">
      {view.health !== "none" && (
        <div>
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className={cx("h-2 w-2 rounded-full", DOT[view.health])} />
            <h2 className="font-semibold">{view.label}</h2>
          </div>
          <p className="mt-1 text-sm leading-snug text-default-500">{view.detail}</p>
          {rows.length > 0 && (
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-xl bg-default-100 px-3 py-2.5 text-sm">
              {rows.map(([term, value]) => (
                <div key={term} className="contents">
                  <dt className="text-default-500">{term}</dt>
                  <dd className="text-right tabular-nums [overflow-wrap:anywhere]">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      {setup ? (
        <div className="space-y-3">
          {/* The panel's own title stays the larger one; the guide is a section of it here. */}
          <h3 ref={guide} tabIndex={-1} className="text-xs font-semibold uppercase tracking-wider text-default-500">
            Set up a player
          </h3>
          <SetupGuide compact />
        </div>
      ) : (
        <Button
          tone="flat"
          size="sm"
          icon={<Settings2 aria-hidden="true" className="h-3.5 w-3.5" />}
          onClick={() => {
            opened.current = true;
            setSetup(true);
          }}
        >
          Set up a player
        </Button>
      )}
    </div>
  );
}
