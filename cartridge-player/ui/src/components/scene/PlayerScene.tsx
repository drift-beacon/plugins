import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { memo, type ReactNode, useId } from "react";
import { useShownTag } from "../../hooks/useShownTag.ts";
import { GLOW_S } from "../../motion.ts";
import type { CartridgeLook, PhaseKind } from "../../view/phase.ts";
import { CartridgeArt } from "./CartridgeArt.tsx";
import {
  BASE_TOP,
  CART,
  cartridgeMotion,
  DESK,
  LID_BACK,
  py,
  ref,
  SHELL_TOP,
  SIN,
  SLOT,
  SLOT_LINE,
  sceneIds,
  VIEWBOX,
} from "./geometry.ts";
import { Led, type SetupLight } from "./Led.tsx";

export interface PlayerSceneProps {
  readonly phase: PhaseKind;
  /** The cartridge in the slot (or being read), or null. */
  readonly tag: string | null;
  /** The label of any cartridge the scene draws, including one on its way out. */
  readonly lookOf: (tag: string) => CartridgeLook;
  /** The activity colour the slot glows in while tracking, or null. */
  readonly glow: string | null;
  /** The phone's pinned stage: a tighter crop around the player. */
  readonly compact?: boolean;
  /** The light the setup guide asks for while the slot is empty. */
  readonly setup?: SetupLight | null;
}

/**
 * The player as a physical object: a live replica of the one on the desk. It's decoration for assistive technology
 * (the status panel says the same in words, and a live region announces changes), so it's hidden from it.
 */
export const PlayerScene = memo(function PlayerScene({ phase, tag, lookOf, glow, compact = false, setup = null }: PlayerSceneProps) {
  const ids = sceneIds(useId());
  const reduced = useReducedMotionConfig() ?? false;
  const { shown, onExitComplete } = useShownTag(tag);
  const motionProps = cartridgeMotion(reduced);
  const lid = { x: 60, y: LID_BACK, w: 300, h: SHELL_TOP - LID_BACK + 16 };
  const nfc = { cx: 210, cy: py(100, 110), rx: 40, ry: 40 * SIN };
  const glowFade = { duration: reduced ? 0.2 : GLOW_S, ease: "easeInOut" as const };

  /** A clipped layer whose content moves with the cartridge; the clip stays put, so it acts as the slot's edge. */
  const layer = (clip: string, children: (tag: string) => ReactNode, onDone?: () => void) => (
    <g clipPath={ref(clip)}>
      <AnimatePresence initial={false} onExitComplete={onDone}>
        {shown && (
          <motion.g key={shown} {...motionProps}>
            {children(shown)}
          </motion.g>
        )}
      </AnimatePresence>
    </g>
  );

  return (
    <svg
      viewBox={compact ? VIEWBOX.compact : VIEWBOX.wide}
      className="block h-auto w-full overflow-hidden"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={ids.top} x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0" stopColor="#ece6da" />
          <stop offset="1" stopColor="#d2c8b6" />
        </linearGradient>
        <radialGradient id={ids.sheen} cx="0.3" cy="0.1" r="0.85">
          <stop offset="0" stopColor="#fff" stopOpacity="0.5" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={ids.front} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c8bdaa" />
          <stop offset="1" stopColor="#aa9f89" />
        </linearGradient>
        <linearGradient id={ids.edge} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={ids.slot} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#020202" />
          <stop offset="1" stopColor="#1a1918" />
        </linearGradient>
        <linearGradient id={ids.cartTop} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4a4743" />
          <stop offset="1" stopColor="#5f5b56" />
        </linearGradient>
        <linearGradient id={ids.cartEnd} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6b6761" />
          <stop offset="1" stopColor="#3f3c39" />
        </linearGradient>
        <linearGradient id={ids.lip} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0.7" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={ids.slotGlow} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={ids.slotGlowMask}>
          <rect x={SLOT.x} y={SLOT.top} width={SLOT.w} height={SLOT.bottom - SLOT.top} fill={ref(ids.slotGlow)} />
        </mask>
        <clipPath id={ids.clipSlotPlane}>
          <rect x="0" y={SLOT_LINE} width="420" height="200" />
        </clipPath>
        <clipPath id={ids.clipDesk}>
          <rect x="0" y={DESK} width="420" height="120" />
        </clipPath>
        <clipPath id={ids.clipSlot}>
          <rect x={SLOT.x} y={SLOT.top} width={SLOT.w} height={SLOT.bottom - SLOT.top} rx="9" />
        </clipPath>
        <filter id={ids.blurLg} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
        <filter id={ids.blurMd} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      {/* Contact shadow */}
      <ellipse className="cp-shadow-contact" cx="210" cy={DESK + 2} rx="168" ry="10" fill="#000" filter={ref(ids.blurLg)} />

      {/* The cartridge's shadow on the desk moves with it, and slides under the player's front edge */}
      {layer(ids.clipDesk, () => (
        <rect
          x={CART.x + 8}
          y={DESK - 6}
          width={CART.w - 16}
          height={-CART.front * SIN + 12}
          rx="10"
          fill="#000"
          className="cp-shadow-cart"
          filter={ref(ids.blurMd)}
        />
      ))}
      {/* Light from the slot pools on the desk in front of it, over the cartridge's shadow */}
      <g clipPath={ref(ids.clipDesk)}>
        <AnimatePresence>
          {glow && (
            <motion.ellipse
              key={glow}
              cx="210"
              cy={DESK + 14}
              rx="128"
              ry="22"
              fill={glow}
              filter={ref(ids.blurLg)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.22 }}
              exit={{ opacity: 0 }}
              transition={glowFade}
            />
          )}
        </AnimatePresence>
      </g>

      {/* Lid */}
      <rect x={lid.x} y={lid.y} width={lid.w} height={lid.h} rx="26" ry={26 * SIN} fill={ref(ids.top)} />
      <rect x={lid.x} y={lid.y} width={lid.w} height={lid.h} rx="26" ry={26 * SIN} fill={ref(ids.sheen)} />
      <path d={`M210 ${py(100, 22)} L217 ${py(100, 6)} L203 ${py(100, 6)} Z`} fill="#fff" opacity="0.6" />

      {/* NFC field: rings lie flat on the lid, over the antenna */}
      {phase === "reading" && (
        <g fill="none" stroke="#93c5fd" strokeWidth="1.5">
          <ellipse className="cp-wave" {...nfc} />
          <ellipse className="cp-wave" {...nfc} />
          <ellipse className="cp-wave" {...nfc} />
        </g>
      )}

      {/* Front face, its rounded top edge, and the white base */}
      <path
        d={`M60 ${SHELL_TOP} H360 V${BASE_TOP - 8} Q360 ${BASE_TOP} 350 ${BASE_TOP} H70 Q60 ${BASE_TOP} 60 ${BASE_TOP - 8} Z`}
        fill={ref(ids.front)}
      />
      <rect x="62" y={SHELL_TOP - 1} width="296" height="7" fill={ref(ids.edge)} />
      <rect x="72" y={BASE_TOP - 1} width="276" height={DESK - BASE_TOP + 1} rx="4" fill="#ece8e1" />
      <rect x="72" y={DESK - 3} width="276" height="3" rx="1.5" fill="#000" opacity="0.12" />

      {/* The slot: a dark opening, lit from inside while tracking, with a pale lower lip */}
      <rect x={SLOT.x} y={SLOT.top} width={SLOT.w} height={SLOT.bottom - SLOT.top} rx="9" fill={ref(ids.slot)} />
      <g clipPath={ref(ids.clipSlot)}>
        <AnimatePresence>
          {glow && (
            <motion.rect
              key={glow}
              x={SLOT.x}
              y={SLOT.top}
              width={SLOT.w}
              height={SLOT.bottom - SLOT.top}
              fill={glow}
              mask={ref(ids.slotGlowMask)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.5 }}
              exit={{ opacity: 0 }}
              transition={glowFade}
            />
          )}
        </AnimatePresence>
        <rect x={SLOT.x} y={SLOT.top} width={SLOT.w} height="5" fill="#000" opacity="0.55" />
      </g>
      <path d={`M${SLOT.x + 9} ${SLOT.bottom + 1.5} H${SLOT.x + SLOT.w - 9}`} stroke="#fff" strokeOpacity="0.4" />
      <Screw cx={82} cy={(SLOT.top + SLOT.bottom) / 2} />
      <Screw cx={338} cy={(SLOT.top + SLOT.bottom) / 2} />

      <Led phase={phase} ids={ids} setup={setup} />

      {/* The cartridge, drawn in front of the player and clipped at the slot plane */}
      {layer(ids.clipSlotPlane, (shownTag) => <CartridgeArt look={lookOf(shownTag)} ids={ids} reduced={reduced} />, onExitComplete)}

      {/* The slot's top lip shades the cartridge where it goes in; it follows each cartridge in and out */}
      <AnimatePresence>
        {shown && (
          <motion.rect
            key={shown}
            x={CART.x}
            y={SLOT_LINE}
            width={CART.w}
            height="11"
            fill={ref(ids.lip)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.2, delay: reduced ? 0 : 0.3 } }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
          />
        )}
      </AnimatePresence>
    </svg>
  );
});

function Screw({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r="4.2" fill="#d9d0c0" stroke="#9a8e77" strokeWidth="0.8" />
      <circle cx={cx} cy={cy} r="1.6" fill="#a4977f" />
      <circle cx={cx - 1.3} cy={cy - 1.4} r="0.9" fill="#fff" opacity="0.6" />
    </g>
  );
}
