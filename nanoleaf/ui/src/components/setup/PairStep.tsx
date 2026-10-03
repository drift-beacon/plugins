import { Button } from "@heroui/react";
import { ArrowLeft, CircleAlert } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useNow } from "../../hooks/useNow.ts";
import { type PairingStep, type PairResult, useModel } from "../../model.ts";
import { EASE_OUT } from "../../motion.ts";
import { address, lightCount } from "../format.ts";
import { ControllerArt } from "./ControllerArt.tsx";
import type { PairTarget } from "./FindStep.tsx";

export type { PairResult } from "../../model.ts";

/** How long `pair` listens for the pairing window (its request budget). */
const WINDOW_MS = 30_000;
/** An address that takes longer than this to answer is worth saying so, rather than "Listening". */
const REACHING_AFTER_MS = 700;

type Attempt =
  | { readonly state: "waiting"; readonly since: number }
  /** `unsure`: the answer was lost, so the pairing may have gone through all the same. */
  | { readonly state: "failed"; readonly error: string; readonly unsure: boolean };

interface PairStepProps {
  readonly target: PairTarget;
  onPaired(result: PairResult): void;
  onBack(): void;
}

/**
 * Step 2: pair. `pair` starts at once and listens for 30 s while the user holds the power button; the drawing shows
 * the hold (and loops only while it's waiting), and a countdown shows how long is left, labelled with how far main
 * has got (it tells this copy as it goes). Leaving the step gives the pairing up in main too, unless the controller
 * has already handed out a token. A failure says why and offers another go.
 */
export function PairStep({ target, onPaired, onBack }: PairStepProps) {
  const model = useModel();
  const reduced = useReducedMotion();
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Attempt>({ state: "waiting", since: Date.now() });
  /** How far main has got; null until it says the controller answered. */
  const [step, setStep] = useState<PairingStep | null>(null);
  const [slow, setSlow] = useState(false);
  const onPairedRef = useRef(onPaired);
  onPairedRef.current = onPaired;
  const waiting = status.state === "waiting";
  const now = useNow(1000, waiting);

  useEffect(() => {
    // Leaving (Back, another target, Try again, the setup closing) gives this pairing up, here and in main.
    const leaving = new AbortController();
    const current = () => !leaving.signal.aborted;
    setStatus({ state: "waiting", since: Date.now() });
    setStep(null);
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), REACHING_AFTER_MS);
    model.actions
      .pair(target.host, target.port, { signal: leaving.signal, onStep: (next) => current() && setStep(next) })
      .then(
        (result) => current() && onPairedRef.current(result),
        (e: unknown) => {
          if (!current()) return;
          const unsure = (e as { code?: string }).code === "timeout";
          setStatus({
            state: "failed",
            unsure,
            error: unsure
              ? "Drift Beacon didn't answer in time, so the pairing may not have finished. If the wall doesn't show " +
                "up in a moment, hold the controller's power button for 5–7 seconds until the lights flash, then " +
                "try again."
              : e instanceof Error
                ? e.message
                : String(e),
          });
        },
      );
    return () => {
      window.clearTimeout(timer);
      leaving.abort();
    };
    // A new attempt (Try again) or a new target starts pairing afresh.
  }, [attempt, target.host, target.port, model.actions]);

  // A pairing whose answer was lost may have gone through: the connection says so.
  const { controller, connection, layout } = model;
  const pairedAfterAll =
    status.state === "failed" &&
    status.unsure &&
    controller?.host === target.host &&
    controller.port === target.port &&
    connection?.status === "connected";
  useEffect(() => {
    if (pairedAfterAll && controller) {
      onPairedRef.current({ name: controller.name, model: controller.model, panels: lightCount(layout) });
    }
  }, [pairedAfterAll, controller, layout]);

  const connecting = waiting && step === "connecting";
  const progress = connecting
    ? "Paired. Reading the layout…"
    : step === null && slow
      ? "Reaching the controller…"
      : "Listening";

  const name = target.name ?? `the controller at ${address(target.host, target.port)}`;
  const left = waiting ? Math.max(0, Math.ceil((status.since + WINDOW_MS - now) / 1000)) : 0;
  const swap = {
    initial: reduced ? { opacity: 0 } : { opacity: 0, filter: "blur(2px)", transform: "translateY(4px)" },
    animate: { opacity: 1, filter: "blur(0px)", transform: "translateY(0px)" },
    exit: { opacity: 0, filter: "blur(2px)", transition: { duration: 0.12, ease: EASE_OUT } },
    transition: { duration: 0.2, ease: EASE_OUT },
  };

  return (
    <div className="grid items-center gap-5 @lg:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
      <div className="flex justify-center rounded-2xl bg-background/50 px-4 py-5 ring-1 ring-divider">
        <ControllerArt waiting={waiting && !connecting} />
      </div>
      <div className="min-w-0" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          {waiting ? (
            <motion.div key={`waiting-${attempt}`} {...swap}>
              <h3 className="font-semibold text-lg leading-tight">Hold the power button on {name}</h3>
              <p className="mt-1.5 text-default-500 text-sm leading-snug">
                Keep it pressed for 5–7 seconds, until the panels flash. Then let go: Drift Beacon picks up the pairing
                by itself.
              </p>
              <div className="mt-4">
                {/* Inside a live region: the seconds tick on screen only, so no screen reader reads one a second. */}
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-default-400">
                    {progress}
                    {progress === "Listening" && <span className="sr-only"> for up to {WINDOW_MS / 1000} seconds</span>}
                  </span>
                  <span aria-hidden className="font-medium text-default-500 tabular-nums">
                    {left} s left
                  </span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-default-100">
                  {/* Time made visible: it drains at a constant rate, so linear. */}
                  <motion.div
                    className="h-full origin-left rounded-full bg-primary"
                    initial={{ transform: "scaleX(1)" }}
                    animate={{ transform: "scaleX(0)" }}
                    transition={{ duration: WINDOW_MS / 1000, ease: "linear" }}
                  />
                </div>
              </div>
              <p className="mt-4 text-default-400 text-xs leading-relaxed">
                No button to hand? In the Nanoleaf app, open the controller's settings and choose Connect to API.
              </p>
            </motion.div>
          ) : (
            <motion.div key={`failed-${attempt}`} {...swap}>
              <h3 className="flex items-center gap-2 font-semibold text-lg leading-tight">
                <CircleAlert className="h-5 w-5 shrink-0 text-warning" />
                Pairing didn't finish
              </h3>
              <p className="mt-1.5 text-default-500 text-sm leading-snug">
                {status.state === "failed" && status.error}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  color="primary"
                  radius="lg"
                  className="font-medium active:scale-[0.97]"
                  onPress={() => setAttempt((n) => n + 1)}
                >
                  Try again
                </Button>
                <Button variant="flat" radius="lg" className="active:scale-[0.97]" onPress={onBack}>
                  Choose another
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {/* Once the controller handed out a token main finishes whatever happens here, so there is no way back. */}
        {waiting && !connecting && (
          <Button
            size="sm"
            variant="light"
            radius="lg"
            startContent={<ArrowLeft className="h-3.5 w-3.5" />}
            onPress={onBack}
            className="mt-3 -ml-2 text-default-500 active:scale-[0.97]"
          >
            Back
          </Button>
        )}
      </div>
    </div>
  );
}
