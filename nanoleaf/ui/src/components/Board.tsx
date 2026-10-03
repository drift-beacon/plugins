import { cn } from "@heroui/theme";
import type { ReactNode } from "react";
import { ControllerStrip } from "./ControllerCard.tsx";
import { NowCard } from "./NowCard.tsx";
import { useSettingsGroups } from "./SettingsPanel.tsx";
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
 * The wide layout. Two cards on top: the wall as one thing (the drawing, what it shows now, its controller and its
 * brightness) and how it fills (the goal preview and the fill order). Under them the settings are the wall's
 * situations, one card each: an activity pinned, a session live, a schedule firing, nothing going on, other plugins.
 */
export function Board({ parts }: { parts: WallParts }) {
  const light = useSettingsGroups();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[minmax(0,1fr)_380px] items-stretch gap-4">
        <div className={MERGED}>
          {parts.stage}
          <NowCard />
          <ControllerStrip />
          {light.brightness}
        </div>
        <FillCard parts={parts} />
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
        <StateCard>{light.idle}</StateCard>
        <StateCard>{light.plugins}</StateCard>
      </div>
    </div>
  );
}
