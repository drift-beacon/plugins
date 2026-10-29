import { cn } from "@heroui/theme";
import type { TouchGesture } from "../../../../shared/types.ts";

/** Which way each swipe's arrow points: it is drawn pointing right. */
const TURN: Partial<Record<TouchGesture, number>> = {
  "swipe-right": 0,
  "swipe-down": 90,
  "swipe-left": 180,
  "swipe-up": 270,
};

/** A gesture drawn small: a touch as a dot in a ring (two for a double tap), a swipe as an arrow with a fading tail. */
export function GestureGlyph({ gesture, className }: { gesture: TouchGesture; className?: string }) {
  const turn = TURN[gesture];
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("h-5 w-5", className)}>
      {gesture === "tap" && (
        <>
          <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
          <circle cx="12" cy="12" r="3.25" fill="currentColor" />
        </>
      )}
      {gesture === "double-tap" && (
        <>
          <circle cx="8" cy="12" r="5" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
          <circle cx="16" cy="12" r="5" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
          <circle cx="8" cy="12" r="2.25" fill="currentColor" />
          <circle cx="16" cy="12" r="2.25" fill="currentColor" />
        </>
      )}
      {turn !== undefined && (
        <g transform={`rotate(${turn} 12 12)`}>
          <circle cx="3.5" cy="12" r="1.25" fill="currentColor" fillOpacity="0.3" />
          <circle cx="7" cy="12" r="1.5" fill="currentColor" fillOpacity="0.55" />
          <path
            d="M10.5 12h9m-3.5-4 4 4-4 4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      )}
    </svg>
  );
}
