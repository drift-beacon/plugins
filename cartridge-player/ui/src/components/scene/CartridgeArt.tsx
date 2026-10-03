import { AnimatePresence, motion } from "motion/react";
import { useId } from "react";
import { SPRING_POP } from "../../motion.ts";
import { sticker, STICKER_SHADE } from "../../view/color.ts";
import type { CartridgeLook } from "../../view/phase.ts";
import { FALLBACK_ICON } from "../Icon.tsx";
import { FitText } from "./FitText.tsx";
import { CART, LABEL, py, ref, type SceneIds, SIN, SLOT_LINE, squash, TITLE_END, TITLE_X } from "./geometry.ts";

const lookKey = (look: CartridgeLook) => (look.kind === "activity" ? `activity-${look.activity.id}` : look.kind);

/**
 * The cartridge as it sits when seated (the layer's transform moves it): a foreshortened top face with its label, and
 * the grip end facing you. Only what's in front of the slot plane is ever visible. A new label (just labelled,
 * relabelled) lands on it with a small pop, so the change shows where the user is looking.
 */
export function CartridgeArt({ look, ids, reduced }: { look: CartridgeLook; ids: SceneIds; reduced: boolean }) {
  const top = { y0: py(CART.top, CART.back), y1: py(CART.top, CART.front) };
  const end = { y0: top.y1, y1: py(CART.bottom, CART.front) };

  return (
    <g>
      {/* top face */}
      <rect x={CART.x} y={top.y0} width={CART.w} height={top.y1 - top.y0} rx="9" ry={9 * SIN} fill={ref(ids.cartTop)} />

      <AnimatePresence initial={false}>
        <motion.g
          key={lookKey(look)}
          style={{ transformBox: "fill-box", transformOrigin: "50% 80%" }}
          initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "scale(1.06) rotate(-2deg)" }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, transform: "scale(1) rotate(0deg)" }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          transition={reduced ? { duration: 0.2 } : { opacity: { duration: 0.2 }, transform: SPRING_POP }}
        >
          <Label look={look} />
        </motion.g>
      </AnimatePresence>

      {/* the grip end, facing you */}
      <rect x={CART.x} y={end.y0} width={CART.w} height={end.y1 - end.y0} rx="4" fill={ref(ids.cartEnd)} />
      <rect x={CART.x} y={end.y0} width={CART.w} height="1.5" fill="#fff" opacity="0.18" />
      {Array.from({ length: 9 }, (_, i) => (
        <line
          key={i}
          x1={170 + i * 10}
          x2={170 + i * 10}
          y1={end.y0 + 4}
          y2={end.y1 - 3.5}
          stroke="#000"
          strokeOpacity="0.35"
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}

function Label({ look }: { look: CartridgeLook }) {
  const strip = SLOT_LINE; // the visible title strip starts where the cartridge leaves the slot
  const box = { x: LABEL.x, y: LABEL.y0, width: LABEL.w, height: LABEL.y1 - LABEL.y0, rx: 6, ry: 3 };
  const gradient = `cp-sticker${useId().replace(/[^A-Za-z0-9]/g, "")}`;

  if (look.kind === "blank") {
    return (
      <g>
        <rect {...box} fill="#f3f0ea" />
        <rect x={box.x + 5} y={box.y + 4} width={box.width - 10} height={box.height - 8} rx="4" ry="2" fill="none" stroke="#b9b2a4" strokeDasharray="5 4" />
        <g className="cp-wiggle">
          <text x="200" y={strip + 33} textAnchor="middle" fontSize="24" fontWeight="700" fill="#a39b8b" transform={squash(strip + 33)}>
            ?
          </text>
        </g>
        <rect x="258" y={strip + 12} width="30" height="11" rx="5.5" fill="#fbbf24" />
        <text x="273" y={strip + 20.5} textAnchor="middle" fontSize="7.5" fontWeight="700" fill="#422006">
          NEW
        </text>
      </g>
    );
  }
  if (look.kind === "orphan") {
    return (
      <g>
        <rect {...box} fill="#3f3f46" />
        <text x="210" y={strip + 22} textAnchor="middle" fontSize="11" fontWeight="600" fill="#fca5a5" transform={squash(strip + 22)}>
          Activity deleted
        </text>
        <text x="210" y={strip + 35} textAnchor="middle" fontSize="8.5" fill="#a1a1aa" transform={squash(strip + 35)}>
          Relabel this cartridge
        </text>
      </g>
    );
  }

  const { activity } = look;
  // The same sticker as the shelf's: the colour fading toward the shell under a little black, ink chosen on the
  // faded part, which is where the title strip is.
  const { from, to, ink } = sticker(activity.color);
  const icon = activity.iconPath;
  const titleX = icon ? TITLE_X.icon : TITLE_X.bare;
  return (
    <g>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: from }} />
          <stop offset="1" style={{ stopColor: to }} />
        </linearGradient>
      </defs>
      <rect {...box} fill={ref(gradient)} />
      <rect {...box} fill="#000" opacity={STICKER_SHADE} />
      {/* poster art on the part that lives inside the player; you see it as it slides in and out */}
      <g transform={`translate(${210 - 38.4} ${py(CART.top, 118)}) scale(3.2 ${3.2 * SIN})`} fill={ink} opacity="0.2">
        <path d={icon ?? FALLBACK_ICON} />
      </g>
      {/* the title strip where the cartridge sticks out */}
      {icon && (
        <g transform={`translate(${LABEL.x + 12} ${strip + 9}) scale(1.05 0.8)`} fill={ink}>
          <path d={icon} />
        </g>
      )}
      <FitTitle text={activity.name} x={titleX} y={strip + 21} size={13} weight={700} fill={ink} />
      {activity.categoryName && (
        <FitTitle
          text={activity.categoryName.toUpperCase()}
          x={titleX}
          y={strip + 34}
          size={8}
          weight={600}
          fill={ink}
          opacity={0.75}
          spacing="0.1em"
        />
      )}
    </g>
  );
}

function FitTitle(props: {
  text: string;
  x: number;
  y: number;
  size: number;
  weight: number;
  fill: string;
  opacity?: number;
  spacing?: string;
}) {
  return (
    <FitText
      text={props.text}
      width={TITLE_END - props.x}
      x={props.x}
      y={props.y}
      fontSize={props.size}
      fontWeight={props.weight}
      fill={props.fill}
      opacity={props.opacity}
      letterSpacing={props.spacing}
      transform={squash(props.y)}
    />
  );
}
