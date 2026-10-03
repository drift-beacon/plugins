import { Play, RotateCcw } from "lucide-react";
import { useEffect, useRef } from "react";
import { useRequest } from "../../hooks/useRequest.ts";
import { useModel } from "../../model.ts";
import { recordedByMain, sentence } from "../../view/errors.ts";
import { suggestions } from "../../view/library.ts";
import type { StagePhase } from "../../view/phase.ts";
import { ActivityPicker } from "../ActivityPicker.tsx";
import { Icon } from "../Icon.tsx";
import { Button, InlineError } from "../kit.tsx";

export interface StageActions {
  /** Changes go through main; while it isn't running these are shown but disabled. */
  readonly readOnly: boolean;
  /** The device the stage shows, for Start. */
  readonly deviceId: string | null;
  /** The stage's cartridge was labelled from here and is still in: say so, and offer Start. */
  onLabelled(): void;
  /** "Later": stop offering Start for this stay of the cartridge, on this copy. */
  onPark(): void;
  /** Move focus to the phase's main button when it appears (after labelling from the stage). */
  readonly focusPrimary: boolean;
}

/** What the user can do about the phase: label it, start it, relabel it, try again. Nothing for the rest. */
export function PhaseActions({ phase, actions }: { phase: StagePhase; actions: StageActions }) {
  switch (phase.kind) {
    case "unknown":
      return <LabelPrompt tag={phase.tag} actions={actions} />;
    case "orphan":
    case "archived":
      return <Relabel tag={phase.tag} current={phase.kind === "archived" ? phase.activity.id : null} actions={actions} />;
    case "ready":
    case "parked":
    case "error":
      return <StartButtons phase={phase} actions={actions} />;
    default:
      return null;
  }
}

function StartButtons({ phase, actions }: { phase: Extract<StagePhase, { kind: "ready" | "parked" | "error" }>; actions: StageActions }) {
  const { actions: model } = useModel();
  const request = useRequest();
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (actions.focusPrimary) primary.current?.focus();
  }, [actions.focusPrimary]);
  const point = phase.activity?.point ?? false;
  const label = phase.kind === "error" ? "Try again" : point ? "Mark now" : "Start tracking";
  // A start that main ran and that failed is on the slot, with the action's own reason. The error phase's note already
  // shows it, so nothing is added under the buttons; a parked cartridge has no such note, so the reason goes here in
  // place of the request code's wording (which would blame the connection). Anything else is the request's own failure.
  const failure =
    phase.kind === "error" && recordedByMain(request.cause, phase.message)
      ? null
      : phase.kind === "parked" && phase.error !== null && recordedByMain(request.cause, phase.error)
        ? sentence(phase.error)
        : request.error;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          ref={primary}
          tone={phase.kind === "parked" ? "flat" : "primary"}
          icon={phase.kind === "error" ? <RotateCcw aria-hidden="true" className="h-4 w-4" /> : <Play aria-hidden="true" className="h-4 w-4" />}
          pending={request.pending}
          disabled={actions.readOnly}
          onClick={() => void request.run(() => model.start(actions.deviceId))}
        >
          {label}
        </Button>
        {phase.kind !== "parked" && (
          <Button tone="light" disabled={request.pending} onClick={actions.onPark}>
            Later
          </Button>
        )}
      </div>
      {failure && <InlineError>{failure}</InlineError>}
    </div>
  );
}

/** A new cartridge: one tap on a suggestion, or search every activity. Nothing takes focus by itself. */
function LabelPrompt({ tag, actions }: { tag: string; actions: StageActions }) {
  const model = useModel();
  const request = useRequest();
  const offered = suggestions(model.activities, model.mappings);
  const label = async (activityId: string) => {
    const result = await request.run(() => model.actions.label(tag, activityId));
    if (result?.inSlot) actions.onLabelled();
  };
  return (
    <div className="space-y-3">
      {offered.length > 0 && (
        <div role="group" aria-label="Suggested labels" className="cp-chips flex gap-1.5">
          {offered.map((activity) => (
            <button
              key={activity.id}
              type="button"
              disabled={actions.readOnly}
              // Not `disabled` while the request runs: that would drop focus from the chip that was pressed.
              aria-disabled={request.pending || undefined}
              onClick={() => void label(activity.id)}
              className="cp-press cp-touch flex max-w-full shrink-0 items-center gap-1.5 rounded-full bg-default-100 px-3 py-1.5 text-xs text-default-600 hover:bg-default-200 hover:text-foreground disabled:opacity-50 aria-disabled:opacity-50"
            >
              <Icon path={activity.iconPath} color={activity.color} className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{activity.name}</span>
            </button>
          ))}
        </div>
      )}
      <ActivityPicker
        mode="typeahead"
        label={offered.length ? "Or search every activity" : "Search activities"}
        disabled={actions.readOnly}
        pending={request.pending}
        onPick={(id) => void label(id)}
      />
      {request.error && <InlineError>{request.error}</InlineError>}
    </div>
  );
}

function Relabel({ tag, current, actions }: { tag: string; current: string | null; actions: StageActions }) {
  const model = useModel();
  const request = useRequest();
  return (
    <div className="space-y-2">
      <ActivityPicker
        mode="typeahead"
        label="Relabel as…"
        value={current}
        disabled={actions.readOnly}
        pending={request.pending}
        onPick={async (id) => {
          const result = await request.run(() => model.actions.label(tag, id));
          if (result?.inSlot) actions.onLabelled();
        }}
      />
      {request.error && <InlineError>{request.error}</InlineError>}
    </div>
  );
}
