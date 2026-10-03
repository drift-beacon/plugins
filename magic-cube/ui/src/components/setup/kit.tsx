import {
Button,
Tooltip
} from "@heroui/react";
import { cn } from "@heroui/theme";
import { Check,ChevronDown,Lightbulb,LightbulbOff,Minus,Pin,Play,Plus,Trash2,Undo2,X } from "lucide-react";
import { AnimatePresence,LayoutGroup,motion,useAnimate,useReducedMotion } from "motion/react";
import { type PointerEvent as ReactPointerEvent,useEffect,useId,useRef,useState } from "react";
import { Icon } from "../Icon";
import { getCategories,spanActivitiesIn } from "./catalog";
import { CubeGlyph,type GlyphState,LiveIcon,Odometer } from "./icons";
import {
addItem,
describe,
type Face,
faceCount,
FACES,
FEEL_FACES,
growItem,
type Mapping,
mappingKey,
removeItem,
SHOULD_FACES,
shrinkItem,
toggleRouletteActivity,
type Workspace
} from "./model";
import { EASE_IN_OUT,EASE_OUT,SPRING_POP,SPRING_SETTLE,SPRING_SNAP } from "./motion";
import { PickerPopover } from "./picker";
import type { LiveView,Roll } from "./runtime";
import { Pips } from "./shared";

// Mode editors share the activity picker and cube feedback. Each reports hover so the cube can answer, and every
// choice opens the same picker from the card itself.

/** Hover handlers that only count a real mouse (touch fires a false hover on tap). */
export function mouseHover(enter: () => void, leave: () => void) {
  return {
    onPointerEnter: (e: ReactPointerEvent) => e.pointerType === "mouse" && enter(),
    onPointerLeave: (e: ReactPointerEvent) => e.pointerType === "mouse" && leave(),
  };
}

/** A brief ring on the card that controls what the user just touched on the cube. Keyed, so it replays. */
export function Flash({ n }: { n?: number }) {
  if (!n) return null;
  return (
    <motion.span
      key={n}
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-primary"
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 1, 0] }}
      transition={{ duration: 0.8, times: [0, 0.15, 1], ease: EASE_OUT }}
    />
  );
}

/** The chevron that says "this whole card opens a picker". Turns over while it's open. */
function OpensPicker({ open, className }: { open: boolean; className?: string }) {
  return (
    <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full text-default-400 transition-colors duration-150 group-hover:bg-foreground/5 group-hover:text-foreground", open && "text-foreground", className)}>
      <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200 ease-out", open && "rotate-180")} />
    </span>
  );
}

// ── Modes

export function DuelEditor({
  ws,
  onHoverFaces,
  flash,
}: {
  ws: Workspace;
  onHoverFaces: (faces: Face[] | null) => void;
  flash?: { side: "should" | "feel"; n: number } | null;
}) {
  const { duel } = ws.setup;
  const [swaps, setSwaps] = useState(0);
  return (
    <LayoutGroup id="duel">
      <div className="duel-editor">
        <Fighter
          side="should"
          value={duel.should}
          other={duel.feel}
          onChange={(should) => ws.update({ duel: { ...duel, should } })}
          onHoverFaces={onHoverFaces}
          flash={flash?.side === "should" ? flash.n : undefined}
        />
        <div className="duel-swap">
          <motion.button
            aria-label="Swap sides"
            onClick={() => {
              setSwaps((n) => n + 1);
              ws.update({ duel: { should: duel.feel, feel: duel.should } });
            }}
            animate={{ transform: `rotate(${swaps * 360}deg)` }}
            transition={{ type: "spring", duration: 0.6, bounce: 0.25 }}
            className="duel-swap-button grid place-items-center rounded-full border border-default-200 bg-background text-sm font-black italic tracking-tight shadow-lg transition-colors duration-150 hover:border-default-300"
          >
            VS
          </motion.button>
        </div>
        <Fighter
          side="feel"
          value={duel.feel}
          other={duel.should}
          onChange={(feel) => ws.update({ duel: { ...duel, feel } })}
          onHoverFaces={onHoverFaces}
          flash={flash?.side === "feel" ? flash.n : undefined}
        />
      </div>
    </LayoutGroup>
  );
}

/** A contender. The whole card is the picker's trigger. */
function Fighter({
  side,
  value,
  other,
  onChange,
  onHoverFaces,
  flash,
}: {
  side: "should" | "feel";
  value: Mapping | null;
  other: Mapping | null;
  onChange: (m: Mapping | null) => void;
  onHoverFaces: (faces: Face[] | null) => void;
  flash?: number;
}) {
  const d = describe(value);
  const faces = side === "should" ? SHOULD_FACES : FEEL_FACES;
  const [pulse, setPulse] = useState(0);
  const mirrored = side === "feel";
  return (
    <PickerPopover value={value} exclude={[other]} onSelect={(m) => m && onChange(m)}>
      {(open) => (
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`${side === "should" ? "Should be doing" : "Feel like doing"}: ${d?.name ?? "not chosen"}`}
          {...mouseHover(
            () => {
              onHoverFaces(faces);
              setPulse((p) => p + 1);
            },
            () => onHoverFaces(null),
          )}
          className={cn(
            "duel-fighter group relative flex w-full min-w-0 flex-col overflow-hidden rounded-2xl text-left ring-1 transition-[box-shadow,transform] duration-150 ease-out active:scale-[0.985]",
            open ? "ring-2 ring-primary/70" : "ring-default-100 hover:ring-default-300",
          )}
          style={{ background: d ? `linear-gradient(${mirrored ? "225deg" : "135deg"}, ${d.color}26, transparent 70%)` : undefined }}
        >
          <span className="duel-fighter-heading">
            <span className="duel-fighter-label font-semibold uppercase tracking-wider text-default-500">{side === "should" ? "Should be doing" : "Feel like doing"}</span>
            <span className="duel-fighter-faces flex gap-1 text-default-400">
              {faces.map((f) => (
                <Pips key={f} face={f} size={12} />
              ))}
            </span>
            <OpensPicker open={open} className="duel-fighter-chevron" />
          </span>
          <span className="duel-fighter-body">
            {d && value ? (
              // Shared layout id: on a swap, the contender flies to the other corner.
              <motion.span
                layoutId={`fighter-${mappingKey(value)}`}
                transition={SPRING_SETTLE}
                initial={{ opacity: 0, transform: "translateY(4px)" }}
                animate={{ opacity: 1, transform: "translateY(0px)" }}
                className="duel-fighter-choice"
              >
                <span className="duel-fighter-icon grid shrink-0 place-items-center" style={{ background: `${d.color}26` }}>
                  <LiveIcon path={d.iconPath} color={d.color} size={34} verb={d.verb} play={pulse} />
                </span>
                <span className="min-w-0">
                  <span className="duel-fighter-name line-clamp-2 font-bold leading-tight">{d.name}</span>
                  <span className="duel-fighter-detail mt-1 block text-default-500">{d.isCategory ? `Random · ${d.subtitle}` : d.subtitle}</span>
                </span>
              </motion.span>
            ) : (
              <span className="duel-fighter-choice">
                <span className="duel-fighter-icon grid shrink-0 place-items-center border border-dashed border-default-300 text-default-400 transition-colors duration-150 group-hover:border-default-400 group-hover:text-foreground">
                  <Plus className="h-6 w-6" />
                </span>
                <span className="min-w-0">
                  <span className="duel-fighter-name line-clamp-2 font-bold leading-tight text-default-400">Pick a contender</span>
                  <span className="duel-fighter-detail mt-1 block text-default-400">An activity, or a whole category</span>
                </span>
              </span>
            )}
          </span>
          <Flash n={flash} />
        </button>
      )}
    </PickerPopover>
  );
}

// ── Shortlist

export function ShortlistEditor({
  ws,
  onHoverFaces,
  flash,
  columns = 2,
}: {
  ws: Workspace;
  onHoverFaces: (faces: Face[] | null) => void;
  flash?: { item: number; n: number } | null;
  columns?: 2 | 3;
}) {
  const list = ws.setup.shortlist;
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2", columns === 3 && "lg:grid-cols-3")}>
      <AnimatePresence initial={false} mode="popLayout">
        {list.items.map((m, i) => (
          <Ticket
            key={mappingKey(m)}
            mapping={m}
            faces={FACES.filter((f) => list.faces[f] === i)}
            canGrow={list.items.some((_, j) => j !== i && faceCount(list, j) > 1)}
            canShrink={faceCount(list, i) > 1 && list.items.length > 1}
            onGrow={() => ws.update({ shortlist: growItem(list, i) })}
            onShrink={() => ws.update({ shortlist: shrinkItem(list, i) })}
            onRemove={() => ws.update({ shortlist: removeItem(list, i) })}
            onHoverFaces={onHoverFaces}
            flash={flash?.item === i ? flash.n : undefined}
          />
        ))}
        {list.items.length < 6 && (
          <PickerPopover key="add" value={null} exclude={list.items} onSelect={(m) => m && ws.update({ shortlist: addItem(list, m) })}>
            {(open) => (
              <motion.button
                layout
                type="button"
                aria-haspopup="listbox"
                aria-expanded={open}
                transition={SPRING_SETTLE}
                className={cn(
                  "group flex min-h-[84px] w-full items-center justify-center gap-2 rounded-2xl border border-dashed text-sm transition-[border-color,background-color,color] duration-150 ease-out active:scale-[0.98]",
                  open ? "border-primary/60 bg-primary/5 text-foreground" : "border-default-200 text-default-400 hover:border-default-300 hover:text-foreground",
                )}
              >
                <Plus className="h-4 w-4" />
                {list.items.length === 0 ? "Add your first pick" : "Add a pick"}
                <span className="text-default-400">· {6 - list.items.length} left</span>
              </motion.button>
            )}
          </PickerPopover>
        )}
      </AnimatePresence>
    </div>
  );
}

function Ticket({
  mapping,
  faces,
  canGrow,
  canShrink,
  onGrow,
  onShrink,
  onRemove,
  onHoverFaces,
  flash,
}: {
  mapping: Mapping;
  faces: Face[];
  canGrow: boolean;
  canShrink: boolean;
  onGrow: () => void;
  onShrink: () => void;
  onRemove: () => void;
  onHoverFaces: (faces: Face[] | null) => void;
  flash?: number;
}) {
  const d = describe(mapping)!;
  const [pulse, setPulse] = useState(0);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15, ease: EASE_OUT } }}
      transition={SPRING_SETTLE}
      {...mouseHover(
        () => {
          onHoverFaces(faces);
          setPulse((p) => p + 1);
        },
        () => onHoverFaces(null),
      )}
      className="group relative flex overflow-hidden rounded-2xl ring-1 ring-default-100"
      style={{ background: `linear-gradient(135deg, ${d.color}14, transparent 60%)` }}
    >
      <div className="w-1.5 shrink-0" style={{ background: d.color }} />
      <div className="flex min-w-0 flex-1 items-center gap-3 p-3">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl" style={{ background: `${d.color}26` }}>
          <LiveIcon path={d.iconPath} color={d.color} size={22} verb={d.verb} play={pulse} amp={0.6} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-sm font-medium leading-snug">{d.isCategory ? `Any ${d.name}` : d.name}</div>
          <div className="mt-1 flex gap-1 text-default-400">
            <AnimatePresence initial={false} mode="popLayout">
              {faces.map((f) => (
                <motion.span key={f} layout initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={SPRING_POP}>
                  <Pips face={f} size={12} />
                </motion.span>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>
      {/* Ticket stub: the face count lives here. */}
      <div className="flex flex-col items-center justify-center gap-0.5 border-l border-dashed border-default-200 px-2">
        <button
          aria-label="More faces"
          disabled={!canGrow}
          onClick={onGrow}
          className="rounded-md p-1 text-default-400 transition-[transform,background-color,color] duration-150 ease-out hover:bg-default-100 hover:text-foreground active:scale-[0.9] disabled:opacity-30"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <Odometer value={faces.length} className="text-lg font-bold leading-none" />
        <button
          aria-label="Fewer faces"
          disabled={!canShrink}
          onClick={onShrink}
          className="rounded-md p-1 text-default-400 transition-[transform,background-color,color] duration-150 ease-out hover:bg-default-100 hover:text-foreground active:scale-[0.9] disabled:opacity-30"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
      </div>
      <button
        aria-label={`Remove ${d.name}`}
        onClick={onRemove}
        className="absolute right-12 top-1.5 rounded-full p-1 text-default-400 opacity-0 transition-opacity duration-150 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
      <Flash n={flash} />
    </motion.div>
  );
}

// ── Category roulette

export function RouletteEditor({ ws, onPreview, columns = 3 }: { ws: Workspace; onPreview: (categoryId: string | null) => void; columns?: 3 | 6 }) {
  const chosen = ws.setup.roulette;
  const [plays, setPlays] = useState<Record<string, number>>({});
  return (
    <div className="space-y-5">
      {getCategories().length === 0 && <p className="text-sm text-default-500">Add a category and activities in Drift Beacon to start a draw.</p>}
      <div className={cn("grid grid-cols-2 gap-2 sm:grid-cols-3", columns === 6 && "lg:grid-cols-6")}>
        {getCategories().map((c) => {
          const active = chosen === c.id;
          return (
            <button
              key={c.id}
              disabled={spanActivitiesIn(c.id).length === 0}
              aria-pressed={active}
              onClick={() => {
                setPlays((p) => ({ ...p, [c.id]: (p[c.id] ?? 0) + 1 }));
                ws.update({ roulette: c.id });
              }}
              {...mouseHover(
                () => onPreview(c.id),
                () => onPreview(null),
              )}
              className={cn(
                "flex items-center gap-2.5 rounded-xl border p-3 text-left disabled:opacity-40 disabled:cursor-not-allowed transition-[border-color,background-color,transform] duration-150 ease-out active:scale-[0.97]",
                active ? "border-transparent" : "border-default-100 hover:border-default-200",
              )}
              style={active ? { background: `${c.color}22`, boxShadow: `inset 0 0 0 1.5px ${c.color}` } : undefined}
            >
              <LiveIcon path={c.iconPath} color={c.color} size={22} verb={c.verb} play={plays[c.id]} />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{c.name}</div>
                <div className="text-xs text-default-400">{spanActivitiesIn(c.id).length} activities</div>
              </div>
            </button>
          );
        })}
      </div>
      <RoulettePool ws={ws} />
    </div>
  );
}

/** The chosen category's activities as toggles: tap one to take it out of the draw, or put it back. */
export function RoulettePool({ ws }: { ws: Workspace }) {
  const cat = ws.setup.roulette;
  if (!cat) return null;
  const all = spanActivitiesIn(cat);
  const off = new Set(ws.setup.rouletteOff[cat] ?? []);
  const inDraw = all.filter((x) => !off.has(x.id)).length;
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold uppercase tracking-wider text-default-400">In the draw</span>
        <span className="text-default-500">
          <Odometer value={inDraw} /> of {all.length}
        </span>
        <AnimatePresence>
          {inDraw < all.length && (
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15, ease: EASE_OUT }}
              onClick={() => ws.update({ rouletteOff: { ...ws.setup.rouletteOff, [cat]: [] } })}
              className="ml-auto text-primary hover:underline"
            >
              Include all
            </motion.button>
          )}
        </AnimatePresence>
      </div>
      <motion.div key={cat} className="flex flex-wrap gap-1.5" initial="hidden" animate="shown" variants={{ shown: { transition: { staggerChildren: 0.03 } } }}>
        {all.map((x) => (
          <PoolChip
            key={x.id}
            name={x.name}
            color={x.color}
            iconPath={x.iconPath}
            on={!off.has(x.id)}
            onToggle={() => {
              const next = toggleRouletteActivity(ws.setup, x.id);
              if (!next) return false;
              ws.update({ rouletteOff: next });
              return true;
            }}
          />
        ))}
      </motion.div>
    </div>
  );
}

function PoolChip({ name, color, iconPath, on, onToggle }: { name: string; color: string; iconPath: string; on: boolean; onToggle: () => boolean }) {
  const [scope, animate] = useAnimate<HTMLButtonElement>();
  const reduced = useReducedMotion();
  return (
    <motion.button
      ref={scope}
      type="button"
      aria-pressed={on}
      title={on ? `Take ${name} out of the draw` : `Put ${name} back in the draw`}
      variants={{ hidden: { opacity: 0, transform: "translateY(4px)" }, shown: { opacity: 1, transform: "translateY(0px)" } }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
      onClick={() => {
        // The last one in can't leave: a small "no" shake instead.
        if (!onToggle() && !reduced && scope.current) {
          animate(scope.current, { transform: ["translateX(0px)", "translateX(-4px)", "translateX(4px)", "translateX(-2px)", "translateX(0px)"] }, { duration: 0.32, ease: EASE_OUT });
        }
      }}
      className={cn(
        "flex max-w-full items-center gap-1.5 rounded-full py-1 pl-1 pr-3 text-xs ring-1 transition-[background-color,box-shadow,color] duration-150 ease-out active:scale-[0.96]",
        on ? "text-foreground ring-transparent" : "text-default-400 ring-default-200 hover:text-default-600",
      )}
      style={on ? { background: `${color}22`, boxShadow: `inset 0 0 0 1px ${color}80` } : undefined}
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full transition-colors duration-150" style={{ background: on ? color : "transparent" }}>
        <AnimatePresence initial={false} mode="popLayout">
          {on ? (
            <motion.span key="on" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} transition={SPRING_POP}>
              <Check className="h-3 w-3 text-black/75" strokeWidth={3.5} />
            </motion.span>
          ) : (
            <motion.span key="off" initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.7 }} transition={{ duration: 0.15, ease: EASE_OUT }}>
              <Icon path={iconPath} className="h-3 w-3" />
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <span className={cn("truncate", !on && "line-through decoration-default-400/60")}>{name}</span>
    </motion.button>
  );
}

// ── Manual

export function ManualEditor({
  ws,
  selected,
  onSelect,
  onHoverFaces,
}: {
  ws: Workspace;
  selected: Face | null;
  onSelect: (f: Face | null) => void;
  onHoverFaces: (faces: Face[] | null) => void;
}) {
  const [pulse, setPulse] = useState<Record<string, number>>({});
  return (
    <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
      {FACES.map((f) => {
        const m = ws.setup.manual[f];
        const d = describe(m);
        return (
          <PickerPopover
            key={f}
            value={m}
            clearLabel="Leave this face empty"
            isOpen={selected === f}
            onOpenChange={(o) => onSelect(o ? f : null)}
            onSelect={(next) => ws.update({ manual: { ...ws.setup.manual, [f]: next } })}
          >
            {(open) => (
              <button
                type="button"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={`Face ${f}: ${d?.name ?? "empty"}`}
                {...mouseHover(
                  () => {
                    onHoverFaces([f]);
                    setPulse((p) => ({ ...p, [f]: (p[f] ?? 0) + 1 }));
                  },
                  () => onHoverFaces(null),
                )}
                className={cn(
                  "group flex w-full items-center gap-2.5 rounded-2xl p-3 text-left ring-1 transition-[box-shadow,transform] duration-150 ease-out active:scale-[0.98]",
                  open ? "ring-2 ring-primary/70" : "ring-default-100 hover:ring-default-300",
                )}
                style={{ background: d ? `linear-gradient(135deg, ${d.color}1f, transparent 70%)` : undefined }}
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-foreground text-background">
                  <Pips face={f} size={17} />
                </span>
                {d ? (
                  <>
                    <LiveIcon path={d.iconPath} color={d.color} size={18} verb={d.verb} play={pulse[f]} amp={0.5} />
                    <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-tight">{d.isCategory ? `Any ${d.name}` : d.name}</span>
                  </>
                ) : (
                  <span className="flex-1 text-sm text-default-400">Empty face</span>
                )}
                <OpensPicker open={open} />
              </button>
            )}
          </PickerPopover>
        );
      })}
    </div>
  );
}

/** The editor for the current mode. */
export function ModeEditor({
  ws,
  onHoverFaces,
  onPreview,
  selected,
  onSelect,
  flash,
  wideRows,
}: {
  ws: Workspace;
  onHoverFaces: (faces: Face[] | null) => void;
  onPreview: (categoryId: string | null) => void;
  selected: Face | null;
  onSelect: (f: Face | null) => void;
  flash?: { key: string; n: number } | null;
  /** Lay grids out in more columns when the editor spans the full width. */
  wideRows?: boolean;
}) {
  const mode = ws.setup.mode;
  if (mode === "duel") return <DuelEditor ws={ws} onHoverFaces={onHoverFaces} flash={flash && (flash.key === "should" || flash.key === "feel") ? { side: flash.key, n: flash.n } : null} />;
  if (mode === "shortlist")
    return <ShortlistEditor ws={ws} onHoverFaces={onHoverFaces} columns={wideRows ? 3 : 2} flash={flash && /^\d$/.test(flash.key) ? { item: Number(flash.key), n: flash.n } : null} />;
  if (mode === "roulette") return <RouletteEditor ws={ws} onPreview={onPreview} columns={wideRows ? 6 : 3} />;
  return <ManualEditor ws={ws} selected={selected} onSelect={onSelect} onHoverFaces={onHoverFaces} />;
}

// ── Lights

/**
 * Whether the cube lights the Nanoleaf wall while it is in hand: its faces' colours pulse when it is picked up,
 * shuffle when it is shaken, and the winner's colour is revealed when it lands. Shown only where the Nanoleaf plugin
 * is installed.
 */
export function LightsToggle({ ws, className }: { ws: Workspace; className?: string }) {
  if (!ws.nanoleaf) return null;
  const on = ws.lightNanoleaf;
  const Glyph = on ? Lightbulb : LightbulbOff;
  return (
    <Tooltip content={on ? "Lights your Nanoleaf while the cube is in hand" : "Your Nanoleaf ignores the cube"} delay={500} closeDelay={0} placement="bottom">
      <button
        type="button"
        aria-pressed={on}
        aria-label="Light the Nanoleaf"
        onClick={() => ws.setLightNanoleaf(!on)}
        className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-default-100 transition-[color,transform] duration-150 active:scale-[0.9]", on ? "text-foreground" : "text-default-400 hover:text-foreground", className)}
      >
        <Glyph className="h-4 w-4" />
      </button>
    </Tooltip>
  );
}

// ── Presets

/**
 * What happens when the cube lands: Pin keeps the result waiting for you, Track starts it (or marks a point)
 * right away. A segmented switch whose pill slides between the two.
 */
export function PinTrackSwitch({ ws, className }: { ws: Workspace; className?: string }) {
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [keyboard, setKeyboard] = useState(false);
  const value = ws.autoStart ? "track" : "pin";
  const options = [
    { id: "pin", label: "Pin", Glyph: Pin, hint: "Keep the result here — start it when you're ready" },
    { id: "track", label: "Track", Glyph: Play, hint: "Start tracking the moment it lands" },
  ] as const;
  return (
    <div role="radiogroup" aria-label="When the cube lands" className={cn("relative flex w-fit rounded-xl bg-default-100 p-1", className)}>
      {options.map((o, i) => {
        const active = value === o.id;
        return (
          <Tooltip key={o.id} content={o.hint} delay={500} closeDelay={0} placement="bottom">
            <button
              type="button"
              role="radio"
              aria-checked={active}
              ref={el => { buttons.current[i] = el; }}
              tabIndex={active ? 0 : -1}
              onKeyDown={e => {
                if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
                e.preventDefault();
                const next = e.key === "Home" ? 0 : e.key === "End" ? 1 : 1 - i;
                setKeyboard(true); ws.setAutoStart(next === 1); buttons.current[next]?.focus();
              }}
              onClick={e => { setKeyboard(e.detail === 0); ws.setAutoStart(o.id === "track"); }}
              className={cn("relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors duration-150", active ? "text-foreground" : "text-default-500 hover:text-foreground")}
            >
              {active && <motion.span layoutId={`pintrack-${id}`} className="absolute inset-0 rounded-lg bg-background shadow-sm ring-1 ring-default-200" transition={keyboard ? { duration: 0 } : SPRING_SNAP} />}
              {/* The glyph settles into place when its side is chosen: the pin drops, the play nudges forward. */}
              <motion.span
                key={active ? "on" : "off"}
                className="relative"
                initial={active && !keyboard ? { opacity: 0.4, transform: o.id === "pin" ? "translateY(-4px)" : "translateX(-3px)" } : false}
                animate={{ opacity: 1, transform: "translate(0px, 0px)" }}
                transition={SPRING_POP}
              >
                <o.Glyph className="h-3.5 w-3.5" />
              </motion.span>
              <span className="relative">{o.label}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ── The live flow: the steps the hardware walks through, and the result.

const STEPS = [
  { label: "Pick up", prompt: "hold" as GlyphState },
  { label: "Shake", prompt: "shake" as GlyphState },
  { label: "Set down", prompt: "hold" as GlyphState },
];

/** The next physical action is the one that animates: the UI prompts, the hand acts. */
export function LiveStepper({ view, size = "md" }: { view: LiveView; size?: "sm" | "md" }) {
  const idx = view === "held" ? 1 : view === "activated" ? 2 : view === "result" ? 3 : 0;
  const glyph = size === "sm" ? 26 : 38;
  return (
    <div className="flex items-center">
      {STEPS.map((step, i) => {
        const done = i < idx;
        const current = i === idx;
        const state: GlyphState = view === "result" && i === 2 ? "land" : done ? "done" : current ? step.prompt : "idle";
        return (
          <div key={step.label} className="flex items-center">
            {i > 0 && (
              <div className={cn("relative mx-2 -mt-5 h-0.5 overflow-hidden rounded-full bg-default-200", size === "sm" ? "w-6" : "w-10")}>
                <motion.div
                  className="absolute inset-0 origin-left bg-primary"
                  initial={false}
                  animate={{ transform: `scaleX(${i <= idx ? 1 : 0})` }}
                  transition={{ duration: 0.3, ease: EASE_IN_OUT }}
                />
              </div>
            )}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={cn(
                  "grid place-items-center rounded-full transition-colors duration-300",
                  size === "sm" ? "h-9 w-9" : "h-14 w-14",
                  done && !(view === "result" && i === 2)
                    ? "bg-primary text-primary-foreground"
                    : current || (view === "result" && i === 2)
                      ? "bg-default-100 text-foreground ring-2 ring-primary/60"
                      : "bg-default-100 text-default-400",
                )}
              >
                <CubeGlyph state={state} size={glyph * (state === "done" ? 0.75 : 1)} />
              </div>
              <span className={cn("whitespace-nowrap text-xs font-medium transition-colors duration-300", current ? "text-foreground" : done ? "text-default-500" : "text-default-400")}>{step.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const LIVE_COPY: Record<"held" | "activated", { title: string; body: string }> = {
  held: { title: "Got it", body: "Give it a shake to arm the roll." },
  activated: { title: "Armed", body: "Set it down on any face." },
};

function useElapsed(since: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [since]);
  if (!since) return null;
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A running span: just the time. */
function TimerPill({ since }: { since: number }) {
  const reduced = useReducedMotion();
  const elapsed = useElapsed(since);
  return (
    <span className="flex items-center gap-2 rounded-full bg-success/15 px-3.5 py-1.5 text-base font-semibold tabular-nums text-success" aria-label={`Tracking, ${elapsed}`}>
      <span className="relative flex h-2 w-2">
        {!reduced && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />}
        <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
      </span>
      {elapsed}
    </span>
  );
}

/** A marked point: the check draws itself. */
function MarkedPill() {
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-success/15 py-1.5 pl-2.5 pr-3.5 text-sm font-semibold text-success">
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
        <motion.path
          d="M5 12.5l4.2 4.2L19 7"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.28, ease: EASE_OUT }}
        />
      </svg>
      Marked
    </span>
  );
}

/**
 * The result, arranged for the card it sits in. Pin: one call to action — Start for a span, Mark for a point.
 * Track: just the running time (or the mark). The actions swap with a short blurred crossfade, so the button
 * reads as turning into the timer.
 */
export function ResultBody({
  roll,
  onTrack,
  onDismiss,
  onDiscard,
  delay = 0.55,
  align = "center",
  compact,
  hideIcon,
  busy = false,
}: {
  roll: Roll;
  onTrack: () => void;
  onDismiss: () => void;
  onDiscard: () => void;
  /** Wait for the cube to land before the words arrive. */
  delay?: number;
  align?: "center" | "left";
  compact?: boolean;
  /** When the 3D cube is already presenting the face, it is the icon. */
  hideIcon?: boolean;
  busy?: boolean;
}) {
  const reduced = useReducedMotion();
  const a = roll.activity;
  const item = {
    hidden: reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px)" },
    shown: { opacity: 1, transform: "translateY(0px)" },
  };
  const t = { duration: 0.25, ease: EASE_OUT };
  const side = roll.slot.side;
  const isPoint = a?.trackingType === "point";
  const state = roll.discarded ? "discarded" : roll.tracked ? "tracked" : "pinned";
  const swap = {
    initial: reduced ? { opacity: 0 } : { opacity: 0, filter: "blur(3px)", transform: "scale(0.97)" },
    animate: { opacity: 1, filter: "blur(0px)", transform: "scale(1)" },
    exit: reduced ? { opacity: 0 } : { opacity: 0, filter: "blur(3px)", transform: "scale(0.97)", transition: { duration: 0.1, ease: EASE_OUT } },
    transition: { duration: 0.18, ease: EASE_OUT },
  };

  return (
    <motion.div
      className={cn("flex flex-col", compact ? "gap-2" : "gap-3", align === "center" ? "items-center text-center" : "items-start")}
      initial="hidden"
      animate="shown"
      variants={{ shown: { transition: { delayChildren: reduced ? 0 : delay, staggerChildren: 0.05 } } }}
    >
      <motion.div variants={item} transition={t} className="flex items-center gap-2 rounded-full bg-default-100 px-3 py-1 text-xs text-default-500">
        <Pips face={roll.face} size={12} /> Rolled {roll.face}
        {side && <span className="font-semibold text-foreground">· {side === "should" ? "Should wins" : "Feel wins"}</span>}
      </motion.div>
      {a ? (
        <>
          <motion.div variants={item} transition={t} className={cn("flex items-center gap-3", align === "center" && !compact && "flex-col")}>
            {!hideIcon && (
              <div className={cn("grid shrink-0 place-items-center rounded-2xl", compact ? "h-12 w-12" : "h-16 w-16")} style={{ background: `${a.color}26` }}>
                <LiveIcon path={a.iconPath} color={a.color} size={compact ? 26 : 36} draw />
              </div>
            )}
            <div className="min-w-0">
              <div className={cn("font-bold leading-tight", compact ? "text-lg" : "text-2xl")}>{a.name}</div>
              {roll.fromCategory && <div className="mt-0.5 text-sm text-default-500">Drawn from {roll.fromCategory}</div>}
            </div>
          </motion.div>
          <motion.div variants={item} transition={t} className="flex min-h-9 flex-wrap items-center gap-2 pt-1">
            <AnimatePresence mode="popLayout" initial={false}>
              {state === "pinned" && (
                <motion.div key="pinned" {...swap} className="flex items-center gap-2">
                  <Button
                    size={compact ? "sm" : "md"}
                    color="primary"
                    radius="full"
                    className="font-semibold"
                    startContent={isPoint ? <Check className="h-4 w-4" strokeWidth={3} /> : <Play className="h-4 w-4" />}
                    isLoading={busy}
                    onPress={onTrack}
                  >
                    {isPoint ? "Mark" : "Start"}
                  </Button>
                  <Button size={compact ? "sm" : "md"} variant="flat" radius="full" onPress={onDismiss}>
                    Not now
                  </Button>
                </motion.div>
              )}
              {state === "tracked" && roll.tracked && (
                <motion.div key="tracked" {...swap} className="flex items-center gap-1.5">
                  {roll.tracked.kind === "span" ? <TimerPill since={roll.tracked.at} /> : <MarkedPill />}
                  {roll.canDiscard && <Tooltip content={roll.tracked.kind === "span" ? "Discard this session" : "Undo the mark"} delay={300} closeDelay={0}>
                    <Button isIconOnly size="sm" variant="light" radius="full" aria-label={roll.tracked.kind === "span" ? "Discard" : "Undo"} onPress={onDiscard} isDisabled={busy}>
                      {roll.tracked.kind === "span" ? <Trash2 className="h-4 w-4" /> : <Undo2 className="h-4 w-4" />}
                    </Button>
                  </Tooltip>}
                  <Button size="sm" variant="flat" radius="full" onPress={onDismiss}>
                    Done
                  </Button>
                </motion.div>
              )}
              {state === "discarded" && (
                <motion.div key="discarded" {...swap} className="flex items-center gap-2">
                  <span className="text-sm text-default-400">Discarded</span>
                  <Button size="sm" variant="flat" radius="full" onPress={onDismiss}>
                    Close
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </>
      ) : (
        <>
          <motion.div variants={item} transition={t} className="text-lg font-semibold text-default-500">
            Face {roll.face} is empty — nothing to start
          </motion.div>
          <motion.div variants={item} transition={t}>
            <Button size="sm" variant="flat" radius="full" onPress={onDismiss}>
              OK
            </Button>
          </motion.div>
        </>
      )}
    </motion.div>
  );
}
