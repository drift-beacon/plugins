import { Button, Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { cn } from "@heroui/theme";
import { Check, CircleHelp, Play, Settings2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { activityById, categoryById } from "./fixtures";
import {
  lastHeard,
  library,
  type LibraryItem,
  type Phase,
  type Player,
  type PlayerState,
  type SortKey,
  unlabelledActivities,
  usePlayer,
} from "./model";
import {
  ActivityPicker,
  ago,
  clock,
  CopyButton,
  EASE_IN_OUT,
  EASE_OUT,
  hours,
  Icon,
  SETUP_STEPS,
  SuggestionChips,
  timeOfDay,
  useNow,
  pluginPath,
} from "./shared";
import "./player.css";

/** Direction 1 — Deck: the player itself is the interface. A live replica on top, a shelf of cartridges below. */
export function Deck() {
  const player = usePlayer();
  const [sort, setSort] = useState<SortKey>("recent");
  const items = library(player.state, sort);

  return (
    <div className="space-y-8">
      <section
        className="relative overflow-hidden rounded-3xl border border-white/5 bg-[#121214]"
        style={{ backgroundImage: "radial-gradient(ellipse 70% 90% at 28% 0%, rgb(255 236 210 / 0.07), transparent 70%)" }}
      >
        <div className="grid items-center md:grid-cols-[1.1fr_1fr]">
          <PlayerScene state={player.state} />
          <StatusPanel player={player} />
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Your cartridges</h2>
            <p className="text-sm text-default-500">
              {items.length} labelled · insert a blank one to add it here
            </p>
          </div>
          <SortTabs value={sort} onChange={setSort} />
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {items.map((item, i) => (
            <motion.div
              key={item.tag}
              layout="position"
              initial={{ opacity: 0, transform: "translateY(8px)" }}
              animate={{ opacity: 1, transform: "translateY(0px)" }}
              transition={{ duration: 0.3, ease: EASE_OUT, delay: Math.min(i, 8) * 0.04 }}
            >
              <ShelfCartridge item={item} player={player} />
            </motion.div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SortTabs({ value, onChange }: { value: SortKey; onChange: (k: SortKey) => void }) {
  const options: [SortKey, string][] = [
    ["recent", "Recent"],
    ["played", "Most played"],
    ["name", "A–Z"],
  ];
  return (
    <div className="flex rounded-full bg-content1 p-1 text-xs" role="tablist" aria-label="Sort cartridges">
      {options.map(([key, label]) => (
        <button
          key={key}
          role="tab"
          aria-selected={value === key}
          onClick={() => onChange(key)}
          className={cn(
            "cp-press rounded-full px-3 py-1.5 transition-colors duration-150",
            value === key ? "bg-default-200 text-foreground" : "text-default-500 hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The player                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

const LED: Record<Phase, { color: string; className: string }> = {
  empty: { color: "#71717a", className: "" },
  reading: { color: "#60a5fa", className: "cp-blink" },
  playing: { color: "#4ade80", className: "cp-breathe" },
  unknown: { color: "#fbbf24", className: "cp-blink-slow" },
  orphan: { color: "#f87171", className: "cp-blink-slow" },
  ready: { color: "#fbbf24", className: "" },
  parked: { color: "#fbbf24", className: "" },
};

/*
 * The player in an elevated three-quarter view, like the product photo: orthographic, camera 30° above the desk.
 * A point `h` above the desk and `d` behind the front face (negative: in front of it) lands at py(h, d). Pushing a
 * cartridge deeper therefore moves it *up* the screen, and everything past the slot plane is clipped at SLOT_LINE:
 * the slot swallows the cartridge instead of the lid covering it.
 */
const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);
const DESK = 270;
const py = (h: number, d = 0) => DESK - h * COS - d * SIN;
/** Scale text/icons vertically about a baseline: labels are printed on a face we see at an angle. */
const squash = (y: number, k = 0.8) => `translate(0 ${(y * (1 - k)).toFixed(2)}) scale(1 ${k})`;

const LID_BACK = py(100, 220);
const SHELL_TOP = py(100);
const BASE_TOP = py(12);
const SLOT = { x: 104, w: 212, top: py(78), bottom: py(48) };
// The cartridge: 200 wide, 18 thick (54–72 above the desk, centred in the slot), 240 long; 100 sticks out when seated.
const CART = { x: 110, w: 200, top: 72, bottom: 54, back: 140, front: -100 };
const SLOT_LINE = py(CART.top);
const OUT = 230 * SIN; // how far down the screen a cartridge held 230 units further out sits

// Insert: pushed along its length (on-screen movement → ease-in-out), 3px past the latch, then it settles back.
// Eject: the latch pops it out a little, then it's drawn away toward the viewer and fades.
const cartridgeMotion = {
  initial: { transform: `translateY(${OUT}px)`, opacity: 0 },
  animate: {
    transform: [`translateY(${OUT}px)`, "translateY(-3px)", "translateY(0px)"],
    opacity: 1,
    transition: {
      transform: { duration: 0.6, times: [0, 0.82, 1], ease: [EASE_IN_OUT, EASE_OUT] },
      opacity: { duration: 0.15, ease: "linear" as const },
    },
  },
  exit: {
    transform: ["translateY(0px)", "translateY(12px)", `translateY(${OUT}px)`],
    opacity: 0,
    transition: {
      transform: { duration: 0.55, times: [0, 0.25, 1], ease: [EASE_OUT, EASE_IN_OUT] },
      opacity: { duration: 0.2, delay: 0.35 },
    },
  },
};

/** A clipped layer whose content moves with the cartridge; the clip stays put, so it acts like the slot's edge. */
function CartridgeLayer({ clip, tag, children }: { clip: string; tag: string | null; children: React.ReactNode }) {
  return (
    <g clipPath={`url(#${clip})`}>
      <AnimatePresence initial={false}>
        {tag && (
          <motion.g key={tag} {...cartridgeMotion}>
            {children}
          </motion.g>
        )}
      </AnimatePresence>
    </g>
  );
}

function Screw({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r="4.2" fill="#d9d0c0" stroke="#9a8e77" strokeWidth="0.8" />
      <circle cx={cx} cy={cy} r="1.6" fill="#a4977f" />
      <circle cx={cx - 1.3} cy={cy - 1.4} r="0.9" fill="#fff" opacity="0.6" />
    </g>
  );
}

function PlayerScene({ state }: { state: PlayerState }) {
  const tag = state.slot?.tag ?? null;
  const activity = tag ? activityById(state.mappings[tag]) : null;
  const led = LED[state.phase];
  const glow = state.phase === "playing" && activity ? activity.color : null;
  const lid = { x: 60, y: LID_BACK, w: 300, h: SHELL_TOP - LID_BACK + 16 };
  const nfc = { cx: 210, cy: py(100, 110), rx: 40, ry: 40 * SIN };

  return (
    <div className="relative px-4 pt-6 md:pt-2">
      <svg viewBox="0 50 420 290" className="mx-auto block w-full max-w-[520px] overflow-hidden" role="img" aria-label="Cartridge player">
        <defs>
          <linearGradient id="dk-top" x1="0" y1="0" x2="0.6" y2="1">
            <stop offset="0" stopColor="#ece6da" />
            <stop offset="1" stopColor="#d2c8b6" />
          </linearGradient>
          <radialGradient id="dk-sheen" cx="0.3" cy="0.1" r="0.85">
            <stop offset="0" stopColor="#fff" stopOpacity="0.5" />
            <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="dk-front" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#c8bdaa" />
            <stop offset="1" stopColor="#aa9f89" />
          </linearGradient>
          <linearGradient id="dk-edge" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="dk-slot" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#020202" />
            <stop offset="1" stopColor="#1a1918" />
          </linearGradient>
          <linearGradient id="dk-cart-top" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4a4743" />
            <stop offset="1" stopColor="#5f5b56" />
          </linearGradient>
          <linearGradient id="dk-cart-end" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#6b6761" />
            <stop offset="1" stopColor="#3f3c39" />
          </linearGradient>
          <linearGradient id="dk-lip" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#000" stopOpacity="0.7" />
            <stop offset="1" stopColor="#000" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="dk-slot-glow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="dk-slot-glow-mask">
            <rect x={SLOT.x} y={SLOT.top} width={SLOT.w} height={SLOT.bottom - SLOT.top} fill="url(#dk-slot-glow)" />
          </mask>
          <clipPath id="dk-clip-slot-plane">
            <rect x="0" y={SLOT_LINE} width="420" height="200" />
          </clipPath>
          <clipPath id="dk-clip-desk">
            <rect x="0" y={DESK} width="420" height="120" />
          </clipPath>
          <clipPath id="dk-clip-slot">
            <rect x={SLOT.x} y={SLOT.top} width={SLOT.w} height={SLOT.bottom - SLOT.top} rx="9" />
          </clipPath>
          <filter id="dk-blur-lg" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="10" />
          </filter>
          <filter id="dk-blur-md" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
          <filter id="dk-blur-sm" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>

        {/* Contact shadow */}
        <ellipse cx="210" cy={DESK + 2} rx="168" ry="10" fill="#000" opacity="0.6" filter="url(#dk-blur-lg)" />

        {/* The cartridge's shadow on the desk moves with it, and slides under the player's front edge */}
        <CartridgeLayer clip="dk-clip-desk" tag={tag}>
          <rect x={CART.x + 8} y={DESK - 6} width={CART.w - 16} height={-CART.front * SIN + 12} rx="10" fill="#000" opacity="0.5" filter="url(#dk-blur-md)" />
        </CartridgeLayer>
        {/* Light from the slot pools on the desk in front of it, over the cartridge's shadow */}
        <g clipPath="url(#dk-clip-desk)">
          <AnimatePresence>
            {glow && (
              <motion.ellipse
                key={glow}
                cx="210"
                cy={DESK + 14}
                rx="128"
                ry="22"
                fill={glow}
                filter="url(#dk-blur-lg)"
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.22 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.6, ease: "easeInOut" }}
              />
            )}
          </AnimatePresence>
        </g>

        {/* Lid */}
        <rect x={lid.x} y={lid.y} width={lid.w} height={lid.h} rx="26" ry={26 * SIN} fill="url(#dk-top)" />
        <rect x={lid.x} y={lid.y} width={lid.w} height={lid.h} rx="26" ry={26 * SIN} fill="url(#dk-sheen)" />
        <path d={`M210 ${py(100, 22)} L217 ${py(100, 6)} L203 ${py(100, 6)} Z`} fill="#fff" opacity="0.6" />

        {/* NFC field: rings lie flat on the lid, over the antenna */}
        {state.phase === "reading" && (
          <g fill="none" stroke="#93c5fd" strokeWidth="1.5">
            <ellipse className="cp-wave" {...nfc} />
            <ellipse className="cp-wave" {...nfc} />
            <ellipse className="cp-wave" {...nfc} />
          </g>
        )}

        {/* Front face, its rounded top edge, and the white base */}
        <path
          d={`M60 ${SHELL_TOP} H360 V${BASE_TOP - 8} Q360 ${BASE_TOP} 350 ${BASE_TOP} H70 Q60 ${BASE_TOP} 60 ${BASE_TOP - 8} Z`}
          fill="url(#dk-front)"
        />
        <rect x="62" y={SHELL_TOP - 1} width="296" height="7" fill="url(#dk-edge)" />
        <rect x="72" y={BASE_TOP - 1} width="276" height={DESK - BASE_TOP + 1} rx="4" fill="#ece8e1" />
        <rect x="72" y={DESK - 3} width="276" height="3" rx="1.5" fill="#000" opacity="0.12" />

        {/* The slot: a dark opening, lit from inside while tracking, with a pale lower lip */}
        <rect x={SLOT.x} y={SLOT.top} width={SLOT.w} height={SLOT.bottom - SLOT.top} rx="9" fill="url(#dk-slot)" />
        <g clipPath="url(#dk-clip-slot)">
          <AnimatePresence>
            {glow && (
              <motion.rect
                key={glow}
                x={SLOT.x}
                y={SLOT.top}
                width={SLOT.w}
                height={SLOT.bottom - SLOT.top}
                fill={glow}
                mask="url(#dk-slot-glow-mask)"
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.5 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.6, ease: "easeInOut" }}
              />
            )}
          </AnimatePresence>
          <rect x={SLOT.x} y={SLOT.top} width={SLOT.w} height="5" fill="#000" opacity="0.55" />
        </g>
        <path d={`M${SLOT.x + 9} ${SLOT.bottom + 1.5} H${SLOT.x + SLOT.w - 9}`} stroke="#fff" strokeOpacity="0.4" />
        <Screw cx={82} cy={(SLOT.top + SLOT.bottom) / 2} />
        <Screw cx={338} cy={(SLOT.top + SLOT.bottom) / 2} />

        {/* Status LED, on the front face above the right screw */}
        <circle cx="338" cy={py(90)} r="8" fill={led.color} opacity={state.phase === "empty" ? 0 : 0.4} filter="url(#dk-blur-sm)" className={led.className} />
        <circle cx="338" cy={py(90)} r="2.6" fill={led.color} className={led.className} style={{ transition: "fill 200ms ease" }} />

        {/* The cartridge, drawn in front of the player and clipped at the slot plane */}
        <CartridgeLayer clip="dk-clip-slot-plane" tag={tag}>
          <CartridgeArt tag={tag ?? ""} state={state} />
        </CartridgeLayer>

        {/* The slot's top lip shades the cartridge where it goes in */}
        <AnimatePresence>
          {tag && (
            <motion.rect
              key="lip"
              x={CART.x}
              y={SLOT_LINE}
              width={CART.w}
              height="11"
              fill="url(#dk-lip)"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.2, delay: 0.3 } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
            />
          )}
        </AnimatePresence>
      </svg>
    </div>
  );
}

/**
 * The cartridge as it sits when seated (the layer's transform moves it): a foreshortened top face with its label, and
 * the grip end facing you. Only what's in front of the slot plane is ever visible.
 */
function CartridgeArt({ tag, state }: { tag: string; state: PlayerState }) {
  const activityId = state.mappings[tag];
  const activity = activityById(activityId);
  const category = categoryById(activity?.categoryId);
  const blank = !activityId;
  const orphan = !!activityId && !activity;
  const name = activity ? (activity.name.length > 19 ? `${activity.name.slice(0, 18)}…` : activity.name) : "";

  const top = { y0: py(CART.top, CART.back), y1: py(CART.top, CART.front) };
  const label = { x: CART.x + 12, w: CART.w - 24, y0: py(CART.top, CART.back - 10), y1: py(CART.top, CART.front + 8) };
  const strip = SLOT_LINE; // the visible title strip starts where the cartridge leaves the slot
  const end = { y0: top.y1, y1: py(CART.bottom, CART.front) };

  return (
    <g>
      {/* top face */}
      <rect x={CART.x} y={top.y0} width={CART.w} height={top.y1 - top.y0} rx="9" ry={9 * SIN} fill="url(#dk-cart-top)" />

      {blank ? (
        <g>
          <rect x={label.x} y={label.y0} width={label.w} height={label.y1 - label.y0} rx="6" ry="3" fill="#f3f0ea" />
          <rect x={label.x + 5} y={label.y0 + 4} width={label.w - 10} height={label.y1 - label.y0 - 8} rx="4" ry="2" fill="none" stroke="#b9b2a4" strokeDasharray="5 4" />
          <g className="cp-wiggle" style={{ transformOrigin: "50% 50%" }}>
            <text x="200" y={strip + 33} textAnchor="middle" fontSize="24" fontWeight="700" fill="#a39b8b" transform={squash(strip + 33)}>
              ?
            </text>
          </g>
          <rect x="258" y={strip + 12} width="30" height="11" rx="5.5" fill="#fbbf24" />
          <text x="273" y={strip + 20.5} textAnchor="middle" fontSize="7.5" fontWeight="700" fill="#422006">
            NEW
          </text>
        </g>
      ) : orphan ? (
        <g>
          <rect x={label.x} y={label.y0} width={label.w} height={label.y1 - label.y0} rx="6" ry="3" fill="#3f3f46" />
          <text x="210" y={strip + 22} textAnchor="middle" fontSize="11" fontWeight="600" fill="#fca5a5" transform={squash(strip + 22)}>
            Activity deleted
          </text>
          <text x="210" y={strip + 35} textAnchor="middle" fontSize="8.5" fill="#a1a1aa" transform={squash(strip + 35)}>
            Relabel this cartridge
          </text>
        </g>
      ) : (
        activity && (
          <g>
            <defs>
              <linearGradient id={`dk-sticker-${tag}`} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor={activity.color} />
                <stop offset="1" stopColor={activity.color} stopOpacity="0.6" />
              </linearGradient>
            </defs>
            <rect x={label.x} y={label.y0} width={label.w} height={label.y1 - label.y0} rx="6" ry="3" fill={`url(#dk-sticker-${tag})`} />
            <rect x={label.x} y={label.y0} width={label.w} height={label.y1 - label.y0} rx="6" ry="3" fill="#000" opacity="0.16" />
            {/* poster art on the part that lives inside the player; you see it as it slides in and out */}
            <g transform={`translate(${210 - 38.4} ${py(CART.top, 118)}) scale(3.2 ${3.2 * SIN})`} fill="#fff" opacity="0.2">
              <path d={activity.iconPath} />
            </g>
            {/* the title strip where the cartridge sticks out */}
            <g transform={`translate(${label.x + 12} ${strip + 9}) scale(1.05 0.8)`} fill="#fff">
              <path d={activity.iconPath} />
            </g>
            <text x={label.x + 43} y={strip + 21} fontSize="13" fontWeight="700" fill="#fff" transform={squash(strip + 21)}>
              {name}
            </text>
            <text x={label.x + 43} y={strip + 34} fontSize="8" fontWeight="600" fill="#fff" opacity="0.75" letterSpacing="0.1em" transform={squash(strip + 34)}>
              {category?.name.toUpperCase()}
            </text>
          </g>
        )
      )}

      {/* the grip end, facing you */}
      <rect x={CART.x} y={end.y0} width={CART.w} height={end.y1 - end.y0} rx="4" fill="url(#dk-cart-end)" />
      <rect x={CART.x} y={end.y0} width={CART.w} height="1.5" fill="#fff" opacity="0.18" />
      {Array.from({ length: 9 }, (_, i) => (
        <line key={i} x1={170 + i * 10} x2={170 + i * 10} y1={end.y0 + 4} y2={end.y1 - 3.5} stroke="#000" strokeOpacity="0.35" strokeLinecap="round" />
      ))}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Status                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

function StatusPanel({ player }: { player: Player }) {
  const { state } = player;
  const heard = lastHeard(state);
  useNow(1000, state.phase === "playing");

  return (
    <div className="flex min-h-[300px] flex-col gap-5 p-6 md:py-8 md:pl-2 md:pr-8">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="flex items-center gap-2 text-default-500">
          <span className={cn("h-1.5 w-1.5 rounded-full", heard && Date.now() - heard < 36e5 * 24 ? "bg-success" : "bg-default-400")} />
          Player active · {ago(heard)}
        </span>
        <SetupPopover />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${state.phase}-${state.slot?.tag ?? ""}`}
          initial={{ opacity: 0, transform: "translateY(6px)", filter: "blur(2px)" }}
          animate={{ opacity: 1, transform: "translateY(0px)", filter: "blur(0px)" }}
          exit={{ opacity: 0, transform: "translateY(-4px)", filter: "blur(2px)" }}
          transition={{ duration: 0.2, ease: EASE_OUT }}
          className="flex flex-1 flex-col justify-center"
        >
          <PhaseBody player={player} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function PhaseBody({ player }: { player: Player }) {
  const { state } = player;
  const tag = state.slot?.tag;
  const activity = tag ? activityById(state.mappings[tag]) : null;

  switch (state.phase) {
    case "reading":
      return (
        <div className="space-y-2">
          <Eyebrow>Reading cartridge</Eyebrow>
          <p className="font-mono text-sm text-default-400">{tag}</p>
        </div>
      );
    case "playing": {
      const session = state.session!;
      const category = categoryById(activity?.categoryId);
      return (
        <div>
          <Eyebrow>
            <span className="cp-breathe h-1.5 w-1.5 rounded-full bg-success" /> Tracking
          </Eyebrow>
          <h2 className="mt-2 line-clamp-2 text-3xl font-semibold leading-tight">{activity?.name}</h2>
          <p className="mt-1 text-sm text-default-500">
            {category?.name} · started {timeOfDay(session.startedAt)}
          </p>
          <div
            className="mt-5 font-mono text-5xl tabular-nums tracking-tight text-[#ffb45c]"
            style={{ textShadow: "0 0 18px rgb(255 160 60 / 0.45)" }}
          >
            {clock(Date.now() - session.startedAt)}
          </div>
          <p className="mt-4 text-xs text-default-400">Pull the cartridge out to stop.</p>
        </div>
      );
    }
    case "unknown":
      return <LabelPrompt player={player} />;
    case "orphan":
      return (
        <div className="space-y-3">
          <Eyebrow tone="danger">Activity missing</Eyebrow>
          <h2 className="text-2xl font-semibold leading-tight">This cartridge's activity was deleted</h2>
          <p className="text-sm text-default-500">Nothing is tracking. Give it a new label and it's ready.</p>
          <ActivityPicker autoFocus placeholder="Relabel as…" onChange={(id) => id && tag && player.relabel(tag, id)} />
        </div>
      );
    case "ready":
      return (
        <div className="space-y-4">
          <Eyebrow tone="success">
            <Check className="h-3.5 w-3.5" /> Labelled
          </Eyebrow>
          <h2 className="text-3xl font-semibold leading-tight">{activity?.name}</h2>
          <p className="text-sm text-default-500">It's still in the player. Start tracking now, or it'll start next time it goes in.</p>
          <div className="flex gap-2">
            <Button color="primary" radius="full" startContent={<Play className="h-4 w-4" />} onPress={player.start}>
              Start tracking
            </Button>
            <Button variant="flat" radius="full" onPress={player.park}>
              Later
            </Button>
          </div>
        </div>
      );
    case "parked":
      return (
        <div className="space-y-4">
          <Eyebrow>In the player</Eyebrow>
          <h2 className="text-3xl font-semibold leading-tight">{activity?.name}</h2>
          <p className="text-sm text-default-500">Not tracking. It starts by itself the next time you insert it.</p>
          <Button className="w-fit" variant="flat" radius="full" startContent={<Play className="h-4 w-4" />} onPress={player.start}>
            Start tracking
          </Button>
        </div>
      );
    case "empty": {
      const done = state.lastEject && Date.now() - state.lastEject.at < 90_000 ? state.lastEject : null;
      const doneActivity = activityById(done?.activityId);
      return done && doneActivity ? (
        <div className="space-y-2">
          <Eyebrow tone="success">
            <Check className="h-3.5 w-3.5" /> Saved
          </Eyebrow>
          <h2 className="text-3xl font-semibold leading-tight">{hours(done.minutes)} of {doneActivity.name}</h2>
          <p className="text-sm text-default-500">The slot's empty. Slide another cartridge in whenever you're ready.</p>
        </div>
      ) : (
        <div className="space-y-2">
          <Eyebrow>Slot empty</Eyebrow>
          <h2 className="text-3xl font-semibold leading-tight">Pick a cartridge</h2>
          <p className="text-sm text-default-500">Slide it in to start tracking. Pull it out to stop.</p>
        </div>
      );
    }
  }
}

function LabelPrompt({ player }: { player: Player }) {
  const tag = player.state.slot!.tag;
  const suggestions = unlabelledActivities(player.state);
  return (
    <div className="space-y-3">
      <Eyebrow tone="warning">
        <CircleHelp className="h-3.5 w-3.5" /> New cartridge
      </Eyebrow>
      <h2 className="text-2xl font-semibold leading-tight">What's on this one?</h2>
      <p className="text-sm text-default-500">
        Leave it in the player while you label it. <span className="font-mono text-xs text-default-400">{tag}</span>
      </p>
      {suggestions.length > 0 && <SuggestionChips activities={suggestions} onPick={(id) => player.label(tag, id)} />}
      <ActivityPicker autoFocus placeholder="Or search every activity" onChange={(id) => id && player.label(tag, id)} />
    </div>
  );
}

function Eyebrow({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "success" | "warning" | "danger" }) {
  return (
    <span
      className={cn(
        "flex w-fit items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em]",
        tone === "success" && "text-success",
        tone === "warning" && "text-warning",
        tone === "danger" && "text-danger",
        tone === "default" && "text-default-500",
      )}
    >
      {children}
    </span>
  );
}

function SetupPopover() {
  return (
    <Popover placement="bottom-end" offset={10}>
      <PopoverTrigger>
        <button className="cp-press flex items-center gap-1.5 rounded-full px-2.5 py-1 text-default-500 hover:bg-default-100 hover:text-foreground">
          <Settings2 className="h-3.5 w-3.5" /> Setup
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4">
        <div className="w-full space-y-4">
          <div>
            <div className="font-medium">Connect a player</div>
            <p className="text-xs text-default-500">Three fields in the player's setup page.</p>
          </div>
          <ol className="space-y-3">
            {SETUP_STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-3">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-default-100 text-[11px] font-semibold">{i + 1}</span>
                <div>
                  <div className="text-sm">{step.title}</div>
                  <div className="text-xs text-default-500">{step.body}</div>
                </div>
              </li>
            ))}
          </ol>
          <div className="flex items-center gap-1 rounded-lg bg-default-100 py-1 pl-3 pr-1">
            <code className="flex-1 truncate text-xs">{pluginPath}</code>
            <CopyButton text={pluginPath} />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The shelf                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

function ShelfCartridge({ item, player }: { item: LibraryItem; player: Player }) {
  const fresh = player.state.fresh === item.tag;
  const [confirm, setConfirm] = useState(false);
  const { activity } = item;

  return (
    <Popover placement="bottom" offset={8} onOpenChange={(open) => !open && setConfirm(false)}>
      <PopoverTrigger>
        <button className="cp-lift cp-press group block w-full text-left" aria-label={activity?.name ?? "Cartridge with a deleted activity"}>
          <div
            className={cn(
              "relative rounded-2xl p-2.5 pt-3 transition-opacity duration-300",
              item.inSlot && "outline outline-1 outline-dashed outline-default-300",
            )}
            style={{
              background: item.inSlot ? "transparent" : "linear-gradient(180deg, #5f5b55, #45423e)",
              boxShadow: item.inSlot ? undefined : "inset 0 1px 0 rgb(255 255 255 / 0.12), 0 14px 24px -16px rgb(0 0 0 / 0.9)",
            }}
          >
            <div className="mx-auto mb-2.5 flex w-9 justify-between" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span key={i} className={cn("h-1 w-2.5 rounded-full", item.inSlot ? "bg-default-200" : "bg-black/30")} />
              ))}
            </div>
            <motion.div
              key={`${item.tag}-${activity?.id ?? "x"}`}
              initial={fresh ? { opacity: 0, transform: "scale(1.08) rotate(-5deg)" } : false}
              animate={{ opacity: item.inSlot ? 0.35 : 1, transform: "scale(1) rotate(0deg)" }}
              transition={fresh ? { type: "spring", duration: 0.55, bounce: 0.3 } : { duration: 0.3, ease: EASE_OUT }}
              className="relative aspect-[4/5] overflow-hidden rounded-xl"
              style={{
                background: activity
                  ? `linear-gradient(145deg, ${activity.color}, ${activity.color}88)`
                  : "repeating-linear-gradient(135deg, #3f3f46 0 8px, #36363c 8px 16px)",
              }}
            >
              <div className="absolute inset-0 bg-black/20" />
              {activity ? (
                <>
                  <span className="absolute left-2.5 top-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/75">
                    {categoryById(activity.categoryId)?.name}
                  </span>
                  <Icon
                    path={activity.iconPath}
                    className={cn("absolute left-1/2 top-[44%] h-9 w-9 -translate-x-1/2 -translate-y-1/2 text-white drop-shadow")}
                  />
                  <span className="absolute inset-x-2.5 bottom-2 line-clamp-2 text-sm font-semibold leading-tight text-white">
                    {activity.name}
                  </span>
                </>
              ) : (
                <div className="absolute inset-0 grid place-items-center p-3 text-center">
                  <div>
                    <div className="text-sm font-semibold text-danger-300">Activity deleted</div>
                    <div className="text-xs text-default-400">Click to relabel</div>
                  </div>
                </div>
              )}
              {fresh && <span className="cp-shine" />}
            </motion.div>
            {item.inSlot && (
              <span className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
                <span className="flex items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-xs font-medium">
                  {item.live && <span className="cp-breathe h-1.5 w-1.5 rounded-full bg-success" />}
                  In the player
                </span>
              </span>
            )}
          </div>
          <div className="mt-2 flex justify-between px-1 text-xs text-default-500">
            <span>{item.lastSeen == null ? "Never played" : ago(item.lastSeen)}</span>
            {item.minutes > 0 && <span className="tabular-nums">{hours(item.minutes)}</span>}
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3">
        <div className="w-full space-y-3">
          <div>
            <div className="line-clamp-2 font-medium">{activity?.name ?? "Deleted activity"}</div>
            <div className="font-mono text-[11px] text-default-400">{item.tag}</div>
          </div>
          <div className="grid grid-cols-3 gap-2 rounded-lg bg-default-100 p-2 text-center">
            <Stat label="Plays" value={String(item.plays)} />
            <Stat label="Tracked" value={hours(item.minutes)} />
            <Stat label="Last" value={item.lastSeen == null ? "—" : ago(item.lastSeen).replace(" ago", "")} />
          </div>
          <ActivityPicker
            size="sm"
            label="Label"
            value={activity?.id ?? null}
            onChange={(id) => id && id !== activity?.id && player.relabel(item.tag, id)}
          />
          {confirm ? (
            <div className="space-y-2 rounded-lg bg-danger/10 p-2.5 text-xs">
              <p>Forget this cartridge? Next time it goes in, the player treats it as blank.</p>
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="light" onPress={() => setConfirm(false)}>
                  Keep
                </Button>
                <Button size="sm" color="danger" onPress={() => player.forget(item.tag)}>
                  Forget
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="light"
              color="danger"
              className="w-full"
              isDisabled={item.inSlot}
              onPress={() => setConfirm(true)}
            >
              {item.inSlot ? "Take it out to forget it" : "Forget cartridge"}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-default-500">{label}</div>
    </div>
  );
}
