import { cn } from "@heroui/theme";
import { motion, useReducedMotion } from "motion/react";
import { EASE_IN_OUT, EASE_OUT } from "../motion.ts";

interface FlowStepperProps {
  readonly steps: readonly string[];
  /** The step in progress; `steps.length` means every step is done. */
  readonly current: number;
  readonly className?: string;
}

/**
 * Where the setup is: done steps get a check that draws itself, the current one a ring, and the connector fills
 * toward it. Nothing loops: the step content says what to do, the stepper only says where you are.
 */
export function FlowStepper({ steps, current, className }: FlowStepperProps) {
  const reduced = useReducedMotion();
  return (
    <ol className={cn("flex items-center", className)} aria-label="Setup progress">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex items-center" aria-current={active ? "step" : undefined}>
            {i > 0 && (
              <span className="relative mx-2 h-0.5 w-6 overflow-hidden rounded-full bg-default-200 sm:w-10" aria-hidden>
                <motion.span
                  className="absolute inset-0 origin-left bg-primary"
                  initial={false}
                  animate={{ transform: `scaleX(${i <= current ? 1 : 0})` }}
                  transition={{ duration: reduced ? 0 : 0.3, ease: EASE_IN_OUT }}
                />
              </span>
            )}
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  "grid h-6 w-6 shrink-0 place-items-center rounded-full",
                  "font-semibold text-[11px] tabular-nums transition-colors duration-300",
                  done && "bg-primary text-primary-foreground",
                  active && "bg-default-100 text-foreground ring-2 ring-primary/60",
                  !done && !active && "bg-default-100 text-default-400",
                )}
              >
                {done ? (
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden>
                    <motion.path
                      d="M5 12.5l4.2 4.2L19 7"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={3}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      initial={reduced ? false : { pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ duration: 0.28, ease: EASE_OUT, delay: 0.12 }}
                    />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={cn(
                  "whitespace-nowrap font-medium text-xs transition-colors duration-300",
                  active ? "text-foreground" : done ? "text-default-500" : "text-default-400",
                )}
              >
                {label}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
