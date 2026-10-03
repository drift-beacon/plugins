import { LoaderCircle, ServerOff } from "lucide-react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { cx } from "../lib/cx.ts";
import { EASE_OUT } from "../motion.ts";
import { type MainStatus, mainNotice } from "../view/main-status.ts";

/**
 * Main isn't running: say so, and that the shelf is read-only until it is. Nothing shows while the page is still
 * hearing whether it runs, so opening the page never flashes a problem that isn't there. It arrives and leaves in
 * place, pushing the page gently rather than jumping it.
 */
export function MainNotice({ status, reason }: { status: MainStatus; reason: string | null }) {
  const reduced = useReducedMotionConfig();
  const notice = mainNotice(status, reason);
  const starting = status === "starting";
  return (
    <AnimatePresence initial={false}>
      {notice && (
        <motion.div
          key={status}
          className="-mx-px -mt-px overflow-hidden"
          initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0, transition: { duration: 0.15, ease: EASE_OUT } }}
          transition={{ duration: 0.25, ease: EASE_OUT }}
        >
          <div className="px-px pt-px pb-1">
            <div
              className={cx(
                "flex items-start gap-3 rounded-2xl px-3.5 py-3 ring-1",
                starting ? "bg-content1 ring-default-100" : "bg-danger/10 ring-danger/25",
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  "grid h-8 w-8 shrink-0 place-items-center rounded-xl",
                  starting ? "bg-default-100 text-default-500" : "bg-danger/15 text-danger",
                )}
              >
                {starting ? <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" /> : <ServerOff className="h-4 w-4" />}
              </span>
              <div role="status" className="min-w-0 flex-1 pt-0.5">
                <div className="text-sm font-semibold leading-snug">{notice.title}</div>
                <div className="mt-0.5 text-sm leading-snug text-default-500">{notice.body}</div>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
