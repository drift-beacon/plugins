import { cn } from "@heroui/theme";
import { Check } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { choiceAfterPress } from "../../../shared/acting-for.ts";
import { rovingStep } from "../lib/roving.ts";
import { followingOf, useModel } from "../model.ts";
import { SPRING_POP } from "../motion.ts";

/**
 * Who the wall follows: one chip per member, a single choice (a radio group; arrows, Home and End move it). The chip checked is
 * who it acts for now (with nothing chosen, or the one chosen gone, the owner); only picking someone else writes, so
 * that fallback is never stored. Hidden in a workspace of one, where everything is for its only member, and with no
 * roster.
 */
export function FollowPicker() {
  const model = useModel();
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  if (model.members.length < 2) return null;
  const following = followingOf(model);
  const members = model.members;

  const pick = (memberId: string) => {
    const next = choiceAfterPress(following, memberId);
    if (next === null) return;
    setSaveError(null);
    model.actions.saveZoneMember(next).catch((error: unknown) => {
      setSaveError(`Couldn't save that: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const next = rovingStep(e.key, index, members.length);
    if (next === null) return;
    e.preventDefault();
    pick(members[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div className="border-default-100 border-t p-4">
      <span id={`${id}-label`} className="block font-medium text-foreground text-sm">
        This wall follows
      </span>
      <span id={`${id}-description`} className="mt-0.5 block text-default-500 text-xs leading-snug">
        It glows for their sessions, and a touch on the wall acts for them.
      </span>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        className="mt-3 flex flex-wrap gap-1.5"
      >
        {members.map((member, i) => {
          const on = following.includes(member.id);
          return (
            <button
              key={member.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => pick(member.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                "flex max-w-full items-center gap-1.5 rounded-full py-1 pr-3 pl-1 text-xs ring-1",
                "transition-[background-color,box-shadow,color,transform] duration-150 ease-out active:scale-[0.96]",
                on
                  ? "bg-primary/15 text-foreground ring-primary/50"
                  : "text-default-500 ring-default-200 hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "grid h-5 w-5 shrink-0 place-items-center rounded-full transition-colors duration-150",
                  on ? "bg-primary text-primary-foreground" : "bg-default-100",
                )}
              >
                <AnimatePresence initial={false} mode="popLayout">
                  {on && (
                    <motion.span
                      key="on"
                      initial={{ opacity: 0, scale: 0.5 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.5 }}
                      transition={SPRING_POP}
                    >
                      <Check className="h-3 w-3" strokeWidth={3.5} />
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>
              <span className="truncate">{member.name}</span>
            </button>
          );
        })}
      </div>
      {saveError && (
        <div role="status" className="mt-2 text-danger text-xs">
          {saveError}
        </div>
      )}
    </div>
  );
}
