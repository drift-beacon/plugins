import { cn } from "@heroui/theme";
import { Check, Plus, X } from "lucide-react";
import { AnimatePresence, type HTMLMotionProps, motion, useIsPresent, useReducedMotion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useCallback, useRef, useState } from "react";
import type { MemberLike } from "../../../../shared/types.ts";
import { EASE_OUT, SPRING_POP } from "../../motion.ts";
import { personKey } from "./personKeys.ts";
import { ZONE_WORDS as W } from "./words.ts";

/** A person's chip, as the wall's picker draws one ("This wall follows"). */
export const CHIP =
  "flex max-w-full items-center gap-1.5 rounded-full py-1 pr-3 pl-1 text-xs ring-1 transition-[background-color,box-shadow,color,transform] duration-150 ease-out active:scale-[0.96]";
export const QUIET_BUTTON =
  "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-default-100 px-3 font-medium text-foreground text-xs transition-[background-color,transform] duration-150 ease-out hover:bg-default-200 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40";
export const ICON_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-lg text-default-500 transition-[background-color,color,transform] duration-150 ease-out hover:bg-default-100 hover:text-foreground active:scale-[0.9]";

/**
 * A zone's person, as one choice among its own and the members who have no zone (a radio group: arrows, Home and End
 * move it). Picking someone else gives them the zone.
 */
export function PersonChoice({
  value,
  options,
  onPick,
  label,
}: {
  value: string | null;
  options: readonly MemberLike[];
  onPick(id: string): void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const step = personKey(e.key, index, options, value);
    if (step === null) return;
    e.preventDefault();
    if (step.pick !== null) onPick(step.pick);
    refs.current[step.focus]?.focus();
  };
  const focusable = options.some((m) => m.id === value) ? value : (options[0]?.id ?? null);
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((member, i) => {
        const on = member.id === value;
        return (
          <button
            key={member.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={member.id === focusable ? 0 : -1}
            onClick={() => {
              if (!on) onPick(member.id);
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              CHIP,
              on ? "bg-primary/15 text-foreground ring-primary/50" : "text-default-500 ring-default-200 hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "grid h-5 w-5 shrink-0 place-items-center rounded-full font-semibold text-[10px] transition-colors duration-150",
                on ? "bg-primary text-primary-foreground" : "bg-default-100",
              )}
            >
              <AnimatePresence initial={false} mode="popLayout">
                {on ? (
                  <motion.span
                    key="on"
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    transition={SPRING_POP}
                  >
                    <Check className="h-3 w-3" strokeWidth={3.5} />
                  </motion.span>
                ) : (
                  <span key="off" aria-hidden>
                    {member.name.charAt(0)}
                  </span>
                )}
              </AnimatePresence>
            </span>
            <span className="truncate">{member.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A part that marks itself `data-exiting` while it animates out: focus still inside it counts as lost
 * (lib/choosingFocus.ts), so whatever comes next can take it.
 */
function Leaving(props: HTMLMotionProps<"div">) {
  const present = useIsPresent();
  return <motion.div {...props} data-exiting={present ? undefined : ""} />;
}

/**
 * Adding a zone is choosing whose it is: the trigger opens "Whose zone?" with the members who have none, and a pick
 * adds theirs. When everyone has a zone the trigger is unavailable and a line says why.
 */
export function AddZone({
  free,
  onAdd,
  label = W.addZone,
  icon,
  triggerClassName = QUIET_BUTTON,
  className,
  marker,
}: {
  free: readonly MemberLike[];
  onAdd(member: string): void;
  label?: string;
  icon?: ReactNode;
  triggerClassName?: string;
  className?: string;
  /** A `data-` attribute on the trigger, for focus to find it ("split-wall", "add-zone"). */
  marker?: string;
}) {
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  // Focus follows: into "Whose zone?" when it opens, back to the trigger when it is cancelled. Callback refs, since
  // each part mounts only after the other has left.
  const returnFocus = useRef(false);
  // Stable, so they run when their button mounts and not on every render.
  const focusFirst = useCallback((el: HTMLButtonElement | null) => el?.focus({ preventScroll: true }), []);
  const focusTrigger = useCallback((el: HTMLButtonElement | null) => {
    if (!el || !returnFocus.current) return;
    returnFocus.current = false;
    el.focus({ preventScroll: true });
  }, []);
  const close = () => {
    returnFocus.current = true;
    setOpen(false);
  };
  const mark = marker ? { [`data-${marker}`]: "" } : {};
  const swap = {
    initial: { opacity: 0, filter: reduced ? "none" : "blur(2px)" },
    animate: { opacity: 1, filter: "blur(0px)" },
    exit: { opacity: 0, transition: { duration: 0.12, ease: EASE_OUT } },
    transition: { duration: 0.2, ease: EASE_OUT },
  };
  if (free.length === 0) {
    return (
      <div className={cn("flex flex-wrap items-center gap-2", className)}>
        <button type="button" disabled className={triggerClassName} {...mark}>
          {icon ?? <Plus className="h-4 w-4" aria-hidden />}
          {label}
        </button>
        <span className="text-default-500 text-xs">{W.everyoneHasOne}</span>
      </div>
    );
  }
  return (
    <AnimatePresence mode="wait" initial={false}>
      {open ? (
        <Leaving
          key="whose"
          {...swap}
          className={cn("flex flex-wrap items-center gap-2", className)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
        >
          <span className="font-medium text-foreground text-sm">{W.whoseNew}</span>
          <div role="group" aria-label={W.whoseNew} className="flex flex-wrap gap-1.5">
            {free.map((member, i) => (
              <button
                key={member.id}
                ref={i === 0 ? focusFirst : undefined}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onAdd(member.id);
                }}
                className={cn(CHIP, "text-default-600 ring-default-200 hover:text-foreground")}
              >
                <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-default-100 font-semibold text-[10px]">
                  {member.name.charAt(0)}
                </span>
                <span className="truncate">{member.name}</span>
              </button>
            ))}
          </div>
          <button type="button" className={ICON_BUTTON} aria-label={W.cancel} title={W.cancel} onClick={close}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </Leaving>
      ) : (
        <motion.div key="trigger" {...swap} className={className}>
          <button ref={focusTrigger} type="button" className={triggerClassName} onClick={() => setOpen(true)} {...mark}>
            {icon ?? <Plus className="h-4 w-4" aria-hidden />}
            {label}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
