// Motion tokens, shared with the sibling plugins (magic-cube, nanoleaf). Curves are the strong custom ones; springs keep
// bounce at 0.3 or below. CSS uses the same curves as --cp-ease-* (deck.css), namespaced so Tailwind's own --ease-*
// tokens stay as they are.

/** Entrances, exits, anything the system does in response to the user. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
/** Things moving or morphing on screen. */
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;
/** Sheets and drawers. */
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const;

/** Playful arrivals: a sticker landing on a cartridge. The personality lives here. */
export const SPRING_POP = { type: "spring", duration: 0.42, bounce: 0.3 } as const;
/** Layout moves: cartridges reordering on the shelf. */
export const SPRING_SETTLE = { type: "spring", duration: 0.45, bounce: 0.15 } as const;
/** Critically damped: no overshoot, for anything functional. */
export const SPRING_SNAP = { type: "spring", duration: 0.3, bounce: 0 } as const;

/** The cartridge going in: pushed along its length, 3 units past the latch, then settling back. */
export const INSERT_S = 0.6;
/** The cartridge coming out: the latch pops it, then it's drawn away. A swap waits for this before the next goes in. */
export const EJECT_S = 0.55;
/** The slot's glow and the light it casts on the desk, while tracking. */
export const GLOW_S = 0.6;
/** One body of the status panel giving way to the next. */
export const SWAP_S = 0.2;
