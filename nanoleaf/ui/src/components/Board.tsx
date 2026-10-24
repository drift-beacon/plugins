import { cn } from "@heroui/theme";
import type { ReactNode } from "react";
import { ControllerCard } from "./ControllerCard.tsx";
import { NowCard } from "./NowCard.tsx";
import { useSettingsGroups } from "./SettingsPanel.tsx";
import { Starfield } from "./Starfield.tsx";
import { HORIZON_OVERLAP } from "./wall/Horizon.tsx";
import type { WallParts } from "./wall/WallSection.tsx";

/**
 * Several cards read as one: the children lose their own corners and rings and share this card's, with a rule
 * between them.
 */
const MERGED =
  "overflow-hidden rounded-3xl bg-content1 ring-1 ring-default-100 divide-y divide-default-100 [&>*]:rounded-none [&>*]:ring-0 [&_.wall-stage]:rounded-none [&_.wall-stage]:ring-0";

/** How a goal fills the wall, as one card: try a goal, then choose the order. */
export function FillCard({ parts, className }: { parts: WallParts; className?: string }) {
  return (
    <div className={cn(MERGED, className)}>
      {parts.scrubber}
      {parts.editor}
    </div>
  );
}

function StateCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-3xl bg-content1 ring-1 ring-default-100", className)}>{children}</div>;
}

/**
 * The wide layout, two columns that share the weight so both end near the same line. The wall's column is what you
 * look at, with no card: the drawing hangs in a patch of night sky (twinkling stars that fade into the page at every
 * edge), its light lying under it as a horizon, and what it shows now sitting on that line, with how bright under it. The side is what you change (how it fills, then the controller
 * with what the wall does when nothing is going on). Under them the settings are the wall's situations, one card
 * each: an activity pinned, a session live, a schedule firing, other plugins.
 */
export function Board({ parts }: { parts: WallParts }) {
  const light = useSettingsGroups();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-4">
        <div>
          <div className="relative">
            <div className="night-sky pointer-events-none absolute -inset-x-10 -top-10 -bottom-4">
              <Starfield />
            </div>
            <div className="relative">{parts.stage}</div>
          </div>
          <div className="relative divide-y divide-default-100/60" style={{ marginTop: -HORIZON_OVERLAP }}>
            {/* Over the drawing's foot only as words and light: presses fall through to the panels underneath. */}
            <div className="pointer-events-none">
              <NowCard bare />
            </div>
            {light.brightness}
            {light.pinnedBrightness}
          </div>
        </div>
        <div className="space-y-4">
          <FillCard parts={parts} />
          <ControllerCard />
        </div>
      </div>
      <div className="flex items-baseline justify-between gap-3 px-1 pt-1">
        <h2 className="font-semibold text-sm">What the wall does</h2>
        <span role="status" className="min-w-0 truncate text-danger text-xs">
          {light.saveError}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <StateCard className="row-span-2">{light.pinned}</StateCard>
        <StateCard>{light.track}</StateCard>
        <StateCard>{light.schedule}</StateCard>
        <StateCard className="col-span-2">{light.plugins}</StateCard>
      </div>
    </div>
  );
}
