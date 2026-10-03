import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { MainNotice } from "./components/MainNotice.tsx";
import type { SetupLight } from "./components/scene/Led.tsx";
import { PlayerScene } from "./components/scene/PlayerScene.tsx";
import { SetupGuide } from "./components/setup/SetupGuide.tsx";
import { PlayerStatus } from "./components/setup/PlayerStatus.tsx";
import { Shelf } from "./components/shelf/Shelf.tsx";
import { PhaseActions, type StageActions } from "./components/status/PhaseActions.tsx";
import { PhaseHeadline, PhaseNote } from "./components/status/PhaseText.tsx";
import { useMediaQuery } from "./hooks/useMediaQuery.ts";
import { type PlayerModel, useModel } from "./model.ts";
import { EASE_OUT, SWAP_S } from "./motion.ts";
import { canChange } from "./view/main-status.ts";
import {
  cartridgeLook,
  deriveStage,
  ENDING_HOLD_MS,
  holdStage,
  nextChange,
  phaseKey,
  phaseSentence,
  phaseTag,
  type ShownStage,
  type Stage,
} from "./view/phase.ts";
import { everHeard } from "./view/presence.ts";

/** Below this width (the frame's, not the window's) the phone layout takes over, as in magic-cube. */
const PHONE_QUERY = "(max-width: 599px)";

/**
 * The stage as this copy sees it: the model's data plus what only this copy knows (Later, just labelled), re-derived
 * when the data changes and again when the clock alone changes it (the reading beat ending, the Saved moment fading).
 * A playing stage whose session just stopped is held for a moment (`holdStage`): an eject arrives as the ended
 * session and then the emptied slot, and the stage shouldn't say "Session ended" in between.
 */
function useStage(model: PlayerModel) {
  const [parked, setParked] = useState<string | null>(null);
  const [labelled, setLabelled] = useState<string | null>(null);
  const [focusPrimary, setFocusPrimary] = useState(false);
  const [tick, setTick] = useState(0);
  // The clock is read again whenever the data changes or the timer fires: nothing else changes what the stage shows.
  const now = useMemo(() => Date.now(), [model, tick]);
  const input = useMemo(
    () => ({
      record: model.record,
      mappings: model.mappings,
      activities: model.lookup,
      live: model.live,
      reading: model.reading,
      parked,
      labelled,
      now,
    }),
    [model.record, model.mappings, model.lookup, model.live, model.reading, parked, labelled, now],
  );
  const derived = useMemo(() => deriveStage(input), [input]);
  const [shown, setShown] = useState<ShownStage>(() => ({ stage: derived, heldSince: null }));
  const held = holdStage(shown, derived, now);
  // State adjusted to new data while rendering: React renders again with it before anything is drawn.
  if (held !== shown) setShown(held);
  const { stage } = held;
  const changes = [nextChange(input, stage), held.heldSince === null ? null : held.heldSince + ENDING_HOLD_MS];
  const next = changes.reduce((soonest, at) => (at === null || (soonest !== null && soonest <= at) ? soonest : at), null);

  // Armed again after every tick: a timer that fired a moment early leaves the same change still to come.
  useEffect(() => {
    if (next === null) return;
    const id = window.setTimeout(() => setTick((t) => t + 1), Math.max(0, next - Date.now()) + 16);
    return () => window.clearTimeout(id);
  }, [next, tick]);

  // "Move focus to Start" is for the cartridge just labelled here; another cartridge doesn't inherit it.
  useEffect(() => {
    if (stage.slotKey !== labelled) setFocusPrimary(false);
  }, [stage.slotKey, labelled]);

  // "Later" and "just labelled" describe a cartridge sitting in the slot with nothing started. Once it tracks (or has
  // marked) that moment is over: if its session then ends elsewhere, the stage says so instead of repeating either,
  // and nothing moves focus for an event the user didn't cause.
  const started = stage.phase.kind === "playing" || stage.phase.kind === "marked";
  useEffect(() => {
    if (!started) return;
    setParked(null);
    setLabelled(null);
    setFocusPrimary(false);
  }, [started]);

  const key = stage.slotKey;
  const actions: StageActions = {
    readOnly: !canChange(model.mainStatus),
    deviceId: stage.device?.id ?? null,
    onLabelled: () => {
      setLabelled(key);
      // A new label is a new question: an earlier "Later" was about the old one.
      setParked(null);
      setFocusPrimary(true);
    },
    onPark: () => setParked(key),
    focusPrimary,
  };
  return { stage, actions };
}

/**
 * The whole interface. It takes no props and reads the model from context, so it's memoised: an update from the app
 * that leaves the model as it was (a peer plugin's state, a session elsewhere in the workspace) re-renders nothing.
 */
export const App = memo(function App() {
  const model = useModel();
  const phone = useMediaQuery(PHONE_QUERY);
  const reduced = useReducedMotionConfig();
  const { stage, actions } = useStage(model);
  const { phase } = stage;
  const tag = phaseTag(phase);
  const firstRun = !everHeard(model.record) && Object.keys(model.mappings).length === 0 && model.record.unknown.length === 0;
  // The setup guide holds the stage from a first run until the first cartridge goes in, so the moment the player
  // connects is the guide's to show ("… is connected. Slide a cartridge in") rather than a sudden change of panel.
  const [guiding, setGuiding] = useState(firstRun);
  useEffect(() => {
    if (firstRun) setGuiding(true);
    else if (phase.kind !== "empty") setGuiding(false);
  }, [firstRun, phase.kind]);
  const guide = (firstRun || guiding) && phase.kind === "empty";
  // What the guide says the real player's light is doing, for the replica to show.
  const [guideLight, setGuideLight] = useState<SetupLight | null>(null);

  const lookOf = useCallback((shown: string) => cartridgeLook(shown, phase, model.mappings, model.lookup), [phase, model.mappings, model.lookup]);
  const scene = (
    <PlayerScene
      phase={phase.kind}
      tag={tag}
      lookOf={lookOf}
      glow={phase.kind === "playing" ? phase.activity.color : null}
      compact={phone}
      setup={guide ? guideLight : null}
    />
  );

  // On a phone, a cartridge that needs the user scrolls the page back to its prompt: the hardware has the floor.
  const needsUser = phase.kind === "unknown" || phase.kind === "orphan" || phase.kind === "archived" || phase.kind === "error";
  useEffect(() => {
    if (phone && needsUser) window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }, [phone, needsUser, reduced]);

  const shelf = <Shelf stageTag={tag} readOnly={!canChange(model.mainStatus)} phone={phone} heard={everHeard(model.record)} />;
  const announce = (
    <p role="status" aria-live="polite" className="sr-only">
      {phaseSentence(phase)}
    </p>
  );

  if (phone) {
    return (
      <div className="cp-deck pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        {announce}
        <div className="sticky top-0 z-10 bg-background pb-2">
          <section aria-label="Player" className="cp-stage cp-stage-phone flex items-center rounded-b-3xl">
            <div className="w-1/2 max-w-[240px] shrink-0 pl-2">{scene}</div>
            <div className="min-w-0 flex-1 space-y-1.5 py-3 pr-3">
              <PlayerStatus device={stage.device} phone />
              {!guide && (
                <Swap id={phaseKey(phase)}>
                  <PhaseHeadline phase={phase} compact />
                </Swap>
              )}
            </div>
          </section>
        </div>
        <div className="space-y-5 px-3 pt-2">
          <MainNotice status={model.mainStatus} reason={model.mainStatusReason} />
          {guide ? (
            <div className="rounded-3xl bg-content1 p-4 ring-1 ring-default-100">
              <SetupGuide compact onLight={setGuideLight} />
            </div>
          ) : (
            <Swap id={phaseKey(phase)}>
              <div className="space-y-3 rounded-2xl bg-content1 p-4 ring-1 ring-default-100">
                <PhaseNote phase={phase} />
                <PhaseActions phase={phase} actions={actions} />
              </div>
            </Swap>
          )}
          {shelf}
        </div>
      </div>
    );
  }

  return (
    <div className="cp-deck mx-auto max-w-[1072px] space-y-6 px-4 pt-4 pb-10 sm:px-6 sm:pt-6">
      {announce}
      <MainNotice status={model.mainStatus} reason={model.mainStatusReason} />
      <section aria-label="Player" className="cp-stage overflow-hidden rounded-3xl">
        <div className="grid grid-cols-[1.1fr_1fr] items-center">
          <div className="px-3 pt-2 md:px-4">
            <div className="mx-auto max-w-[520px]">{scene}</div>
          </div>
          <div className="flex min-w-0 flex-col gap-5 py-6 pr-5 pl-1 md:py-8 md:pr-8 md:pl-2">
            {/* The guide is the whole panel while it runs: the presence pill would only offer the same guide again. */}
            {guide ? (
              <SetupGuide onLight={setGuideLight} />
            ) : (
              <>
                <div className="flex">
                  <PlayerStatus device={stage.device} phone={false} />
                </div>
                <StatusBody stage={stage} actions={actions} />
              </>
            )}
          </div>
        </div>
      </section>
      {shelf}
    </div>
  );
});

function StatusBody({ stage, actions }: { stage: Stage; actions: StageActions }) {
  const { phase } = stage;
  return (
    <Swap id={phaseKey(phase)} className="min-h-[228px]">
      <div className="space-y-4">
        <PhaseHeadline phase={phase} />
        <PhaseNote phase={phase} />
        <PhaseActions phase={phase} actions={actions} />
      </div>
    </Swap>
  );
}

/** One body giving way to the next: the old one leaves before the new one arrives. Opacity only under reduced motion. */
function Swap({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const reduced = useReducedMotionConfig();
  return (
    <div className={className}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={id}
          initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(6px)", filter: "blur(2px)" }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, transform: "translateY(0px)", filter: "blur(0px)" }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(-4px)", filter: "blur(2px)" }}
          transition={{ duration: SWAP_S, ease: EASE_OUT }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
