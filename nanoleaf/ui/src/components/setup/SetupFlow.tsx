import { Button } from "@heroui/react";
import { X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { FoundController } from "../../../../shared/types.ts";
import { useModel } from "../../model.ts";
import { EASE_OUT } from "../../motion.ts";
import { FlowStepper } from "../FlowStepper.tsx";
import { address } from "../format.ts";
import { stepsAside } from "./closing.ts";
import { DoneStep } from "./DoneStep.tsx";
import { FindStep, type PairTarget } from "./FindStep.tsx";
import { type PairResult, PairStep } from "./PairStep.tsx";

/** Why the setup is showing: nothing paired yet, a token that stopped working, or a controller that moved. */
export type SetupIntent =
  | { readonly mode: "first" }
  | { readonly mode: "repair"; readonly target: PairTarget }
  | { readonly mode: "edit"; readonly target: PairTarget };

type Step =
  | { readonly kind: "find" }
  | { readonly kind: "pair"; readonly target: PairTarget }
  | { readonly kind: "done"; readonly result: PairResult };

const STEPS = ["Find", "Pair", "Done"] as const;
const INDEX: Record<Step["kind"], number> = { find: 0, pair: 1, done: 2 };

const TITLES: Record<SetupIntent["mode"], { title: string; sub: string }> = {
  first: { title: "Set up your Nanoleaf", sub: "Find the controller on your network and pair with it." },
  repair: { title: "Pair again", sub: "The controller stopped accepting this plugin. Pairing again fixes it." },
  edit: { title: "Change the address", sub: "Point the plugin at where the controller is now, then pair." },
};

interface SetupFlowProps {
  readonly intent: SetupIntent;
  /** Paired, and the arrival has played: the wall takes over. */
  onDone(): void;
  /** Back out (only when a controller is already set up). */
  readonly onCancel?: () => void;
}

/**
 * First run (or re-pairing), in the wall's place: Find → Pair → Done. Steps swap with a short blurred crossfade;
 * the stepper says where you are. A setup still at Find steps aside for the wall when the controller gets paired
 * from another copy of the interface (another tab or device); its own pairing is news here too, and changes nothing
 * (`stepsAside`).
 */
export function SetupFlow({ intent, onDone, onCancel }: SetupFlowProps) {
  const reduced = useReducedMotion();
  const { controller, onControllerChanged } = useModel();
  const [step, setStep] = useState<Step>(() =>
    intent.mode === "repair" ? { kind: "pair", target: intent.target } : { kind: "find" },
  );
  const [found, setFound] = useState<readonly FoundController[]>([]);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const finding = step.kind === "find";
  const stepRef = useRef(step.kind);
  stepRef.current = step.kind;

  // Main says so as it happens, whatever this setup was opened for, and whichever copy did it (this one included).
  useEffect(
    () =>
      onControllerChanged((change) => {
        if (stepsAside(stepRef.current, change)) onDoneRef.current();
      }),
    [onControllerChanged],
  );
  // A first-run setup has nothing left to find once a controller is stored, also when the news itself was missed.
  const settled = finding && intent.mode === "first" && controller !== null;
  useEffect(() => {
    if (settled) onDoneRef.current();
  }, [settled]);
  const copy = TITLES[intent.mode];
  const swap = {
    initial: reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px)", filter: "blur(2px)" },
    animate: { opacity: 1, transform: "translateY(0px)", filter: "blur(0px)" },
    exit: reduced
      ? { opacity: 0, transition: { duration: 0.12 } }
      : {
          opacity: 0,
          transform: "translateY(-6px)",
          filter: "blur(2px)",
          transition: { duration: 0.14, ease: EASE_OUT },
        },
    transition: { duration: 0.24, ease: EASE_OUT },
  };
  const initialAddress = intent.mode === "edit" ? address(intent.target.host, intent.target.port) : undefined;

  return (
    <section aria-label={copy.title} className="@container rounded-3xl bg-content1 p-4 ring-1 ring-default-100 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-60">
          <div className="font-semibold text-[10px] text-default-400 uppercase tracking-wider">Setup</div>
          <h2 className="mt-1 font-bold text-xl leading-tight">{copy.title}</h2>
          <p className="mt-1 text-default-500 text-sm">{copy.sub}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <FlowStepper steps={STEPS} current={step.kind === "done" ? 3 : INDEX[step.kind]} />
          {onCancel && step.kind !== "done" && (
            <Button isIconOnly size="sm" variant="light" radius="full" aria-label="Close setup" onPress={onCancel}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      <div className="mt-6 min-h-[260px]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={step.kind} {...swap}>
            {step.kind === "find" && (
              <FindStep
                initialAddress={initialAddress}
                found={found}
                onFound={setFound}
                onPick={(target) => setStep({ kind: "pair", target })}
              />
            )}
            {step.kind === "pair" && (
              <PairStep
                target={step.target}
                onPaired={(result) => setStep({ kind: "done", result })}
                onBack={() => setStep({ kind: "find" })}
              />
            )}
            {step.kind === "done" && <DoneStep result={step.result} onFinish={onDone} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}
