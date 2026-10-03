import { cn } from "@heroui/theme";
import { AnimatePresence,motion } from "motion/react";
import { LIVE_COPY,LiveStepper,ResultBody } from "./kit";
import { EASE_OUT } from "./motion";
import type { CubeRuntime } from "./runtime";
/** The stepper up top, and the prompt or the result below the cube. */
export function LiveOverlay({ runtime, narrow }: { runtime: CubeRuntime; narrow: boolean }) {
  const live = runtime.view !== "idle";
  return (
    <>
      <AnimatePresence>
        {live && (
          <motion.div
            key="stepper"
            className={cn("absolute left-1/2 z-20 -translate-x-1/2", narrow ? "top-3" : "top-6")}
            initial={{ opacity: 0, transform: "translateY(-8px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            exit={{ opacity: 0, transform: "translateY(-8px)", transition: { duration: 0.15, ease: EASE_OUT } }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
          >
            <LiveStepper view={runtime.view} size={narrow ? "sm" : "md"} />
          </motion.div>
        )}
      </AnimatePresence>
      <div className={cn("pointer-events-none absolute inset-x-0 z-20 flex justify-center px-5", narrow ? "bottom-5" : "bottom-8")}>
        <AnimatePresence mode="wait">
          {(runtime.view === "held" || runtime.view === "activated") && (
            <motion.div
              key={runtime.view}
              className="text-center"
              initial={{ opacity: 0, transform: "translateY(8px)" }}
              animate={{ opacity: 1, transform: "translateY(0px)" }}
              exit={{ opacity: 0, transform: "translateY(-6px)", transition: { duration: 0.12, ease: EASE_OUT } }}
              transition={{ duration: 0.22, ease: EASE_OUT }}
            >
              <div className={cn("font-bold", narrow ? "text-2xl" : "text-3xl")}>{LIVE_COPY[runtime.view].title}</div>
              <div className="mt-1 text-default-500">{LIVE_COPY[runtime.view].body}</div>
            </motion.div>
          )}
          {runtime.view === "result" && runtime.roll && (
            <motion.div key={`result-${runtime.roll.id}`} className="pointer-events-auto" exit={{ opacity: 0, transform: "translateY(8px)", transition: { duration: 0.15, ease: EASE_OUT } }}>
              <ResultBody roll={runtime.roll} onTrack={runtime.track} onDismiss={runtime.dismiss} onDiscard={runtime.discard} hideIcon compact={narrow} busy={runtime.busy} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}
