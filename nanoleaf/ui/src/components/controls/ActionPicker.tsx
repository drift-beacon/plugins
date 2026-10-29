import { Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { cn } from "@heroui/theme";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ActivityLike, GestureAction } from "../../../../shared/types.ts";
import { Icon } from "../Icon.tsx";

type Kind = GestureAction["kind"];

/** What the picker offers, in order. The last two go on to pick an activity. */
const CHOICES: readonly { readonly kind: Kind; readonly label: string; readonly step?: string }[] = [
  { kind: "pause-resume", label: "Pause or resume" },
  { kind: "stop-unpin", label: "Stop or unpin" },
  { kind: "start", label: "Start an activity", step: "Start which activity?" },
  { kind: "pin", label: "Pin an activity", step: "Pin which activity?" },
];

/** An action as Controls says it: a chosen activity by name, "Mark … done" for one that is a single moment. */
export function actionLabel(action: GestureAction | undefined, activities: readonly ActivityLike[]): string | null {
  if (!action) return null;
  if (action.kind !== "start" && action.kind !== "pin") return CHOICES.find((c) => c.kind === action.kind)?.label ?? null;
  const activity = activities.find((a) => a.id === action.activityId);
  // The app's own words: an activity is archived, or it's gone.
  const missing = !activity ? "a removed activity" : activity.archived ? "an archived activity" : null;
  if (missing) return action.kind === "pin" ? `Pin ${missing}` : `Start ${missing}`;
  if (!activity) return null;
  if (action.kind === "pin") return `Pin ${activity.name}`;
  return activity.trackingType === "point" ? `Mark ${activity.name} done` : `Start ${activity.name}`;
}

const ROW =
  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors duration-150 ease-out hover:bg-default-100 focus-visible:bg-default-100";

/**
 * What a gesture does, as a field that opens a list: Nothing, the two that follow what's going on, then start or pin an
 * activity, which goes on to a second step listing the activities, with a way back.
 */
export function ActionPicker({
  label,
  value,
  activities,
  onChange,
}: {
  /** The gesture, for screen readers. */
  label: string;
  value: GestureAction | undefined;
  activities: readonly ActivityLike[];
  onChange(value: GestureAction | null): void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<(typeof CHOICES)[number] | null>(null);
  const close = () => {
    setOpen(false);
    setStep(null);
  };
  const choose = (next: GestureAction | null) => {
    onChange(next);
    close();
  };
  const shown = actionLabel(value, activities);
  const chosen = value && "activityId" in value ? activities.find((a) => a.id === value.activityId) : undefined;
  const listed = activities.filter((a) => !a.archived);

  return (
    <Popover
      placement="bottom-end"
      isOpen={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      classNames={{ content: "p-1" }}
    >
      <PopoverTrigger>
        <button
          type="button"
          aria-label={`${label}: ${shown ?? "nothing"}`}
          className={cn(
            "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-sm",
            "transition-[background-color,transform] duration-150 ease-out active:scale-[0.98]",
            shown ? "bg-default-100 hover:bg-default-200" : "text-default-400 hover:bg-default-100",
          )}
        >
          {chosen && !chosen.archived && (
            <Icon path={chosen.iconPath} className="h-4 w-4 shrink-0" style={{ color: chosen.color }} />
          )}
          <span className="min-w-0 flex-1 truncate">{shown ?? "Nothing"}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-default-400" />
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="w-64 max-w-[80vw]">
          {step ? (
            <>
              <button type="button" className={cn(ROW, "text-default-500")} onClick={() => setStep(null)}>
                <ChevronLeft className="h-4 w-4" />
                {step.step}
              </button>
              <div className="max-h-72 overflow-y-auto">
                {listed.length === 0 && <p className="px-2.5 py-2 text-default-500 text-sm">No activities yet.</p>}
                {listed.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={ROW}
                    onClick={() => choose({ kind: step.kind as "start" | "pin", activityId: a.id })}
                  >
                    <Icon path={a.iconPath} className="h-4 w-4 shrink-0" style={{ color: a.color }} />
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    {a.trackingType === "point" && step.kind === "start" && (
                      <span className="text-default-400 text-xs">mark done</span>
                    )}
                    {value?.kind === step.kind && chosen?.id === a.id && (
                      <Check className="h-4 w-4 shrink-0 text-primary" />
                    )}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <button type="button" className={cn(ROW, "text-default-500")} onClick={() => choose(null)}>
                <span className="flex-1">Nothing</span>
                {!value && <Check className="h-4 w-4 text-primary" />}
              </button>
              {CHOICES.map((c) => (
                <button
                  key={c.kind}
                  type="button"
                  className={ROW}
                  onClick={() => (c.step ? setStep(c) : choose({ kind: c.kind as "pause-resume" | "stop-unpin" }))}
                >
                  <span className="flex-1">{c.label}</span>
                  {c.step ? (
                    <ChevronRight className="h-4 w-4 text-default-400" />
                  ) : (
                    value?.kind === c.kind && <Check className="h-4 w-4 text-primary" />
                  )}
                </button>
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
