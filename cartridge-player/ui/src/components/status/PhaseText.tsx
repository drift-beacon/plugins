import { Check, CircleAlert, CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx.ts";
import { sentence } from "../../view/errors.ts";
import { durationPhrase, timeOfDay } from "../../view/format.ts";
import type { StagePhase } from "../../view/phase.ts";
import { Eyebrow } from "../kit.tsx";
import { Elapsed } from "./Elapsed.tsx";

/** A heading that never breaks the layout: two lines at most, long words wrap anywhere, the whole name on hover. */
function Title({ children, compact, title }: { children: ReactNode; compact: boolean; title?: string }) {
  return (
    <h2
      title={title}
      className={cx(
        "line-clamp-2 font-semibold leading-tight [overflow-wrap:anywhere]",
        compact ? "mt-1 text-lg" : "mt-2 text-2xl md:text-3xl",
      )}
    >
      {children}
    </h2>
  );
}

const LiveDot = () => <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />;

/** What the stage says about the phase: the eyebrow, the heading and, while tracking, the clock. */
export function PhaseHeadline({ phase, compact = false }: { phase: StagePhase; compact?: boolean }) {
  switch (phase.kind) {
    case "empty":
      return phase.saved ? (
        <div>
          <Eyebrow tone="success">
            <Check aria-hidden="true" className="h-3.5 w-3.5" /> Saved
          </Eyebrow>
          <Title compact={compact} title={phase.saved.activity.name}>
            {durationPhrase(phase.saved.durationMs)} of {phase.saved.activity.name}
          </Title>
        </div>
      ) : (
        <div>
          <Eyebrow>Slot empty</Eyebrow>
          <Title compact={compact}>Pick a cartridge</Title>
        </div>
      );
    case "reading":
      return (
        <div>
          <Eyebrow>Reading cartridge</Eyebrow>
          <p className={cx("font-mono text-default-400", compact ? "mt-1 text-xs" : "mt-2 text-sm")}>{phase.tag}</p>
        </div>
      );
    case "playing": {
      const { activity } = phase;
      const meta = [activity.categoryName, `started ${timeOfDay(phase.startedAt)}`].filter(Boolean).join(" · ");
      return (
        <div>
          <Eyebrow tone="success">
            <LiveDot /> Tracking
          </Eyebrow>
          <Title compact={compact} title={activity.name}>
            {activity.name}
          </Title>
          {!compact && <p className="mt-1 text-sm text-default-500">{meta}</p>}
          <div className={compact ? "mt-1.5" : "mt-5"}>
            <Elapsed startedAt={phase.startedAt} compact={compact} />
          </div>
        </div>
      );
    }
    case "marked":
      return (
        <div>
          <Eyebrow tone="success">
            <Check aria-hidden="true" className="h-3.5 w-3.5" /> Marked
          </Eyebrow>
          <Title compact={compact} title={phase.activity.name}>
            {phase.activity.name}
          </Title>
        </div>
      );
    case "unknown":
      return (
        <div>
          <Eyebrow tone="warning">
            <CircleHelp aria-hidden="true" className="h-3.5 w-3.5" /> New cartridge
          </Eyebrow>
          <Title compact={compact}>What's on this one?</Title>
        </div>
      );
    case "ready":
      return (
        <div>
          {phase.reason === "labelled" ? (
            <Eyebrow tone="success">
              <Check aria-hidden="true" className="h-3.5 w-3.5" /> Labelled
            </Eyebrow>
          ) : (
            <Eyebrow>{phase.reason === "ended" ? "Session ended" : "In the player"}</Eyebrow>
          )}
          <Title compact={compact} title={phase.activity.name}>
            {phase.activity.name}
          </Title>
        </div>
      );
    case "parked":
      return (
        <div>
          <Eyebrow>In the player</Eyebrow>
          <Title compact={compact} title={phase.activity.name}>
            {phase.activity.name}
          </Title>
        </div>
      );
    case "orphan":
      return (
        <div>
          <Eyebrow tone="danger">Activity missing</Eyebrow>
          <Title compact={compact}>This cartridge's activity was deleted</Title>
        </div>
      );
    case "archived":
      return (
        <div>
          <Eyebrow tone="warning">Archived</Eyebrow>
          <Title compact={compact} title={phase.activity.name}>
            {phase.activity.name}
          </Title>
        </div>
      );
    case "error":
      return (
        <div>
          <Eyebrow tone="danger">
            <CircleAlert aria-hidden="true" className="h-3.5 w-3.5" /> Couldn't start
          </Eyebrow>
          <Title compact={compact} title={phase.activity?.name}>
            {phase.activity?.name ?? "This cartridge"}
          </Title>
        </div>
      );
  }
}

/** The sentence under the heading: what's going on and what happens next. */
export function PhaseNote({ phase }: { phase: StagePhase }) {
  return <p className="text-sm leading-snug text-default-500">{noteFor(phase)}</p>;
}

function noteFor(phase: StagePhase): ReactNode {
  switch (phase.kind) {
    case "empty":
      return phase.saved
        ? "The slot's empty. Slide another cartridge in whenever you're ready."
        : "Slide one in to start tracking. Pull it out to stop.";
    case "reading":
      return "The player has it. Checking what's on it…";
    case "playing":
      return "Pull the cartridge out to stop.";
    case "marked":
      return `Marked at ${timeOfDay(phase.at)}. It marks again each time it goes in.`;
    case "unknown":
      return (
        <>
          Leave it in the player while you label it. <span className="font-mono text-xs text-default-400">{phase.tag}</span>
        </>
      );
    case "ready":
      if (phase.reason === "ended") return "Its session ended in Drift Beacon, but the cartridge is still in. Start it again, or take it out.";
      return phase.activity.point
        ? "It's in the player. Mark it now, or it marks next time it goes in."
        : "It's in the player. Start tracking now, or it starts next time it goes in.";
    case "parked":
      return `Not tracking. It ${phase.activity.point ? "marks" : "starts"} by itself the next time it goes in.`;
    case "orphan":
      return "Nothing is tracking. Give it a new label and it's ready.";
    case "archived":
      return `${phase.activity.name} is archived, so nothing started. Pick another activity, or restore it in Drift Beacon.`;
    case "error":
      // Main's reason, as the action gave it: usually a bare phrase.
      return sentence(phase.message);
  }
}
