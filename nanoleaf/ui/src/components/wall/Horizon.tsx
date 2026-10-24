import { cn } from "@heroui/theme";
import { useScene } from "../../hooks/useScene.ts";
import { withAlpha } from "../../lib/color.ts";
import { useModel } from "../../model.ts";
import { onWall } from "../status.ts";

/** How far what shows now rises over the wall's foot, onto the horizon, px. */
export const HORIZON_OVERLAP = 36;

/**
 * The wall's light lying under it on the night sky as a horizon: a wide flat band, a brighter core in a soft haze, in
 * the colour of what shows (fainter while the wall isn't showing it), centred on the bottom edge of what holds it so
 * what sits under the drawing sits on the line. Nothing when nothing is on.
 */
export function Horizon({ className }: { className?: string }) {
  const scene = useScene();
  const showing = onWall(useModel()).showing;
  const color = scene.kind === "off" ? null : scene.cssColor;
  if (!color) return null;
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute -inset-x-6 -bottom-16 h-32 transition-opacity duration-500", className)}
      style={{
        background: [
          `radial-gradient(48% 9% at 50% 50%, ${withAlpha(color, 0.5)}, transparent 100%)`,
          `radial-gradient(60% 50% at 50% 50%, ${withAlpha(color, 0.16)}, transparent 85%)`,
        ].join(", "),
        filter: "blur(6px)",
        opacity: showing ? 1 : 0.35,
      }}
    />
  );
}
