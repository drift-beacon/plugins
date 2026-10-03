import { ClipboardPaste, Plug, Wifi } from "lucide-react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { type KeyboardEvent, type ReactNode, type Ref, useEffect, useId, useMemo, useRef, useState } from "react";
import { cx } from "../../lib/cx.ts";
import { useModel } from "../../model.ts";
import { EASE_OUT } from "../../motion.ts";
import { sentence } from "../../view/errors.ts";
import {
  BOOT_HOLD_S,
  type GuideStep,
  guideSteps,
  heardMark,
  heardSince,
  hubDefaults,
  PLAYER_NETWORK,
  PLAYER_SETUP_URL,
  setupCodeFor,
} from "../../view/setup.ts";
import { Button } from "../kit.tsx";
import type { SetupLight } from "../scene/Led.tsx";
import { CopyField } from "./CopyField.tsx";

/** How far a step travels as it arrives and leaves: enough to say which way you went, no more. */
const SHIFT = 14;

function Field({
  label,
  value,
  onChange,
  problem,
  hint,
  className,
  inputMode,
  placeholder,
  hideLabel = false,
  field,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  problem?: string;
  hint?: ReactNode;
  className?: string;
  inputMode?: "text" | "numeric";
  placeholder?: string;
  /** For a field the step's heading already names. */
  hideLabel?: boolean;
  /** The step's first field, which takes focus when the step arrives. */
  field?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  // Field problems come from the shared rules as bare phrases; here they sit beside whole sentences.
  const note = problem ? sentence(problem) : hint;
  return (
    <div className={cx("min-w-0", className)}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "mb-1 block text-xs font-medium text-default-500"}>
        {label}
      </label>
      <input
        ref={field}
        id={id}
        value={value}
        inputMode={inputMode}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={problem ? true : undefined}
        aria-describedby={note ? `${id}-note` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cx(
          "cp-touch h-10 w-full rounded-xl bg-default-100 px-3 font-mono text-sm text-foreground outline-none placeholder:font-sans placeholder:text-default-400 focus-visible:ring-2",
          problem ? "ring-1 ring-danger focus-visible:ring-danger" : "focus-visible:ring-focus",
        )}
      />
      {note && (
        <p id={`${id}-note`} className={cx("mt-1 text-xs leading-snug", problem ? "text-danger" : "text-default-500")}>
          {note}
        </p>
      )}
    </div>
  );
}

function Progress({ steps, at, done }: { steps: readonly GuideStep[]; at: number; done: boolean }) {
  return (
    <div className="flex h-5 items-center gap-3">
      <div className="flex gap-1" aria-hidden="true">
        {steps.map((step, i) => (
          <span
            key={step}
            className={cx("h-1 w-7 rounded-full transition-colors duration-300", done ? "bg-success" : i <= at ? "bg-foreground" : "bg-default-200")}
          />
        ))}
      </div>
      {/* Said aloud when it changes: a player coming online happens while the user is looking at their phone. */}
      <span role="status" className={cx("text-xs transition-colors duration-300", done ? "font-medium text-success" : "text-default-500")}>
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

/** The page is waiting to hear the player report, and says so. */
function Listening() {
  return (
    <p role="status" className="flex items-center gap-2.5 text-sm text-default-500">
      <span aria-hidden="true" className="relative grid h-2 w-2 shrink-0 place-items-center">
        <span className="cp-ring absolute inset-0 rounded-full bg-primary" />
        <span className="h-2 w-2 rounded-full bg-primary" />
      </span>
      Listening for your player…
    </p>
  );
}

/**
 * Connecting a player, one question at a time: the hub's address (only when the page can't work it out), an API key
 * the user pastes (it never leaves this page), the setup code built from them, and what to do on the phone. Then it
 * listens until a player reports.
 *
 * Nothing moves between steps except the step itself: the guide is one fixed frame (progress on top, the step in the
 * middle, actions along the bottom), so whatever holds it keeps its height and Continue stays under the pointer.
 * `onLight` tells the stage what the real player's light is doing, so the replica can show it.
 */
export function SetupGuide({
  compact = false,
  initialStep,
  onLight,
}: {
  /** A narrower holder (the phone's card, the Player panel): the frame is taller, since its lines wrap. */
  compact?: boolean;
  /** The step to open on, when it isn't the first. */
  initialStep?: GuideStep;
  onLight?(light: SetupLight | null): void;
}) {
  const { record, presence, apiPath, pageHost } = useModel();
  const reduced = useReducedMotionConfig();
  const start = useMemo(() => hubDefaults(record, pageHost), [record, pageHost]);
  const [host, setHost] = useState(start.host);
  const [hostTouched, setHostTouched] = useState(false);
  const [port, setPort] = useState(String(start.port));
  const [key, setKey] = useState("");
  const { code, problems } = setupCodeFor({ host, port, base: apiPath, key });
  const hubKnown = host.trim() !== "" && !problems.host && !problems.port;
  const hasKey = key.trim() !== "" && !problems.key;

  // Decided once: an address typed in the first step doesn't make that step vanish under the user.
  const [steps] = useState(() => guideSteps(hubKnown));
  const [at, setAt] = useState(() => Math.max(0, initialStep ? steps.indexOf(initialStep) : 0));
  // Which way the last move went, so a step leaves and arrives along the direction of travel.
  const [dir, setDir] = useState<1 | -1>(1);
  const [copied, setCopied] = useState(false);
  const step = steps[at];
  const last = at === steps.length - 1;

  // Who had reported when the guide opened: anyone heard since is the player this setup connected.
  const [mark] = useState(() => heardMark(record, presence));
  const player = heardSince(mark, record, presence);
  const connected = player !== null;

  const light: SetupLight | null = connected ? "online" : step === "phone" ? "waiting" : null;
  const tell = useRef(onLight);
  tell.current = onLight;
  useEffect(() => {
    tell.current?.(light);
    return () => tell.current?.(null);
  }, [light]);

  // A step the user moved to takes focus (its field, else its heading); the one the guide opens on doesn't, so
  // opening the page never raises a phone's keyboard.
  const heading = useRef<HTMLHeadingElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const moved = useRef(false);
  const settle = () => {
    if (moved.current) (field.current ?? heading.current)?.focus();
  };

  const go = (to: number) => {
    moved.current = true;
    setDir(to > at ? 1 : -1);
    setAt(Math.max(0, Math.min(to, steps.length - 1)));
  };
  const canContinue = step === "hub" ? hubKnown : step === "key" ? hasKey : !last;
  const next = () => go(at + 1);
  const onEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && !event.target.readOnly && canContinue) next();
  };

  const title = (text: string) => (
    <h2 ref={heading} tabIndex={-1} className="text-2xl font-bold leading-tight outline-none">
      {text}
    </h2>
  );
  const hostAsked = host.trim() === "";

  const body: Record<GuideStep, ReactNode> = {
    hub: (
      <>
        {title("Where is your hub?")}
        <p className="text-sm leading-snug text-default-500">The address Drift Beacon has on your network. The player will look for it there.</p>
        <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
          <Field
            field={field}
            label="Hub address"
            value={host}
            onChange={(value) => {
              setHost(value);
              setHostTouched(true);
            }}
            placeholder="192.168.1.12"
            // A field the user hasn't touched asks, in the hint's voice; it only reads as an error once what's wrong
            // is something they typed.
            problem={hostTouched && !hostAsked ? problems.host : undefined}
            hint={hostAsked ? "This page can't see it from here." : undefined}
          />
          <Field label="Port" value={port} onChange={setPort} inputMode="numeric" problem={problems.port} />
        </div>
      </>
    ),
    key: (
      <>
        {title("Paste an API key")}
        <p className="text-sm leading-snug text-default-500">
          Make one in Drift Beacon under Workspace settings → API Keys. It goes into the setup code and stays on this page.
        </p>
        <Field
          field={field}
          label="API key"
          hideLabel
          value={key}
          onChange={setKey}
          placeholder="db_…"
          problem={problems.key}
          // Where Skip is too narrow to say what skipping means.
          hint={compact ? "Or skip it: the player's page asks for it instead." : undefined}
        />
      </>
    ),
    code: (
      <>
        {title("Copy your setup code")}
        <p className="text-sm leading-snug text-default-500">
          It carries the hub's address{hasKey ? " and your key" : ""}. Copy it now: once your phone joins the player's Wi-Fi, it can't reach
          Drift Beacon.
        </p>
        {code ? (
          <CopyField value={code} label="Setup code" action="Copy code" onCopied={() => setCopied(true)} />
        ) : (
          <p className="rounded-2xl bg-default-100 px-3 py-3 text-sm text-default-500">
            {sentence(problems.host ?? problems.port ?? problems.key ?? problems.base ?? "Go back and check the hub's address")}
          </p>
        )}
      </>
    ),
    phone: (
      <>
        {title("Finish on your phone")}
        <ol className="space-y-2.5">
          <Line icon={<Plug className="h-4 w-4" />}>Plug the player in. Its light breathes blue.</Line>
          <Line icon={<Wifi className="h-4 w-4" />}>
            Join the Wi-Fi <span className="whitespace-nowrap font-mono">{PLAYER_NETWORK}</span>. Its page opens.
          </Line>
          <Line icon={<ClipboardPaste className="h-4 w-4" />}>Pick your Wi-Fi, paste the code, press Connect.</Line>
        </ol>
        <p className="text-xs leading-snug text-default-400">
          Light not blue? Hold the player's BOOT button for {BOOT_HOLD_S} seconds. No page? Go to{" "}
          <span className="whitespace-nowrap font-mono">{PLAYER_SETUP_URL}</span>.
        </p>
      </>
    ),
  };

  const done = (
    <>
      {title(player?.name ? `${player.name} is connected` : "Your player is connected")}
      <p className="text-sm leading-snug text-default-500">Slide a cartridge in and give it a label. That's the last thing you'll set up.</p>
    </>
  );

  const travel = (sign: number) => (reduced ? {} : { transform: `translateX(${sign * SHIFT}px)` });
  const fade = { duration: 0.15, ease: EASE_OUT };
  const noBack = at === 0 || connected;

  return (
    // One frame for every step: a fixed height, the step pinned to its top and the actions to its bottom.
    <div className={cx("flex flex-col", compact ? "h-[372px]" : "h-[304px]")} onKeyDown={onEnter}>
      <Progress steps={steps} at={at} done={connected} />

      <div className="relative mt-5 min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <motion.div
            key={connected ? "done" : step}
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
            onAnimationComplete={(state) => {
              if (state === "rest") settle();
            }}
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
              className="flex min-w-0 items-center gap-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={fade}
            >
              {/* Copying is the code step's main action; Continue takes over once that has happened. */}
              <Button tone={step === "code" && !copied ? "flat" : "primary"} disabled={!canContinue} onClick={next}>
                Continue
              </Button>
              <AnimatePresence initial={false}>
                {step === "key" && (
                  <motion.div key="skip" className="min-w-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
                    <Button tone="light" onClick={next}>
                      {compact ? "Skip" : "Skip: I'll paste it on the player"}
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
          aria-hidden={noBack || undefined}
          tabIndex={noBack ? -1 : undefined}
          className={cx("ml-auto transition-opacity duration-150", noBack && "pointer-events-none opacity-0")}
        >
          Back
        </Button>
      </div>
    </div>
  );
}
