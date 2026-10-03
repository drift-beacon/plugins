import { Button } from "@heroui/react";
import { cn } from "@heroui/theme";
import { ChevronDown, Plus, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createAnchors, Cube3D, type CubeAnchors, useAnchors } from "./cube/Cube3D";
import { CATEGORIES } from "./fixtures";
import { CubeGlyph, LiveIcon, Odometer, type Verb } from "./icons";
import { ModeCards, mouseHover, NoticeToast, PinTrackSwitch, PresetMenu, ResultBody, RoulettePool } from "./kit";
import { resultFor, useCubeArt, useMediaQuery } from "./live";
import {
  addItem,
  describe,
  type Face,
  FACES,
  faceCount,
  type FaceSlot,
  FEEL_FACES,
  mappingKey,
  MODES,
  removeItem,
  sameMapping,
  SHOULD_FACES,
  useWorkspace,
  type Workspace,
} from "./model";
import { EASE_OUT, SPRING_POP } from "./motion";
import { FaceEditor } from "./face-editor";
import { PickerPopover } from "./picker";
import { Pips } from "./shared";
import { useCubeSim } from "./sim";

const BG = "#141417";

/**
 * Direction 2 — Stage: the cube is the hero and the config lives on it. Every face you can see wears a label
 * that follows it as you turn the cube; click a face (or its label) to change it right there. A slim tray holds
 * what doesn't belong to one face. The live flow plays in place: labels retract, the stage lights up. On a narrow
 * screen the options come first and the stage sits below them.
 */
export function Stage() {
  const ws = useWorkspace();
  const sim = useCubeSim(ws);
  const wide = useMediaQuery("(min-width: 768px)");
  const anchors = useMemo(createAnchors, []);
  const [hoverFaces, setHoverFaces] = useState<Face[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [editing, setEditing] = useState<Face | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const art = useCubeArt(ws.setup, preview);
  const live = sim.view !== "idle";
  const focus = editing ? [editing] : hoverFaces;

  useEffect(() => {
    if (live) setEditing(null);
  }, [live]);
  // Narrow: the stage sits below the options, so bring it (and the result it will show) into view.
  useEffect(() => {
    if (live && !wide) stageRef.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [live, wide, reduced]);

  const tray = (
    <motion.div animate={{ opacity: live ? 0.35 : 1 }} transition={{ duration: 0.2, ease: EASE_OUT }} style={{ pointerEvents: live ? "none" : "auto" }}>
      <Tray ws={ws} onHoverFaces={setHoverFaces} onPreview={setPreview} />
    </motion.div>
  );

  return (
    <div className="relative space-y-4">
      <NoticeToast notice={sim.notice} onDone={sim.clearNotice} className="absolute left-1/2 top-16 z-30 -translate-x-1/2" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <PresetMenu ws={ws} />
        <PinTrackSwitch ws={ws} />
      </div>

      {!wide && (
        <>
          <ModeCards compact value={ws.setup.mode} onChange={(m) => ws.update({ mode: m })} />
          {tray}
        </>
      )}

      <div ref={stageRef} className={cn("relative overflow-hidden rounded-3xl border border-default-100", wide ? "h-[560px]" : "h-[440px]")} style={{ background: BG }}>
        <Cube3D
          className="absolute inset-0"
          faces={art.faces}
          flicker={art.flicker}
          phase={sim.view}
          result={sim.view === "result" ? resultFor(sim.roll) : null}
          highlight={focus}
          focus={focus}
          selected={editing}
          onFaceClick={(f) => setEditing(f === editing ? null : f)}
          anchors={anchors}
          bootKey={ws.bootKey}
          turntable={false}
          zoom={live ? 1.3 : wide ? 1.18 : 1.35}
          frameY={sim.view === "result" ? -0.4 : 0}
          background={BG}
        />

        {wide && <ModeRail ws={ws} hidden={live} onChange={() => setEditing(null)} />}
        <Plates anchors={anchors} slots={art.slots} hidden={live} compact={!wide} editing={editing} onPick={(f) => setEditing(f === editing ? null : f)} />

        <AnimatePresence>
          {editing && !live && (
            <FaceEditor key="editor" face={editing} ws={ws} slot={art.slots[editing]} anchors={anchors} placement={wide ? "right" : "bottom"} onClose={() => setEditing(null)} />
          )}
        </AnimatePresence>

        {/* The live flow, in place. */}
        <div className="pointer-events-none absolute inset-x-0 top-7 flex justify-center">
          <AnimatePresence mode="wait">
            {(sim.view === "held" || sim.view === "activated") && (
              <motion.div
                key={sim.view}
                className="flex items-center gap-4 rounded-full bg-black/40 py-2 pl-2 pr-6 ring-1 ring-white/10 backdrop-blur"
                initial={{ opacity: 0, transform: "translateY(-10px) scale(0.97)" }}
                animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
                exit={{ opacity: 0, transform: "translateY(-6px) scale(0.98)", transition: { duration: 0.12, ease: EASE_OUT } }}
                transition={{ duration: 0.24, ease: EASE_OUT }}
              >
                <span className={cn("grid h-12 w-12 place-items-center rounded-full", sim.view === "held" ? "bg-amber-500/20 text-amber-300" : "bg-cyan-400/20 text-cyan-200")}>
                  <CubeGlyph state={sim.view === "held" ? "shake" : "hold"} size={34} />
                </span>
                <span>
                  <span className="block text-2xl font-black uppercase italic tracking-tight">{sim.view === "held" ? "Shake it" : "Set it down"}</span>
                  <span className="block text-sm text-default-400">{sim.view === "held" ? "Arm the roll with a shake" : "Any face — let it land"}</span>
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-7 flex justify-center px-6">
          <AnimatePresence>
            {sim.view === "result" && sim.roll && (
              <motion.div key={sim.roll.id} className="pointer-events-auto" exit={{ opacity: 0, transition: { duration: 0.15, ease: EASE_OUT } }}>
                <ResultBody roll={sim.roll} onTrack={sim.track} onDismiss={sim.dismiss} onDiscard={sim.discard} hideIcon compact={!wide} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {wide && tray}
    </div>
  );
}

/** Modes as a slim arcade rail on the stage's left edge. */
function ModeRail({ ws, hidden, onChange }: { ws: Workspace; hidden: boolean; onChange: () => void }) {
  const [plays, setPlays] = useState<Record<string, number>>({});
  return (
    <motion.div
      className="absolute left-4 top-4 z-10 flex w-44 flex-col gap-1.5"
      animate={{ opacity: hidden ? 0 : 1, transform: hidden ? "translateX(-12px)" : "translateX(0px)" }}
      transition={{ duration: 0.22, ease: EASE_OUT }}
      style={{ pointerEvents: hidden ? "none" : "auto" }}
      role="radiogroup"
      aria-label="Cube mode"
    >
      {MODES.map((m) => {
        const active = ws.setup.mode === m.id;
        return (
          <button
            key={m.id}
            role="radio"
            aria-checked={active}
            onClick={() => {
              if (!active) setPlays((p) => ({ ...p, [m.id]: (p[m.id] ?? 0) + 1 }));
              ws.update({ mode: m.id });
              onChange();
            }}
            className={cn(
              "flex items-center gap-2.5 rounded-xl p-2 text-left text-sm backdrop-blur transition-[background-color,transform] duration-150 ease-out active:scale-[0.97]",
              active ? "bg-primary/25 text-foreground ring-1 ring-primary/50" : "bg-black/30 text-default-500 ring-1 ring-white/5 hover:bg-black/45 hover:text-foreground",
            )}
          >
            <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", active ? "bg-primary text-primary-foreground" : "bg-white/5")}>
              <LiveIcon path={m.iconPath} size={16} verb={m.verb as Verb} play={plays[m.id]} />
            </span>
            <span className="font-medium leading-tight">{m.name}</span>
          </button>
        );
      })}
    </motion.div>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Labels pinned to the faces you can see. Positions are written straight to the DOM every frame from the cube's
 * anchors (no React renders), and fade with how squarely a face points at you. On a narrow stage they shrink to
 * the face number and icon (the faces carry their names) and stay inside the stage.
 */
function Plates({
  anchors,
  slots,
  hidden,
  compact,
  editing,
  onPick,
}: {
  anchors: CubeAnchors;
  slots: Record<Face, FaceSlot>;
  hidden: boolean;
  compact: boolean;
  editing: Face | null;
  onPick: (f: Face) => void;
}) {
  const plates = useRef<Record<string, HTMLButtonElement | null>>({});
  const lines = useRef<Record<string, SVGLineElement | null>>({});
  const dots = useRef<Record<string, SVGCircleElement | null>>({});
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const compactRef = useRef(compact);
  compactRef.current = compact;
  const fade = useRef<Record<string, number>>({});

  useAnchors(anchors, () => {
    const { center } = anchors;
    const tight = compactRef.current;
    // Measure everything before writing anything, so the frame never forces a layout.
    const host = plates.current[FACES[0]]?.offsetParent as HTMLElement | null;
    const W = host?.clientWidth ?? Infinity;
    const H = host?.clientHeight ?? Infinity;
    const size: Record<string, [number, number]> = {};
    for (const f of FACES) size[f] = [plates.current[f]?.offsetWidth ?? 0, plates.current[f]?.offsetHeight ?? 0];
    // The cube's on-screen radius: labels sit just outside it, whatever the zoom.
    let radius = 0;
    for (const f of FACES) radius = Math.max(radius, Math.hypot(anchors.faces[f].x - center.x, anchors.faces[f].y - center.y));
    for (const f of FACES) {
      const a = anchors.faces[f];
      const el = plates.current[f];
      const line = lines.current[f];
      const dot = dots.current[f];
      if (!el || !line || !dot) continue;
      const target = hiddenRef.current ? 0 : Math.min(1, Math.max(0, (a.facing - 0.2) / 0.3));
      const o = (fade.current[f] ?? 0) + (target - (fade.current[f] ?? 0)) * 0.25;
      fade.current[f] = o;
      let dx = a.x - center.x;
      let dy = a.y - center.y;
      const len = Math.hypot(dx, dy);
      // A face looking straight at you has no outward direction on screen: its label goes above the cube.
      if (len < radius * 0.35) {
        dx = 0;
        dy = -1;
      } else {
        dx /= len;
        dy /= len;
      }
      const reach = Math.max(len, radius) + (tight ? 44 : 70);
      const [w, h] = size[f];
      const px = clamp(center.x + dx * (reach + (tight ? 0 : 60)), w / 2 + 10, W - w / 2 - 10);
      const py = clamp(center.y + dy * reach, h / 2 + 10, H - h / 2 - 10);
      el.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%) scale(${0.94 + 0.06 * o})`;
      el.style.opacity = String(o);
      el.style.pointerEvents = o > 0.5 ? "auto" : "none";
      line.setAttribute("x1", String(a.x));
      line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(px));
      line.setAttribute("y2", String(py));
      line.style.opacity = String(o * 0.5);
      dot.setAttribute("cx", String(a.x));
      dot.setAttribute("cy", String(a.y));
      dot.style.opacity = String(o);
    }
  });

  return (
    <>
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
        {FACES.map((f) => (
          <g key={f}>
            <line
              ref={(el) => {
                lines.current[f] = el;
              }}
              stroke="white"
              strokeWidth={1}
              strokeDasharray="3 4"
              style={{ opacity: 0 }}
            />
            <circle
              ref={(el) => {
                dots.current[f] = el;
              }}
              r={3}
              fill="white"
              style={{ opacity: 0 }}
            />
          </g>
        ))}
      </svg>
      {FACES.map((f) => {
        const slot = slots[f];
        const d = describe(slot.mapping);
        const label = d ? (d.isCategory ? `Any ${d.name}` : d.name) : "Empty face";
        return (
          <button
            key={f}
            ref={(el) => {
              plates.current[f] = el;
            }}
            onClick={() => onPick(f)}
            aria-label={compact ? `Face ${f}: ${label}` : undefined}
            className={cn(
              "absolute left-0 top-0 z-10 flex max-w-[190px] items-center gap-2 rounded-xl py-1.5 pl-1.5 text-left text-sm shadow-lg ring-1 backdrop-blur transition-[background-color,box-shadow] duration-150",
              compact ? "pr-2" : "pr-3",
              editing === f ? "bg-primary/25 ring-primary/70" : "bg-black/55 ring-white/10 hover:bg-black/70",
            )}
            style={{ opacity: 0, willChange: "transform, opacity" }}
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/10 text-default-300">
              <Pips face={f} size={14} />
            </span>
            {d ? <LiveIcon path={d.iconPath} color={d.color} size={16} verb={d.verb} play={slot.mapping ? mappingKey(slot.mapping) : undefined} /> : <Plus className="h-4 w-4 text-default-400" />}
            {!compact && (
              <span className="min-w-0">
                <span className="block truncate font-medium leading-tight">{label}</span>
                {slot.side && <span className="block text-[10px] font-semibold uppercase tracking-wider text-default-400">{slot.side === "should" ? "Should" : "Feel like"}</span>}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}

function SwapVs({ ws }: { ws: Workspace }) {
  const [spins, setSpins] = useState(0);
  return (
    <motion.button
      aria-label="Swap sides"
      onClick={() => {
        setSpins((n) => n + 1);
        ws.update({ duel: { should: ws.setup.duel.feel, feel: ws.setup.duel.should } });
      }}
      animate={{ transform: `rotate(${spins * 360}deg)` }}
      transition={{ type: "spring", duration: 0.6, bounce: 0.25 }}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-background text-xs font-black italic ring-1 ring-default-200 transition-colors duration-150 hover:ring-default-300"
    >
      VS
    </motion.button>
  );
}

/** What doesn't belong to one face: the matchup, the picks and their shares, the category and its draw, the faces. */
function Tray({ ws, onHoverFaces, onPreview }: { ws: Workspace; onHoverFaces: (f: Face[] | null) => void; onPreview: (c: string | null) => void }) {
  const mode = ws.setup.mode;
  const list = ws.setup.shortlist;
  if (mode === "duel") {
    const side = (s: "should" | "feel") => {
      const m = ws.setup.duel[s];
      const d = describe(m);
      const faces = s === "should" ? SHOULD_FACES : FEEL_FACES;
      return (
        <PickerPopover key={s} value={m} exclude={[ws.setup.duel[s === "should" ? "feel" : "should"]]} onSelect={(next) => next && ws.update({ duel: { ...ws.setup.duel, [s]: next } })}>
          {(open) => (
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={open}
              {...mouseHover(
                () => onHoverFaces(faces),
                () => onHoverFaces(null),
              )}
              className={cn(
                "group flex w-full min-w-0 items-center gap-2.5 rounded-xl py-1.5 pl-2 pr-2 text-left ring-1 transition-[box-shadow,transform] duration-150 ease-out active:scale-[0.98] md:w-auto",
                open ? "ring-2 ring-primary/70" : "ring-default-100 hover:ring-default-300",
              )}
              style={d ? { background: `linear-gradient(90deg, ${d.color}22, transparent)` } : undefined}
            >
              {d ? <LiveIcon path={d.iconPath} color={d.color} size={20} verb={d.verb} play={m ? mappingKey(m) : undefined} /> : <Plus className="h-5 w-5 shrink-0 text-default-400" />}
              {/* The chevron rides with the caption (as on Twin's cards), so the name gets the full width. */}
              <span className="min-w-0 flex-1 pr-1">
                <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-default-400">
                  {s === "should" ? "Should" : "Feel like"}
                  <ChevronDown className={cn("h-3 w-3 transition-transform duration-200 ease-out group-hover:text-foreground", open && "rotate-180")} />
                </span>
                <span className="block truncate text-sm font-semibold md:max-w-[220px]">{d ? (d.isCategory ? `Any ${d.name}` : d.name) : "Pick one"}</span>
              </span>
            </button>
          )}
        </PickerPopover>
      );
    };
    // Narrow: the two sides share the row evenly with VS between them. Wide: a row of chips under the stage.
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 md:flex md:flex-wrap">
        {side("should")}
        <SwapVs ws={ws} />
        {side("feel")}
      </div>
    );
  }
  if (mode === "shortlist") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <AnimatePresence initial={false} mode="popLayout">
          {list.items.map((m, i) => {
            const d = describe(m)!;
            const faces = FACES.filter((f) => list.faces[f] === i);
            return (
              <motion.div
                layout
                key={mappingKey(m)}
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
                transition={SPRING_POP}
                {...mouseHover(
                  () => onHoverFaces(faces),
                  () => onHoverFaces(null),
                )}
                className="group flex items-center gap-2 rounded-xl py-1.5 pl-2 pr-1.5 ring-1 ring-default-100"
                style={{ background: `linear-gradient(90deg, ${d.color}1a, transparent)` }}
              >
                <span className="h-6 w-1 rounded-full" style={{ background: d.color }} />
                <LiveIcon path={d.iconPath} color={d.color} size={18} verb={d.verb} />
                <span className="max-w-[160px] truncate text-sm">{d.isCategory ? `Any ${d.name}` : d.name}</span>
                <span className="rounded-md bg-default-100 px-1.5 text-xs text-default-500">
                  <Odometer value={faceCount(list, i)} /> {faceCount(list, i) === 1 ? "face" : "faces"}
                </span>
                <button
                  aria-label={`Remove ${d.name}`}
                  onClick={() => ws.update({ shortlist: removeItem(list, i) })}
                  className="rounded-md p-1 text-default-400 opacity-0 transition-opacity duration-150 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </motion.div>
            );
          })}
          {list.items.length < 6 && (
            <PickerPopover key="add" value={null} exclude={list.items} onSelect={(m) => m && ws.update({ shortlist: addItem(list, m) })}>
              {(open) => (
                <motion.button
                  layout
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={open}
                  className={cn(
                    "flex items-center gap-1.5 rounded-xl border border-dashed px-3 py-2.5 text-sm transition-[border-color,background-color,color] duration-150 ease-out active:scale-[0.98]",
                    open ? "border-primary/60 bg-primary/5 text-foreground" : "border-default-200 text-default-400 hover:border-default-300 hover:text-foreground",
                  )}
                >
                  <Plus className="h-4 w-4" /> Add a pick
                </motion.button>
              )}
            </PickerPopover>
          )}
        </AnimatePresence>
      </div>
    );
  }
  if (mode === "roulette") {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {CATEGORIES.map((c) => {
            const active = ws.setup.roulette === c.id;
            return (
              <button
                key={c.id}
                {...mouseHover(
                  () => onPreview(c.id),
                  () => onPreview(null),
                )}
                onClick={() => ws.update({ roulette: c.id })}
                className={cn(
                  "flex items-center gap-2 rounded-xl px-3 py-2 text-sm ring-1 transition-[background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.97]",
                  active ? "ring-transparent" : "ring-default-100 hover:bg-default-100",
                )}
                style={active ? { background: `${c.color}26`, boxShadow: `inset 0 0 0 1.5px ${c.color}` } : undefined}
              >
                <LiveIcon path={c.iconPath} color={c.color} size={18} verb={c.verb} play={active ? c.id : undefined} />
                {c.name}
              </button>
            );
          })}
        </div>
        <RoulettePool ws={ws} />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
      {FACES.map((f) => {
        const m = ws.setup.manual[f];
        const d = describe(m);
        return (
          <PickerPopover key={f} value={m} clearLabel="Leave this face empty" onSelect={(next) => ws.update({ manual: { ...ws.setup.manual, [f]: next } })}>
            {(open) => (
              <button
                type="button"
                aria-haspopup="listbox"
                aria-expanded={open}
                {...mouseHover(
                  () => onHoverFaces([f]),
                  () => onHoverFaces(null),
                )}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-xl py-1.5 pl-1.5 pr-3 text-left text-sm ring-1 transition-[box-shadow,transform] duration-150 ease-out active:scale-[0.98] md:max-w-[180px]",
                  open ? "ring-2 ring-primary/70" : "ring-default-100 hover:ring-default-300",
                )}
                style={d ? { background: `linear-gradient(90deg, ${d.color}1a, transparent)` } : undefined}
              >
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-foreground text-background">
                  <Pips face={f} size={12} />
                </span>
                {d && <LiveIcon path={d.iconPath} color={d.color} size={14} verb={d.verb} />}
                <span className={cn("truncate", !d && "text-default-400")}>{d ? (d.isCategory ? `Any ${d.name}` : d.name) : "Empty"}</span>
              </button>
            )}
          </PickerPopover>
        );
      })}
    </div>
  );
}
