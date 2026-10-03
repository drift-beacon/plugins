import { cn } from "@heroui/theme";
import { useMemo } from "react";
import { cssRgb } from "../../../../shared/color.ts";
import type { PlacedLayout, Rgb } from "../../../../shared/types.ts";
import { layoutStage } from "./stageLayout.ts";

/** Breathing room around the thumbnail's drawing, px. */
const PAD = 8;

interface OrderThumbProps {
  readonly placed: PlacedLayout;
  /** The order to show, first fills first. */
  readonly ids: readonly number[];
  readonly accent: Rgb;
  /** The drawing box, px (it scales with its column). */
  readonly width: number;
  readonly height: number;
  readonly className?: string;
}

/**
 * A fill order as a picture: the wall in miniature, shaded from the first panel to fill to the last, with the route
 * drawn through the panels and a dot where it starts.
 */
export function OrderThumb({ placed, ids, accent, width, height, className }: OrderThumbProps) {
  const stage = useMemo(() => layoutStage(placed, width, height, PAD), [placed, width, height]);
  const rank = new Map(ids.map((id, i) => [id, i]));
  const last = Math.max(1, ids.length - 1);
  const route = ids.map((id) => stage.byId.get(id)?.center).filter((c) => c !== undefined);
  const start = route[0];
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn("block w-full", className)}
      style={{ aspectRatio: `${width} / ${height}` }}
      aria-hidden
    >
      {stage.panels.map((p) => {
        const r = rank.get(p.id);
        return (
          <g key={p.id}>
            <path d={p.path} fill="var(--db-surface-raised)" stroke="var(--db-border)" strokeWidth={0.75} />
            {r !== undefined && <path d={p.path} fill={cssRgb(accent, 0.92 - 0.72 * (r / last))} />}
          </g>
        );
      })}
      {route.length > 1 && (
        <polyline
          points={route.map((c) => `${c[0]},${c[1]}`).join(" ")}
          fill="none"
          stroke="var(--db-foreground)"
          strokeOpacity={0.6}
          strokeWidth={1.25}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {start && <circle cx={start[0]} cy={start[1]} r={2.75} fill="var(--db-foreground)" />}
    </svg>
  );
}
