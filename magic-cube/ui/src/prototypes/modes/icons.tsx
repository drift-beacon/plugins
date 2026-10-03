import { AnimatePresence, motion, useAnimate, useReducedMotion } from "motion/react";
import { type CSSProperties, useEffect, useRef } from "react";
import { EASE_IN_OUT, EASE_OUT, SPRING_POP } from "./motion";

export type Verb = "beat" | "lift" | "wiggle" | "sway" | "spin" | "tick" | "nudge" | "seesaw" | "tumble";

// Every frame uses the same transform function list so Motion can interpolate between them.
const tf = (x = 0, y = 0, r = 0, s = 1) => `translate(${x}px, ${y}px) rotate(${r}deg) scale(${s})`;

interface VerbSpec {
  frames: (a: number) => string[];
  duration: number;
  ease: readonly number[];
  origin?: string;
}

/**
 * One gesture per verb, each chosen to suit what the icon depicts. Played once, on a trigger — never looped on
 * config UI. Decays use ease-out; balanced swings use ease-in-out.
 */
const VERBS: Record<Verb, VerbSpec> = {
  beat: { frames: (a) => [tf(), tf(0, 0, 0, 1 + 0.2 * a), tf(0, 0, 0, 1 - 0.05 * a), tf(0, 0, 0, 1 + 0.08 * a), tf()], duration: 0.55, ease: EASE_OUT },
  lift: { frames: (a) => [tf(), tf(0, -4 * a, 0, 1.04), tf(0, 0.8 * a, 0, 0.98), tf()], duration: 0.5, ease: EASE_OUT },
  wiggle: { frames: (a) => [tf(), tf(0, 0, -14 * a), tf(0, 0, 11 * a), tf(0, 0, -6 * a), tf(0, 0, 2 * a), tf()], duration: 0.55, ease: EASE_OUT },
  sway: { frames: (a) => [tf(), tf(0, 0, 11 * a), tf(0, 0, -7 * a), tf(0, 0, 3 * a), tf()], duration: 0.8, ease: EASE_IN_OUT, origin: "50% 0%" },
  spin: { frames: () => [tf(), tf(0, 0, 360)], duration: 0.6, ease: EASE_IN_OUT },
  tick: { frames: (a) => [tf(), tf(0, 0, -6 * a, 0.88), tf(0, 0, 3 * a, 1 + 0.12 * a), tf()], duration: 0.45, ease: EASE_OUT },
  nudge: { frames: (a) => [tf(), tf(3 * a, 0, 0, 1.03), tf(-1.5 * a), tf()], duration: 0.45, ease: EASE_OUT },
  seesaw: { frames: (a) => [tf(), tf(0, 0, -16 * a), tf(0, 0, 12 * a), tf(0, 0, -6 * a), tf()], duration: 0.9, ease: EASE_IN_OUT },
  tumble: { frames: (a) => [tf(), tf(0, -4 * a, 90, 1.06), tf(0, 0, 180)], duration: 0.6, ease: EASE_IN_OUT },
};

interface LiveIconProps {
  path: string;
  color?: string;
  size?: number;
  verb?: Verb;
  /** Change this to play the verb once (select, assign, hover-in). */
  play?: unknown;
  /** Gesture strength: 1 for a deliberate trigger, ~0.45 for hover. */
  amp?: number;
  /** Trace the outline, then fill: the reveal moment. */
  draw?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * An MDI icon with a little life: it plays its verb when `play` changes, pops in when its path changes (an
 * assignment), and can draw itself on for a reveal.
 */
export function LiveIcon({ path, color = "currentColor", size = 24, verb = "nudge", play, amp = 1, draw, className, style }: LiveIconProps) {
  const reduced = useReducedMotion();
  const [scope, animate] = useAnimate<SVGGElement>();
  const mounted = useRef(false);
  const spec = VERBS[verb];

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (reduced || !scope.current) return;
    animate(scope.current, { transform: spec.frames(amp) }, { duration: spec.duration, ease: spec.ease as never });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play]);

  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} style={{ overflow: "visible", ...style }} aria-hidden>
      <g ref={scope} style={{ transformBox: "fill-box", transformOrigin: spec.origin ?? "center" }}>
        <AnimatePresence initial={false}>
          <motion.g
            key={path}
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
            initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "scale(0.7) rotate(-18deg)" }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, transform: "scale(1) rotate(0deg)" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, transform: "scale(0.85) rotate(8deg)", transition: { duration: 0.12, ease: EASE_OUT } }}
            transition={reduced ? { duration: 0.15 } : SPRING_POP}
          >
            {draw && !reduced ? <DrawnPath d={path} color={color} /> : <path d={path} fill={color} />}
          </motion.g>
        </AnimatePresence>
      </g>
    </svg>
  );
}

/** Stroke traces the shape (ease-in-out: it's drawing across the screen), then the fill lands and the stroke fades. */
function DrawnPath({ d, color }: { d: string; color: string }) {
  return (
    <>
      <motion.path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={0.6}
        strokeLinejoin="round"
        initial={{ pathLength: 0, opacity: 1 }}
        animate={{ pathLength: 1, opacity: 0 }}
        transition={{ pathLength: { duration: 0.6, ease: EASE_IN_OUT }, opacity: { delay: 0.6, duration: 0.3, ease: EASE_OUT } }}
      />
      <motion.path
        d={d}
        fill={color}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
        initial={{ opacity: 0, transform: "scale(0.94)" }}
        animate={{ opacity: 1, transform: "scale(1)" }}
        transition={{ delay: 0.38, duration: 0.3, ease: EASE_OUT }}
      />
    </>
  );
}

export type GlyphState = "idle" | "hold" | "shake" | "land" | "done";

/**
 * A small isometric cube that acts out the hardware: floats when picked up, rattles while waiting for a shake,
 * drops and throws out rays when it lands. It loops only while it's asking the user to do something.
 */
export function CubeGlyph({ state, size = 40, color = "currentColor" }: { state: GlyphState; size?: number; color?: string }) {
  const reduced = useReducedMotion();
  const still = reduced || state === "idle" || state === "done";

  const body = still
    ? { transform: "translateY(0px) rotate(0deg)" }
    : state === "hold"
      ? { transform: ["translateY(0px) rotate(0deg)", "translateY(-3px) rotate(-3deg)", "translateY(0px) rotate(0deg)"] }
      : state === "shake"
        ? { transform: ["translateY(-2px) rotate(0deg)", "translateY(-2px) rotate(-11deg)", "translateY(-2px) rotate(9deg)", "translateY(-2px) rotate(-7deg)", "translateY(-2px) rotate(4deg)", "translateY(-2px) rotate(0deg)"] }
        : { transform: ["translateY(-9px) rotate(-8deg)", "translateY(0px) rotate(0deg)"] };
  const bodyTransition = still
    ? { duration: 0.2 }
    : state === "hold"
      ? { duration: 1.6, ease: EASE_IN_OUT, repeat: Infinity }
      : state === "shake"
        ? { duration: 0.5, ease: EASE_IN_OUT, repeat: Infinity, repeatDelay: 0.35 }
        : { type: "spring" as const, duration: 0.5, bounce: 0.3 };

  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden style={{ overflow: "visible", color }}>
      {/* Shadow: shrinks as the cube rises, spreads when it lands. */}
      <motion.ellipse
        cx={24}
        cy={44}
        rx={12}
        ry={2.4}
        fill="currentColor"
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
        initial={false}
        animate={
          still
            ? { opacity: 0.25, transform: "scale(1)" }
            : state === "hold"
              ? { opacity: [0.25, 0.14, 0.25], transform: ["scale(1)", "scale(0.8)", "scale(1)"] }
              : state === "shake"
                ? { opacity: 0.16, transform: "scale(0.85)" }
                : { opacity: [0.1, 0.3], transform: ["scale(0.6)", "scale(1)"] }
        }
        transition={state === "hold" && !still ? { duration: 1.6, ease: EASE_IN_OUT, repeat: Infinity } : { duration: 0.35, ease: EASE_OUT }}
      />
      {/* Keyed by state so each state's keyframes start fresh (the landing plays from the top). */}
      <motion.g style={{ transformBox: "fill-box", transformOrigin: "50% 80%" }} animate={body} transition={bodyTransition} key={state}>
        <path d="M24 8 L38 16 L24 24 L10 16 Z" fill="currentColor" fillOpacity={0.28} />
        <path d="M10 16 L24 24 L24 40 L10 32 Z" fill="currentColor" fillOpacity={0.14} />
        <path d="M24 24 L38 16 L38 32 L24 40 Z" fill="currentColor" fillOpacity={0.07} />
        <path d="M24 8 L38 16 L38 32 L24 40 L10 32 L10 16 Z M10 16 L24 24 L38 16 M24 24 L24 40" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
        <circle cx={24} cy={16} r={1.8} fill="currentColor" />
      </motion.g>
      {/* Shake lines: drawn on and off either side while waiting for the shake. */}
      {state === "shake" && !reduced && (
        <>
          {[
            "M4 14 Q1 22 4 30",
            "M44 14 Q47 22 44 30",
          ].map((d, i) => (
            <motion.path
              key={d}
              d={d}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: [0, 1, 1], opacity: [0, 1, 0] }}
              transition={{ duration: 0.85, ease: EASE_OUT, repeat: Infinity, delay: i * 0.12 }}
            />
          ))}
        </>
      )}
      {/* Landing rays: once. */}
      {state === "land" && !reduced && (
        <>
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
            const rad = (deg * Math.PI) / 180;
            const x1 = 24 + Math.cos(rad) * 20;
            const y1 = 26 + Math.sin(rad) * 20;
            const x2 = 24 + Math.cos(rad) * 26;
            const y2 = 26 + Math.sin(rad) * 26;
            return (
              <motion.line
                key={deg}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                initial={{ pathLength: 0, opacity: 1 }}
                animate={{ pathLength: 1, opacity: 0 }}
                transition={{ delay: 0.22, pathLength: { duration: 0.3, ease: EASE_OUT }, opacity: { delay: 0.4, duration: 0.3 } }}
              />
            );
          })}
        </>
      )}
      {state === "done" && (
        <motion.path
          d="M16 25 L22 31 L33 19"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.28, ease: EASE_OUT }}
          style={{ color: "#fff" }}
        />
      )}
    </svg>
  );
}

/** A number that rolls: up and out when it grows, down and out when it shrinks (spatial consistency). */
export function Odometer({ value, className }: { value: number; className?: string }) {
  const prev = useRef(value);
  const dir = value >= prev.current ? 1 : -1;
  useEffect(() => {
    prev.current = value;
  }, [value]);
  const reduced = useReducedMotion();
  return (
    <span className={`relative inline-grid overflow-hidden tabular-nums ${className ?? ""}`}>
      <AnimatePresence initial={false} mode="popLayout" custom={dir}>
        <motion.span
          key={value}
          custom={dir}
          className="[grid-area:1/1]"
          variants={{
            enter: (d: number) => (reduced ? { opacity: 0 } : { opacity: 0, transform: `translateY(${d * 70}%)` }),
            center: { opacity: 1, transform: "translateY(0%)" },
            exit: (d: number) => (reduced ? { opacity: 0 } : { opacity: 0, transform: `translateY(${-d * 70}%)` }),
          }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.18, ease: EASE_OUT }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
