import { useReducedMotion } from "motion/react";
import { EASE_OUT } from "../motion.ts";

/** The setup and the wall trading places: a short blurred crossfade (opacity only with reduced motion). */
export function useSwapMotion() {
  const reduced = useReducedMotion();
  return {
    initial: reduced ? { opacity: 0 } : { opacity: 0, filter: "blur(4px)", transform: "scale(0.99)" },
    animate: { opacity: 1, filter: "blur(0px)", transform: "scale(1)" },
    exit: reduced
      ? { opacity: 0, transition: { duration: 0.15 } }
      : { opacity: 0, filter: "blur(4px)", transition: { duration: 0.15, ease: EASE_OUT } },
    transition: { duration: 0.3, ease: EASE_OUT },
  };
}
