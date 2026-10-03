import { Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { cn } from "@heroui/theme";
import { Pin, Play, Plus } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Cube3D } from "./cube/Cube3D";
import { CubeGlyph, type GlyphState, LiveIcon, type Verb } from "./icons";
import { ModeCards, ModeEditor, PinTrackSwitch, ResultBody } from "./kit";
import { resultFor, useCubeArt } from "./live";
import { cubeArt, type Face, FACES, isReady, MODES, type Preset, useWorkspace, type Workspace } from "./model";
import { EASE_OUT, SPRING_POP } from "./motion";
import { type CubeSim, useCubeSim } from "./sim";

const CONSOLE_BG = "#141417";

/**
 * Direction 3 — Deck: presets come first, with the loaded one raised above the shelf.
 * The cube sits in a console and boots whatever is slotted in. The live flow never takes over: a small island
 * up top morphs through pick up → shake → set down → result while the config stays put.
 */
export function Deck() {
  const ws = useWorkspace();
  const sim = useCubeSim(ws);
  const [hoverFaces, setHoverFaces] = useState<Face[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [selected, setSelected] = useState<Face | null>(null);
  const art = useCubeArt(ws.setup, preview);
  const focus = selected ? [selected] : hoverFaces;
  const mode = MODES.find((m) => m.id === ws.setup.mode)!;

  return (
    <div className="relative space-y-4">
      {/* The island has its own row at rest; when it grows into a card it floats over what's below. */}
      <div className="pointer-events-none sticky top-3 z-30 h-11">
        <div className="pointer-events-auto absolute left-1/2 top-0 -translate-x-1/2">
          <Island sim={sim} ws={ws} />
        </div>
      </div>

      <Shelf ws={ws} />

      <div className="grid gap-4 md:grid-cols-[390px_minmax(0,1fr)]">
        {/* The console: the cube and the label of whatever preset is in it. Below the rules on a narrow screen. */}
        <div className="order-2 overflow-hidden rounded-3xl ring-1 ring-default-100 md:order-1" style={{ background: CONSOLE_BG }}>
          <div className="flex items-center justify-between px-5 pt-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-default-400">
            <span>Console</span>
            <span className="flex items-center gap-1.5">
              <span className={cn("h-1.5 w-1.5 rounded-full", sim.cube === "idle" ? "bg-success" : sim.cube === "held" ? "bg-warning" : "bg-cyan-400")} />
              {sim.cube === "idle" ? "Ready" : sim.cube === "held" ? "In hand" : "Armed"}
            </span>
          </div>
          <Cube3D
            className="h-[360px] w-full"
            faces={art.faces}
            flicker={art.flicker}
            phase={sim.view}
            result={sim.view === "result" ? resultFor(sim.roll) : null}
            highlight={focus}
            focus={focus}
            selected={selected}
            onFaceClick={(f) => ws.setup.mode === "manual" && setSelected(f === selected ? null : f)}
            bootKey={ws.bootKey}
            zoom={sim.view === "idle" ? 1.2 : 1.35}
            background={CONSOLE_BG}
          />
          <div className="border-t border-white/5 px-5 py-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-default-400">Loaded</div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={ws.active?.id ?? "unsaved"}
                initial={{ opacity: 0, transform: "translateY(8px)" }}
                animate={{ opacity: 1, transform: "translateY(0px)" }}
                exit={{ opacity: 0, transform: "translateY(-6px)", transition: { duration: 0.12, ease: EASE_OUT } }}
                transition={{ duration: 0.22, ease: EASE_OUT }}
                className="mt-1 flex items-center gap-2"
              >
                <span className="truncate text-xl font-bold">{ws.active?.name ?? "Unsaved setup"}</span>
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-xs text-default-400">
                  <LiveIcon path={mode.iconPath} size={12} verb={mode.verb as Verb} play={ws.bootKey} /> {mode.name}
                </span>
              </motion.div>
            </AnimatePresence>
            <div className="mt-3 flex items-center justify-between gap-3">
              <PinTrackSwitch ws={ws} />
              {!isReady(ws.setup) && <span className="text-xs text-warning">Some faces are empty</span>}
            </div>
          </div>
        </div>

        {/* The preset's rules: straight on the page, so the cards in it aren't cards inside a card. */}
        <div className="order-1 space-y-4 md:order-2 md:pt-1">
          <div>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-default-400">Game</div>
            <ModeCards
              compact
              value={ws.setup.mode}
              onChange={(m) => {
                ws.update({ mode: m });
                setSelected(null);
              }}
            />
          </div>
          <ModeEditor ws={ws} onHoverFaces={setHoverFaces} onPreview={setPreview} selected={selected} onSelect={setSelected} />
        </div>
      </div>
    </div>
  );
}

/** The loaded preset sits raised; selecting another plays a short insert. */
function Shelf({ ws }: { ws: Workspace }) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex gap-3 overflow-x-auto px-1 pb-2 pt-3">
      {ws.presets.map((p) => (
        <DeckPreset key={p.id} preset={p} active={p.id === ws.activeId} bootKey={ws.bootKey} onSelect={() => p.id !== ws.activeId && ws.select(p.id)} />
      ))}
      <Popover isOpen={creating} onOpenChange={setCreating} placement="bottom-start">
        <PopoverTrigger>
          <button className="flex h-[124px] w-[150px] flex-none flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-default-200 text-sm text-default-400 transition-[border-color,color,transform] duration-150 ease-out hover:border-default-300 hover:text-foreground active:scale-[0.97]">
            <Plus className="h-5 w-5" />
            New preset
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[420px] p-3">
          <div className="w-full space-y-2">
            <div className="text-sm font-semibold">Pick a game for the new preset</div>
            <ModeCards
              value={ws.setup.mode}
              onChange={(m) => {
                ws.create(`New ${MODES.find((x) => x.id === m)!.short.toLowerCase()}`, m);
                setCreating(false);
              }}
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function DeckPreset({ preset, active, bootKey, onSelect }: { preset: Preset; active: boolean; bootKey: number; onSelect: () => void }) {
  const reduced = useReducedMotion();
  const mode = MODES.find((m) => m.id === preset.setup.mode)!;
  const { faces } = cubeArt(preset.setup);
  const lead = FACES.map((f) => faces[f].color).find(Boolean) ?? "#71717a";
  // Insert: pushed down into the slot, then it settles proud of the others. Plays when this one becomes active.
  const [inserts, setInserts] = useState(0);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) setInserts((n) => n + 1);
    wasActive.current = active;
  }, [active, bootKey]);

  return (
    <motion.button
      onClick={onSelect}
      aria-pressed={active}
      className="group relative h-[124px] w-[164px] flex-none text-left"
      animate={
        reduced
          ? { transform: "translateY(0px)" }
          : active
            ? { transform: inserts ? ["translateY(0px)", "translateY(9px)", "translateY(-8px)"] : "translateY(-8px)" }
            : { transform: "translateY(0px)" }
      }
      transition={active && inserts ? { duration: 0.5, times: [0, 0.35, 1], ease: EASE_OUT } : SPRING_POP}
      key={`${preset.id}-${inserts}`}
      whileTap={{ scale: 0.97 }}
    >
      <div
        className={cn(
          "absolute inset-0 overflow-hidden rounded-2xl rounded-b-md bg-[#232328] ring-1 transition-[box-shadow] duration-200",
          active ? "ring-primary/70" : "ring-default-100 group-hover:ring-default-200",
        )}
        style={active ? { boxShadow: `0 10px 30px -10px ${lead}88` } : undefined}
      >
        {/* Grip ridges along the top edge. */}
        <div className="flex h-4 items-center justify-center gap-[3px] bg-black/30">
          {Array.from({ length: 14 }, (_, i) => (
            <span key={i} className="h-2 w-[2px] rounded-full bg-white/10" />
          ))}
        </div>
        {/* The label sticker. */}
        <div className="m-2 mt-1.5 rounded-lg p-2.5" style={{ background: `linear-gradient(135deg, ${lead}40, ${lead}14)` }}>
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-default-300">
            <LiveIcon path={mode.iconPath} size={12} verb={mode.verb as Verb} play={active ? `${bootKey}-${inserts}` : undefined} />
            {mode.short}
            <span className="ml-auto grid h-4 w-4 place-items-center rounded bg-black/30 text-default-400" title={preset.autoStart ? "Tracks on landing" : "Pins on landing"}>
              {preset.autoStart ? <Play className="h-2.5 w-2.5" /> : <Pin className="h-2.5 w-2.5" />}
            </span>
          </div>
          <div className="mt-1 line-clamp-2 text-sm font-bold leading-tight">{preset.name}</div>
        </div>
        {/* What's on the six faces. */}
        <div className="absolute bottom-2 left-2.5 right-2.5 flex gap-1">
          {FACES.map((f) => (
            <span key={f} className="h-1.5 flex-1 rounded-full" style={{ background: faces[f].color ?? "rgba(255,255,255,0.12)" }} />
          ))}
        </div>
      </div>
    </motion.button>
  );
}

const ISLAND: Record<"idle" | "held" | "activated", { glyph: GlyphState; title: string; body?: string; tone: string }> = {
  idle: { glyph: "idle", title: "Cube ready", tone: "text-default-400" },
  held: { glyph: "shake", title: "Shake to arm", body: "Picked up", tone: "text-amber-300" },
  activated: { glyph: "hold", title: "Armed", body: "Set it down on any face", tone: "text-cyan-200" },
};

/**
 * A Dynamic-Island-style status: a pill at rest, wider while the cube is in hand, a card when it lands. It morphs
 * with a layout spring; its content cross-fades with a touch of blur so the swap reads as one object changing.
 */
function Island({ sim, ws }: { sim: CubeSim; ws: Workspace }) {
  const reduced = useReducedMotion();
  const result = sim.view === "result" && sim.roll;
  // Hardware events (loading a preset, cancelling a roll) borrow the island for a moment.
  const notice = !result && sim.view === "idle" ? sim.notice : null;
  useEffect(() => {
    if (!sim.notice) return;
    const t = window.setTimeout(sim.clearNotice, 2800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim.notice?.id]);
  const key = result ? `r-${sim.roll!.id}` : notice ? `n-${notice.id}` : sim.view;
  const s = ISLAND[(sim.view === "result" ? "idle" : sim.view) as keyof typeof ISLAND];
  const swap = {
    initial: reduced ? { opacity: 0 } : { opacity: 0, filter: "blur(4px)" },
    animate: { opacity: 1, filter: "blur(0px)" },
    exit: reduced ? { opacity: 0 } : { opacity: 0, filter: "blur(4px)", transition: { duration: 0.1 } },
    transition: { duration: 0.2, ease: EASE_OUT },
  };
  const last = sim.roll?.activity;
  return (
    <motion.div
      layout
      transition={{ type: "spring", duration: 0.5, bounce: 0.2 }}
      className={cn("overflow-hidden bg-black shadow-2xl ring-1 ring-white/10", result ? "w-[min(440px,calc(100vw-32px))] p-4" : "px-2 py-1.5")}
      style={{ borderRadius: result ? 28 : 999 }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {result ? (
          <motion.div key={key} {...swap}>
            <ResultBody roll={sim.roll!} onTrack={sim.track} onDismiss={sim.dismiss} onDiscard={sim.discard} align="left" compact delay={0.35} />
          </motion.div>
        ) : notice ? (
          <motion.div key={key} {...swap} className="flex items-center gap-2.5 whitespace-nowrap pr-3">
            <span className={cn("grid h-8 w-8 place-items-center rounded-full", notice.kind === "preset" ? "bg-primary/20 text-primary" : "bg-white/5 text-default-400")}>
              <CubeGlyph state={notice.kind === "preset" ? "land" : "idle"} size={22} />
            </span>
            <span className="text-sm font-semibold">{notice.title}</span>
            {notice.detail && <span className="text-sm text-default-400">{notice.detail}</span>}
          </motion.div>
        ) : (
          <motion.div key={key} {...swap} className="flex items-center gap-2.5 whitespace-nowrap pr-3">
            <span className={cn("grid h-8 w-8 place-items-center rounded-full bg-white/5", s.tone)}>
              <CubeGlyph state={s.glyph} size={22} />
            </span>
            <span className="text-sm font-semibold">{s.title}</span>
            {s.body && <span className="text-sm text-default-400">{s.body}</span>}
            {sim.view === "idle" && (
              <span className="text-sm text-default-500">
                · {ws.active?.name ?? "Unsaved setup"}
                {last && <> · last: {last.name}</>}
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
