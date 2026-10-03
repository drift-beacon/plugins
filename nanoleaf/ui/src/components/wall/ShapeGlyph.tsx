import type { PanelKind } from "../../../../shared/types.ts";

/** Outlines in a 20×20 box: a flat-topped hexagon, a triangle, and a smaller triangle for the minis. */
const PATHS: Record<PanelKind, string> = {
  hexagon: "M5.5 3.5h9L19 10l-4.5 6.5h-9L1 10z",
  triangle: "M10 2.5L18.5 17h-17z",
  "mini-triangle": "M10 7l5 8.5H5z",
};

/** A panel's shape as a small glyph, for list rows. */
export function ShapeGlyph({ kind, className }: { kind: PanelKind; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true" focusable="false">
      <path
        d={PATHS[kind]}
        fill="currentColor"
        fillOpacity={0.18}
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}
