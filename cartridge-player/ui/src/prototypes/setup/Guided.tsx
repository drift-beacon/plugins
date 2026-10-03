// Direction 1 — Guided: one question at a time. The panel holds a single step with a single primary action; what was
// a wall of instructions becomes three short screens, and the replica on the left shows what the real player is doing.
//
// Nothing moves between steps except the step itself: the panel is one fixed frame (progress on top, the step in the
// middle, actions along the bottom), so the stage keeps its height, the player stays where it is, and Continue is under
// the pointer every time.
import { ClipboardPaste, Plug, Wifi } from "lucide-react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { Button } from "../../components/kit.tsx";
import { cx } from "../../lib/cx.ts";
import { EASE_OUT } from "../../motion.ts";
import { CodeCopy, HubFields, KeyField, Listening, NETWORK, Page, PLAYER_NAME, Scene, useProto, useSetup } from "./shared.tsx";

type StepId = "hub" | "key" | "code" | "phone";

/** How far a step travels as it arrives and leaves: enough to say which way you went, no more. */
const SHIFT = 14;

function Progress({ steps, at, done }: { steps: readonly StepId[]; at: number; done: boolean }) {
  return (
    <div className="flex h-5 items-center gap-3">
      <div className="flex gap-1" aria-hidden="true">
        {steps.map((step, i) => (
          <span
            key={step}
            className={cx(
              "h-1 w-7 rounded-full transition-colors duration-300",
              done ? "bg-success" : i <= at ? "bg-foreground" : "bg-default-200",
            )}
          />
        ))}
      </div>
      <span className={cx("text-xs transition-colors duration-300", done ? "font-medium text-success" : "text-default-500")}>
        {done ? "Player online" : `Step ${at + 1} of ${steps.length}`}
      </span>
    </div>
  );
}

function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3 text-sm">
      <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-default-100 text-default-600">
        {icon}
      </span>
      <span className="leading-snug">{children}</span>
    </li>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h2 className="text-2xl font-bold leading-tight">{title}</h2>
      {children}
    </>
  );
}

export function Guided() {
  const { connected, phone } = useProto();
  const reduced = useReducedMotionConfig();
  const setup = useSetup();
  // The hub's address is a step only when the page couldn't work it out: a default that is right is never asked.
  const [askHub] = useState(!setup.hubKnown);
  const steps: readonly StepId[] = askHub ? ["hub", "key", "code", "phone"] : ["key", "code", "phone"];
  const [at, setAt] = useState(0);
  // Which way the last move went, so a step leaves and arrives along the direction of travel.
  const [dir, setDir] = useState<1 | -1>(1);
  const [copied, setCopied] = useState(false);
  const step = steps[at];
  const last = at === steps.length - 1;

  const go = (to: number) => {
    setDir(to > at ? 1 : -1);
    setAt(Math.max(0, Math.min(to, steps.length - 1)));
  };
  const canContinue = step === "hub" ? setup.hubKnown : step === "key" ? setup.hasKey : !last;
  const next = () => go(at + 1);
  const onEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && !event.target.readOnly && canContinue) next();
  };

  const body: Record<StepId, ReactNode> = {
    hub: (
      <Step title="Where is your hub?">
        <p className="text-sm leading-snug text-default-500">
          The address Drift Beacon has on your network. The player will look for it there.
        </p>
        <HubFields setup={setup} autoFocus />
      </Step>
    ),
    key: (
      <Step title="Paste an API key">
        <p className="text-sm leading-snug text-default-500">
          Make one in Drift Beacon under Workspace settings → API Keys. It goes into the setup code and stays on this page.
        </p>
        <KeyField setup={setup} autoFocus hideLabel />
      </Step>
    ),
    code: (
      <Step title="Copy your setup code">
        <p className="text-sm leading-snug text-default-500">
          It carries the hub's address{setup.hasKey ? " and your key" : ""}. Copy it now: once your phone joins the player's Wi-Fi, it can't
          reach Drift Beacon.
        </p>
        <CodeCopy code={setup.code} onCopied={() => setCopied(true)} />
      </Step>
    ),
    phone: (
      <Step title="Finish on your phone">
        <ol className="space-y-2.5">
          <Line icon={<Plug className="h-4 w-4" />}>Plug the player in. Its light breathes blue.</Line>
          <Line icon={<Wifi className="h-4 w-4" />}>
            Join the Wi-Fi <span className="whitespace-nowrap font-mono">{NETWORK}</span>. Its page opens.
          </Line>
          <Line icon={<ClipboardPaste className="h-4 w-4" />}>Pick your Wi-Fi, paste the code, press Connect.</Line>
        </ol>
        <p className="text-xs text-default-400">Light not blue? Hold the player's BOOT button for 3 seconds.</p>
      </Step>
    ),
  };

  const done = (
    <Step title={`${PLAYER_NAME} is connected`}>
      <p className="text-sm leading-snug text-default-500">Slide a cartridge in and give it a label. That's the last thing you'll set up.</p>
    </Step>
  );

  const shown = connected ? "done" : step;
  const travel = (sign: number) => (reduced ? {} : { transform: `translateX(${sign * SHIFT}px)` });
  const fade = { duration: 0.15, ease: EASE_OUT };

  const panel = (
    // One frame for every step: a fixed height, the step pinned to its top and the actions to its bottom.
    <div className={cx("flex flex-col", phone ? "h-[340px]" : "h-[304px]")} onKeyDown={onEnter}>
      <Progress steps={steps} at={at} done={connected} />

      <div className="relative mt-5 min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <motion.div
            key={shown}
            custom={dir}
            className="absolute inset-0 space-y-3"
            variants={{
              enter: (d: number) => ({ opacity: 0, ...travel(d) }),
              rest: { opacity: 1, ...travel(0), transition: { duration: 0.24, ease: EASE_OUT } },
              leave: (d: number) => ({ opacity: 0, ...travel(-d * 0.6), transition: { duration: 0.12, ease: "easeIn" } }),
            }}
            initial="enter"
            animate="rest"
            exit="leave"
          >
            {connected ? done : body[step]}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* The actions keep their places: Continue never moves, Back sits at the far edge, and what comes and goes fades. */}
      <div className="mt-4 flex h-10 items-center gap-2">
        <AnimatePresence mode="wait" initial={false}>
          {connected ? null : last ? (
            <motion.div key="listening" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
              <Listening />
            </motion.div>
          ) : (
            <motion.div
              key="actions"
              className="flex items-center gap-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={fade}
            >
              <Button tone={step === "code" && !copied ? "flat" : "primary"} disabled={!canContinue} onClick={next} className="transition-colors duration-200">
                Continue
              </Button>
              <AnimatePresence initial={false}>
                {step === "key" && (
                  <motion.div key="skip" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
                    <Button tone="light" onClick={next}>
                      Skip: I'll paste it on the player
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
        <Button
          tone="light"
          onClick={() => go(at - 1)}
          aria-hidden={at === 0 || connected || undefined}
          tabIndex={at === 0 || connected ? -1 : undefined}
          className={cx("ml-auto transition-opacity duration-150", (at === 0 || connected) && "pointer-events-none opacity-0")}
        >
          Back
        </Button>
      </div>
    </div>
  );

  const light = connected ? "online" : step === "phone" ? "setup" : "off";
  return (
    <Page>
      <section aria-label="Set up your player" className="cp-stage overflow-hidden rounded-3xl">
        {phone ? (
          <div>
            <div className="mx-auto w-3/5 pt-2">
              <Scene light={light} compact />
            </div>
            <div className="p-5 pt-2">{panel}</div>
          </div>
        ) : (
          <div className="grid grid-cols-[1.1fr_1fr] items-center">
            <div className="px-4 pt-2">
              <div className="mx-auto max-w-[520px]">
                <Scene light={light} />
              </div>
            </div>
            <div className="min-w-0 py-8 pr-8 pl-2">{panel}</div>
          </div>
        )}
      </section>
    </Page>
  );
}
