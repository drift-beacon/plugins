import { cn } from "@heroui/theme";
import { Info } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef } from "react";

/** A short message about something the editor did on the user's behalf. */
export interface ToastMessage {
  readonly id: number;
  readonly text: string;
}

/** How long a toast stays: long enough to read a sentence, short enough not to linger over the drawing. */
const TOAST_MS = 3400;
/** Reading time per character, for the odd longer sentence. */
const MS_PER_CHAR = 70;

/**
 * A pill that drops in at the top of the stage and leaves the way it came (Sonner-style: a touch slower than UI
 * chrome, plain ease), then clears itself. The text wraps rather than truncates: a phone-width stage fits about 40
 * characters on a line.
 */
export function StageToast({ toast, onDone }: { toast: ToastMessage | null; onDone: () => void }) {
  // The timer belongs to the toast, not to whichever render last handed down `onDone`.
  const reduced = useReducedMotion();
  const done = useRef(onDone);
  useLayoutEffect(() => {
    done.current = onDone;
  }, [onDone]);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => done.current(), Math.max(TOAST_MS, toast.text.length * MS_PER_CHAR));
    return () => window.clearTimeout(id);
  }, [toast]);
  return (
    <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex justify-center">
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            role="status"
            className={cn(
              "pointer-events-auto flex max-w-full items-center gap-2 rounded-2xl bg-content2/95 py-1.5 pr-3.5 pl-1.5",
              "text-sm leading-snug shadow-lg ring-1 ring-default-200 backdrop-blur",
            )}
            initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(-120%)" }}
            animate={{ opacity: 1, transform: "translateY(0%)" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(-120%)" }}
            transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
          >
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-default-200 text-default-600">
              <Info className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 text-balance">{toast.text}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
