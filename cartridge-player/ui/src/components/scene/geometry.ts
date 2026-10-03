/*
 * The player in an elevated three-quarter view, like the product photo: orthographic, camera 30° above the desk.
 * A point `h` above the desk and `d` behind the front face (negative: in front of it) lands at py(h, d). Pushing a
 * cartridge deeper therefore moves it *up* the screen, and everything past the slot plane is clipped at SLOT_LINE:
 * the slot swallows the cartridge instead of the lid covering it.
 */
import { EASE_IN_OUT, EASE_OUT, EJECT_S, INSERT_S } from "../../motion.ts";

export const COS = Math.cos(Math.PI / 6);
export const SIN = Math.sin(Math.PI / 6);
export const DESK = 270;
export const py = (h: number, d = 0) => DESK - h * COS - d * SIN;
/** Scale text and icons vertically about a baseline: labels are printed on a face we see at an angle. */
export const squash = (y: number, k = 0.8) => `translate(0 ${(y * (1 - k)).toFixed(2)}) scale(1 ${k})`;

export const LID_BACK = py(100, 220);
export const SHELL_TOP = py(100);
export const BASE_TOP = py(12);
export const SLOT = { x: 104, w: 212, top: py(78), bottom: py(48) };
/** The cartridge: 200 wide, 18 thick (54–72 above the desk, centred in the slot), 240 long; 100 sticks out seated. */
export const CART = { x: 110, w: 200, top: 72, bottom: 54, back: 140, front: -100 };
export const SLOT_LINE = py(CART.top);
/** How far down the screen a cartridge held 230 units further out sits. */
export const OUT = 230 * SIN;
/** The cartridge's label, and the strip of it that shows once seated (everything above SLOT_LINE is in the slot). */
export const LABEL = {
  x: CART.x + 12,
  w: CART.w - 24,
  y0: py(CART.top, CART.back - 10),
  y1: py(CART.top, CART.front + 8),
};
/** Room for the title beside the strip's icon, and without one. */
export const TITLE_X = { icon: LABEL.x + 43, bare: LABEL.x + 12 };
export const TITLE_END = LABEL.x + LABEL.w - 10;
export const LED_AT = { x: 338, y: py(90) };

/** The full scene, and a tighter crop around the player for the phone's pinned stage. */
export const VIEWBOX = { wide: "0 50 420 290", compact: "48 64 324 222" } as const;

/**
 * Insert: pushed along its length (on-screen movement, so ease-in-out), 3 units past the latch, then it settles back.
 * Eject: the latch pops it out a little, then it's drawn away toward the viewer and fades. Reduced motion: it fades
 * in and out where it sits.
 */
export function cartridgeMotion(reduced: boolean) {
  if (reduced) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: { duration: 0.2 } },
      exit: { opacity: 0, transition: { duration: 0.2 } },
    };
  }
  return {
    initial: { transform: `translateY(${OUT}px)`, opacity: 0 },
    animate: {
      transform: [`translateY(${OUT}px)`, "translateY(-3px)", "translateY(0px)"],
      opacity: 1,
      transition: {
        transform: { duration: INSERT_S, times: [0, 0.82, 1], ease: [EASE_IN_OUT, EASE_OUT] },
        opacity: { duration: 0.15, ease: "linear" as const },
      },
    },
    exit: {
      transform: ["translateY(0px)", "translateY(12px)", `translateY(${OUT}px)`],
      opacity: 0,
      transition: {
        transform: { duration: EJECT_S, times: [0, 0.25, 1], ease: [EASE_OUT, EASE_IN_OUT] },
        opacity: { duration: 0.2, delay: 0.35 },
      },
    },
  };
}

/** SVG ids for one scene, from React's `useId` with anything but letters and digits removed. */
export function sceneIds(uid: string) {
  const base = `cp${uid.replace(/[^A-Za-z0-9]/g, "")}`;
  const id = (name: string) => `${base}-${name}`;
  return {
    top: id("top"),
    sheen: id("sheen"),
    front: id("front"),
    edge: id("edge"),
    slot: id("slot"),
    cartTop: id("cart-top"),
    cartEnd: id("cart-end"),
    lip: id("lip"),
    slotGlow: id("slot-glow"),
    slotGlowMask: id("slot-glow-mask"),
    clipSlotPlane: id("clip-slot-plane"),
    clipDesk: id("clip-desk"),
    clipSlot: id("clip-slot"),
    blurLg: id("blur-lg"),
    blurMd: id("blur-md"),
    halo: id("halo"),
  };
}

export type SceneIds = ReturnType<typeof sceneIds>;

/** A url() reference to one of the scene's ids. */
export const ref = (id: string) => `url(#${id})`;
