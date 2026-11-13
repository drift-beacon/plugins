import { Check } from "lucide-react";
import { useAnimate, useReducedMotion } from "motion/react";
import { useEffect, useId, useState } from "react";
import { useRequest } from "../../hooks/useRequest.ts";
import { cx } from "../../lib/cx.ts";
import { useModel } from "../../model.ts";
import { EASE_OUT } from "../../motion.ts";
import type { LibraryItem } from "../../view/library.ts";
import { tickedMembers, toggledMembers } from "../../view/members.ts";
import type { MemberView } from "../../view/types.ts";
import { InlineError } from "../kit.tsx";

const byName = (a: MemberView, b: MemberView) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);

/**
 * Whom a cartridge tracks for: a chip per member, ticked for each one it starts for (`actingFor`, so a cartridge
 * nobody picked for shows the owner ticked). The last ticked chip can't be unticked: it shakes instead. Each change
 * goes to main at once; the chips show it while it travels, then what main stored. Hidden in a workspace of one, where everything is for
 * that member, and while the app sends no members.
 */
export function TracksFor({ item, readOnly }: { item: LibraryItem; readOnly: boolean }) {
  const { members, actions } = useModel();
  const request = useRequest();
  const heading = useId();
  // The choice sent to main, then what main answers it stored (which can leave out someone this device still lists).
  // Dropped when storage changes, or when the request fails.
  const [asked, setAsked] = useState<readonly string[] | null>(null);
  const stored = item.members.join("\n");
  useEffect(() => setAsked(null), [stored]);
  if (members.length < 2) return null;

  const shown = tickedMembers(asked, item.members, members);
  const toggle = (id: string): boolean => {
    const next = toggledMembers(shown, id);
    if (!next) return false;
    setAsked(next);
    void request.run(() => actions.setMembers(item.tag, next)).then((answered) => setAsked(answered ?? null));
    return true;
  };

  return (
    <div className="space-y-2">
      <div>
        <h3 id={heading} className="text-[10px] font-semibold uppercase tracking-wider text-default-500">
          Tracks for
        </h3>
        <p className="text-xs leading-snug text-default-500">
          Putting this cartridge in starts its activity for the people you pick.
        </p>
      </div>
      <div role="group" aria-labelledby={heading} className="flex flex-wrap gap-1.5">
        {[...members].sort(byName).map((member) => (
          <MemberChip
            key={member.id}
            name={member.name}
            on={shown.includes(member.id)}
            disabled={readOnly}
            pending={request.pending}
            onToggle={() => toggle(member.id)}
          />
        ))}
      </div>
      {request.error && <InlineError>{request.error}</InlineError>}
    </div>
  );
}

function MemberChip({
  name,
  on,
  disabled,
  pending,
  onToggle,
}: {
  name: string;
  on: boolean;
  disabled: boolean;
  pending: boolean;
  /** False when it can't change: the last one ticked. */
  onToggle(): boolean;
}) {
  // The shake moves a wrapper, so it never fights the button's own press transform.
  const [scope, animate] = useAnimate<HTMLSpanElement>();
  const reduced = useReducedMotion();
  return (
    <span ref={scope} className="inline-flex max-w-full">
      <button
        type="button"
        aria-pressed={on}
        disabled={disabled}
        // Not `disabled` while the request runs: that would drop focus from the chip that was pressed.
        aria-disabled={pending || undefined}
        onClick={() => {
          if (pending) return;
          // The last one ticked can't be unticked: a small "no" shake instead.
          if (!onToggle() && !reduced && scope.current) {
            animate(scope.current, { x: [0, -4, 4, -2, 0] }, { duration: 0.32, ease: EASE_OUT });
          }
        }}
        className={cx(
          "cp-press cp-touch flex max-w-full items-center gap-1.5 rounded-full py-1 pl-1 pr-3 text-xs disabled:opacity-50 aria-disabled:opacity-50",
          on
            ? "bg-primary/15 text-foreground hover:bg-primary/20"
            : "bg-default-100 text-default-500 hover:bg-default-200 hover:text-foreground",
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            "grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold",
            on ? "bg-primary text-primary-foreground" : "bg-default-200 text-default-500",
          )}
        >
          {on ? <Check className="h-3 w-3" strokeWidth={3} /> : name.trim().slice(0, 1).toUpperCase()}
        </span>
        <span className="truncate">{name}</span>
      </button>
    </span>
  );
}
