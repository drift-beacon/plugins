// Motion tokens, shared with the sibling plugins' prototypes. Curves are the strong custom ones; springs keep
// bounce at 0.3 or below.

/** Entrances, exits, anything the system does in response to the user. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
/** Things moving or morphing on screen. */
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;
/** Sheets and drawers. */
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const;

/** Playful arrivals: a number landing on a panel, a paired controller. The personality lives here. */
export const SPRING_POP = { type: "spring", duration: 0.42, bounce: 0.3 } as const;
/** Layout moves: rows reordering, panels reflowing. */
export const SPRING_SETTLE = { type: "spring", duration: 0.45, bounce: 0.15 } as const;
/** Critically damped: no overshoot, for anything functional. */
export const SPRING_SNAP = { type: "spring", duration: 0.3, bounce: 0 } as const;
