import type { PhaseKind } from "../../view/phase.ts";
import { LED_AT, ref, type SceneIds } from "./geometry.ts";

/**
 * The status LED's colour and loop per phase. Loops mean something is happening or waiting: it blinks fast while
 * reading and breathes while tracking; a cartridge that needs attention blinks a few times and then holds steady,
 * because it may sit there for hours. deck.css stops them all under reduced motion.
 */
const LED: Record<PhaseKind, { readonly color: string; readonly loop: string | null }> = {
  empty: { color: "#71717a", loop: null },
  reading: { color: "#60a5fa", loop: "cp-blink" },
  playing: { color: "#4ade80", loop: "cp-breathe" },
  marked: { color: "#4ade80", loop: null },
  unknown: { color: "#fbbf24", loop: "cp-blink-few" },
  ready: { color: "#fbbf24", loop: null },
  parked: { color: "#fbbf24", loop: null },
  orphan: { color: "#f87171", loop: "cp-blink-few" },
  archived: { color: "#f87171", loop: "cp-blink-few" },
  error: { color: "#f87171", loop: "cp-blink-few" },
};

/**
 * What the real player's light shows while there is no cartridge to speak of: breathing blue while it waits to be set
 * up, steady green once it has reported. The setup guide asks for these; a cartridge's phase always wins.
 */
export type SetupLight = "waiting" | "online";

const SETUP: Record<SetupLight, { readonly color: string; readonly loop: string | null }> = {
  waiting: { color: "#60a5fa", loop: "cp-breathe" },
  online: { color: "#4ade80", loop: null },
};

/** The LED on the front face above the right screw: a soft halo (a gradient, not a blur filter) and the dot. */
export function Led({ phase, ids, setup = null }: { phase: PhaseKind; ids: SceneIds; setup?: SetupLight | null }) {
  const lit = phase === "empty" && setup !== null;
  const led = lit ? SETUP[setup] : LED[phase];
  return (
    <g className={led.loop ?? undefined}>
      <defs>
        <radialGradient id={ids.halo}>
          <stop offset="0" stopColor={led.color} stopOpacity="0.9" />
          <stop offset="1" stopColor={led.color} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={LED_AT.x} cy={LED_AT.y} r="11" fill={ref(ids.halo)} opacity={phase === "empty" && !lit ? 0 : 0.45} className="cp-led-halo" />
      <circle cx={LED_AT.x} cy={LED_AT.y} r="2.6" fill={led.color} className="cp-led-dot" />
    </g>
  );
}
