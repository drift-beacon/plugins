import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { EASE_OUT } from "../../motion.ts";

/**
 * A number that rolls: up and out when it grows, down and out when it shrinks (the magic-cube prototypes' odometer),
 * so "3 of 8" visibly counts as panels are tapped and undone.
 */
export function Odometer({ value, className }: { value: number; className?: string }) {
  const previous = useRef(value);
  const dir = value >= previous.current ? 1 : -1;
  useEffect(() => {
    previous.current = value;
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
