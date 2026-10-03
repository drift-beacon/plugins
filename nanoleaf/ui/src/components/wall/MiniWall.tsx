import { motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { cssRgb } from "../../../../shared/color.ts";
import type { PlacedLayout, Rgb } from "../../../../shared/types.ts";
import { EASE_OUT } from "../../motion.ts";
import type { PanelFlash } from "./StageCanvas.tsx";
import { layoutStage } from "./stageLayout.ts";

/** The thumbnail's drawing box, px (it scales down with its column), and its breathing room. */
const W = 320;
const H = 84;
const PAD = 6;

interface MiniWallProps {
  readonly placed: PlacedLayout;
  /** The panel whose row is hovered, focused or being dragged. */
  readonly focusId: number | null;
  /** A row just moved (or a panel picked): it flashes here too. */
  readonly flash: PanelFlash | null;
  readonly accent: Rgb;
}

/**
 * A thumbnail of the wall above the sequence list, for when the list sits below the drawing (narrow columns): the
 * row you hover, focus, drag or move lights up here, so you can see which panel it is without scrolling back up.
 */
export function MiniWall({ placed, focusId, flash, accent }: MiniWallProps) {
  const reduced = useReducedMotion();
  const stage = useMemo(() => layoutStage(placed, W, H, PAD), [placed]);
  const focused = focusId === null ? undefined : stage.byId.get(focusId);
  const flashed = flash ? stage.byId.get(flash.id) : undefined;
  const color = cssRgb(accent);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block h-[84px] w-full rounded-xl bg-content1"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
    >
      {stage.panels.map((p) => (
        // Outlined: on the card's own surface a raised fill alone barely shows (a light theme least of all).
        <path key={p.id} d={p.path} fill="var(--db-surface-raised)" stroke="var(--db-border)" strokeWidth={1} />
      ))}
      {flash && flashed && (
        <motion.path
          key={flash.n}
          d={flashed.path}
          fill={color}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0] }}
          transition={{ duration: reduced ? 0.4 : 0.9, times: [0, 0.15, 1], ease: EASE_OUT }}
        />
      )}
      {focused && <path d={focused.path} fill={color} stroke="var(--db-focus)" strokeWidth={1} />}
    </svg>
  );
}
