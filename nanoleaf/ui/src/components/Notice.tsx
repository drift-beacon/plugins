import { Button, Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { cn } from "@heroui/theme";
import { Hand, Info, KeyRound, Loader, Pause, ServerOff, Target, Users, WifiOff } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useState } from "react";
import { useNow } from "../hooks/useNow.ts";
import { type NanoleafModel, useModel } from "../model.ts";
import { EASE_OUT } from "../motion.ts";
import { ForgetButton } from "./ForgetButton.tsx";
import { address } from "./format.ts";
import { sentence } from "./status.ts";

export type NoticeTone = "default" | "warning" | "danger";

/** A button on a notice: it shows its own progress, and its failure in the notice. */
export interface NoticeAction {
  readonly label: string;
  readonly primary?: boolean;
  run(): Promise<void> | void;
}

export interface NoticeSpec {
  readonly id: string;
  readonly tone: NoticeTone;
  readonly icon: ReactNode;
  readonly title: string;
  readonly body: ReactNode;
  readonly info?: ReactNode;
  readonly actions?: readonly NoticeAction[];
  /** Extra controls that manage themselves (Forget asks first). */
  readonly extra?: ReactNode;
}

const TONES: Record<NoticeTone, { box: string; icon: string }> = {
  default: { box: "bg-content1 ring-default-100", icon: "bg-default-100 text-default-500" },
  warning: { box: "bg-warning/10 ring-warning/20", icon: "bg-warning/15 text-warning" },
  danger: { box: "bg-danger/10 ring-danger/25", icon: "bg-danger/15 text-danger" },
};

/**
 * One strip: what's wrong or different, in a sentence, and the one thing to do about it. Only the words are a live
 * region (title, body, a failed action), so a button's spinner isn't read out as a change to the notice.
 */
export function Notice({ notice }: { notice: NoticeSpec }) {
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tone = TONES[notice.tone];

  const run = async (action: NoticeAction) => {
    setRunning(action.label);
    setError(null);
    try {
      await action.run();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className={cn("flex flex-wrap items-start gap-x-3 gap-y-2.5 rounded-2xl px-3.5 py-3 ring-1", tone.box)}>
      <span
        aria-hidden
        className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-xl [&>svg]:h-4 [&>svg]:w-4", tone.icon)}
      >
        {notice.icon}
      </span>
      <div className="min-w-0 flex-1 basis-48 pt-0.5">
        <div className="flex items-center gap-1.5">
          <div aria-hidden className="font-semibold text-sm leading-snug">{notice.title}</div>
          {notice.info && (
            <Popover placement="bottom-start">
              <PopoverTrigger>
                <Button isIconOnly size="sm" variant="light" radius="full" aria-label="About controller address changes" className="h-5.5 min-w-0 w-5.5 text-default-500">
                  <Info className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </PopoverTrigger>
              <PopoverContent>
                <div className="max-w-xs p-3 text-sm leading-relaxed">{notice.info}</div>
              </PopoverContent>
            </Popover>
          )}
        </div>
        <div role="status">
          <span className="sr-only">{notice.title} </span>
          <div className="mt-0.5 text-default-500 text-sm leading-snug">{notice.body}</div>
          {error && <div className="mt-1 text-danger text-xs">{error}</div>}
        </div>
      </div>
      {(notice.actions?.length || notice.extra) && (
        <div className="ml-11 flex shrink-0 items-center gap-2 self-center sm:ml-0">
          {notice.actions?.map((action) => (
            <Button
              key={action.label}
              size="sm"
              radius="lg"
              variant={action.primary ? "solid" : "flat"}
              color={action.primary ? "primary" : "default"}
              isLoading={running === action.label}
              onPress={() => run(action)}
              className="font-medium active:scale-[0.97]"
            >
              {action.label}
            </Button>
          ))}
          {notice.extra}
        </div>
      )}
    </div>
  );
}

/**
 * A retry countdown that ticks while the controller is unreachable. The notice's words are a live region, so the
 * ticking number is hidden from assistive technology, which hears one steady sentence instead of one every second.
 */
function RetryIn({ at }: { at: string | null }) {
  const now = useNow(1000, at !== null);
  if (!at) return <>Trying again shortly.</>;
  const s = Math.ceil((Date.parse(at) - now) / 1000);
  return (
    <>
      <span aria-hidden>
        {s > 0 ? (
          <>
            Trying again in <span className="tabular-nums">{s}</span> s.
          </>
        ) : (
          "Trying again now…"
        )}
      </span>
      <span className="sr-only">It keeps trying again by itself.</span>
    </>
  );
}

const BUSY_AFTER = "It's yours again when they stop.";

/** What an unreachable notice adds about a controller whose address changed. */
const MOVED_HINT =
  "If your router gave it a new address, the plugin looks for it by itself. " +
  "Reserving a fixed address for it in your router stops it moving.";

/**
 * "Search again" on the unreachable notice: main tries the stored address and searches the network for the same
 * controller at another one (`refresh`). It resolves once the controller answers; the notice then goes by itself.
 */
function searchAgain(refresh: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await refresh();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      // The unreachable notice stays visible; repeating its diagnosis adds no useful detail.
      if (code === "unavailable") return;
      if (code === "timeout") throw new Error("Still searching: this notice goes away once it's found.");
      throw error;
    }
  };
}

type MainProblem = Exclude<NanoleafModel["mainStatus"], "running" | "connecting">;

/** Each status's words; `after` is what that means for the wall (a status's reason replaces `body`). */
const MAIN_COPY: Record<MainProblem, { title: string; body: string; after: string | null }> = {
  starting: {
    title: "Starting up",
    body: "The plugin is starting on the server; your wall follows in a moment.",
    after: null,
  },
  unavailable: {
    title: "The plugin isn't running",
    body: "Drift Beacon couldn't run it on the server just now.",
    after: "The wall keeps whatever it shows until the plugin is back.",
  },
  disabled: {
    title: "The plugin is switched off",
    body: "Switch Nanoleaf on for this workspace to drive the wall.",
    after: "The wall keeps whatever it shows.",
  },
  incompatible: {
    title: "This Drift Beacon can't run this version",
    body: "Update Drift Beacon or the plugin.",
    after: "The wall keeps whatever it shows until then.",
  },
  "not-installed": {
    title: "The plugin isn't installed here",
    body: "Install Nanoleaf in this workspace.",
    after: "The wall keeps whatever it shows until then.",
  },
};

interface NoticeHandlers {
  /** Pair again with the same controller (its token stopped working). */
  onPairAgain(): void;
  /** Change the controller's address (it stopped answering where it was). */
  onEditAddress(): void;
  /** The setup is already on screen: its own buttons do what Pair again and Edit address would. */
  readonly setupOpen?: boolean;
}

/**
 * Every notice the model calls for, most urgent first. Main's state is stale while main isn't running, and unknown
 * while the page is still hearing whether it runs (`connecting`, the first moment after opening): nothing about main
 * or the controller shows then, so opening the page never flashes a problem that isn't there.
 */
export function noticesFor(model: NanoleafModel, handlers: NoticeHandlers): NoticeSpec[] {
  const out: NoticeSpec[] = [];
  const { controller, connection, output, settings, actions } = model;
  const name = connection?.name ?? controller?.name ?? "The controller";

  if (model.mainStatus === "connecting") {
    // Not known yet: the app reports main's status in a moment.
  } else if (model.mainStatus !== "running") {
    const status = model.mainStatus;
    const copy = MAIN_COPY[status];
    const body = [sentence(model.mainStatusReason ?? copy.body), copy.after].filter(Boolean).join(" ");
    out.push({
      id: `main-${status}`,
      tone: status === "starting" || status === "disabled" ? "default" : "danger",
      icon: status === "starting" ? <Loader className="motion-safe:animate-spin" /> : <ServerOff />,
      title: copy.title,
      body,
    });
  } else if (controller && connection?.status === "unreachable") {
    // Main retries by itself except when it won't connect to the stored address at all (it isn't on the local
    // network): then nothing was asked, and `error` says what to enter instead. After a couple of failed retries it
    // also searches for the controller at a new address (once a minute at most); Search again does both at once.
    const refused = connection.retryAt === null && connection.error ? connection.error : null;
    out.push({
      id: "unreachable",
      tone: "warning",
      icon: <WifiOff />,
      title: `Can't reach ${name}`,
      body: refused ? (
        sentence(refused)
      ) : (
        <>
          Nothing answers at {address(connection.host ?? controller.host, connection.port ?? controller.port)}.{" "}
          <RetryIn at={connection.retryAt} />
        </>
      ),
      info: MOVED_HINT,
      actions: handlers.setupOpen
        ? []
        : [
            { label: "Search again", run: searchAgain(actions.refresh) },
            { label: "Edit address", run: handlers.onEditAddress },
          ],
      extra: <ForgetButton name={name} onForget={actions.forget} />,
    });
  } else if (controller && connection?.status === "unauthorized") {
    out.push({
      id: "unauthorized",
      tone: "danger",
      icon: <KeyRound />,
      title: `${name} turned the plugin away`,
      body: connection.error ?? "Its access token stopped working; the controller may have been reset.",
      actions: handlers.setupOpen ? [] : [{ label: "Pair again", primary: true, run: handlers.onPairAgain }],
    });
  } else if (output?.mode === "busy") {
    out.push({
      id: "busy",
      tone: "warning",
      icon: <Users />,
      title: "Someone else is driving this wall",
      body: [sentence(output.detail ?? "Another Drift Beacon user or workspace has it"), BUSY_AFTER].join(" "),
    });
  } else if (output?.mode === "yielded") {
    out.push({
      id: "yielded",
      tone: "default",
      icon: <Hand />,
      title: "Your wall was changed somewhere else",
      body:
        "Someone picked a scene in the Nanoleaf app, HomeKit or Home Assistant, so the plugin stepped aside until " +
        "your next session or pin.",
      actions: [{ label: "Take it back", primary: true, run: actions.resume }],
    });
  }

  if (controller && !settings.enabled) {
    out.push({
      id: "paused",
      tone: "default",
      icon: <Pause />,
      title: "Paused",
      body: "Your Nanoleaf shows its own scene until you switch driving back on.",
      actions: [{ label: "Resume", run: () => actions.saveSettings({ enabled: true }) }],
    });
  }

  if (!model.supportsGoals) {
    out.push({
      id: "goals",
      tone: "default",
      icon: <Target />,
      title: "This Drift Beacon doesn't send goals or pins yet",
      body:
        "The wall still glows in your live activity's colour. Update Drift Beacon to fill it with goal progress " +
        "and show pinned activities.",
    });
  }
  return out;
}

/** The notice strip: notices arrive and leave in place, pushing the page gently rather than jumping it. */
export function Notices(handlers: NoticeHandlers) {
  const model = useModel();
  const reduced = useReducedMotion();
  const notices = noticesFor(model, handlers);
  return (
    <div className="flex flex-col">
      <AnimatePresence initial={false}>
        {notices.map((notice) => (
          <motion.div
            key={notice.id}
            // A pixel wider than the notice (and padded back below), so the clip keeps its ring.
            className="-mx-px -mt-px overflow-hidden"
            initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0, transition: { duration: 0.15, ease: EASE_OUT } }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
          >
            <div className="px-px pt-px pb-3">
              <Notice notice={notice} />
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
