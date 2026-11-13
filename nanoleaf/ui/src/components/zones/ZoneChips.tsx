import { cn } from "@heroui/theme";
import { type KeyboardEvent, useRef } from "react";
import type { ResolvedZone } from "../../../../shared/types.ts";
import { rovingStep } from "../../lib/roving.ts";
import { tagCss } from "./ZoneCards.tsx";

/**
 * Which zone a part below is about (the fill order), as tag-coloured chips: one choice, a radio group (arrows, Home and
 * End move it).
 */
export function ZoneChips({
  zones,
  value,
  name,
  label,
  onChange,
  className,
}: {
  zones: readonly ResolvedZone[];
  value: string | null;
  name(zone: ResolvedZone): string;
  label: string;
  onChange(id: string): void;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const next = rovingStep(e.key, index, zones.length);
    if (next === null) return;
    e.preventDefault();
    const zone = zones[next];
    if (!zone) return;
    onChange(zone.id);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-wrap gap-1.5", className)}>
      {zones.map((zone, i) => {
        const on = zone.id === value;
        const tag = tagCss(zone);
        return (
          <button
            key={zone.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(zone.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "flex h-8 max-w-full items-center gap-1.5 rounded-full px-3 font-medium text-xs",
              "transition-[background-color,box-shadow,color,transform] duration-150 ease-out active:scale-[0.97]",
              on ? "bg-default-200 text-foreground" : "bg-default-100 text-default-600 hover:bg-default-200",
            )}
            style={on ? { boxShadow: `inset 0 0 0 1.5px ${tag}` } : undefined}
          >
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: tag }} />
            <span className="truncate">{name(zone)}</span>
          </button>
        );
      })}
    </div>
  );
}
