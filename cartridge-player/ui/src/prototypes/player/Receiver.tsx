import { Accordion, AccordionItem, Button } from "@heroui/react";
import { cn } from "@heroui/theme";
import { Pencil, Play, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { activityById, categoryById } from "./fixtures";
import { lastHeard, library, type LibraryItem, type LogEntry, type Player, type PlayerState, type SortKey, unlabelledActivities, usePlayer } from "./model";
import {
  ActivityPicker,
  ago,
  clock,
  EASE_OUT,
  hours,
  Icon,
  SetupGuide,
  SuggestionChips,
  timeOfDay,
  useNow,
} from "./shared";
import "./player.css";

const VFD = "#72f7cf";
const glow = { color: VFD, textShadow: "0 0 6px rgb(114 247 207 / 0.6), 0 0 18px rgb(114 247 207 / 0.22)" };
const ghost = { color: "rgb(114 247 207 / 0.08)" };

/** Direction 3 — Receiver: a hi-fi front panel. A VFD says what the player is doing; a tape index lists the rest. */
export function Receiver() {
  const player = usePlayer();
  const [sort, setSort] = useState<SortKey>("recent");

  return (
    <div className="space-y-4">
      <Display state={player.state} />
      <AnimatePresence initial={false} mode="wait">
        <Controls key={`${player.state.phase}-${player.state.slot?.tag ?? ""}`} player={player} />
      </AnimatePresence>
      <TapeIndex player={player} sort={sort} onSort={setSort} />
      <Accordion variant="splitted" className="px-0" itemClasses={{ base: "!bg-content1 !shadow-none", title: "text-sm", subtitle: "text-xs" }}>
        <AccordionItem key="setup" aria-label="Player setup" title="Rear panel · player setup" subtitle={`Last heard ${ago(lastHeard(player.state))}`}>
          <SetupGuide className="pb-2" />
        </AccordionItem>
      </Accordion>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The display                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

function Display({ state }: { state: PlayerState }) {
  useNow(1000, state.phase === "playing");
  const tag = state.slot?.tag;
  const activity = tag ? activityById(state.mappings[tag]) : null;

  const line = (() => {
    switch (state.phase) {
      case "playing":
        return { label: "Tracking", text: activity!.name };
      case "reading":
        return { label: "Reading tag", text: "Reading" };
      case "unknown":
        return { label: "New cartridge", text: "Label it below" };
      case "orphan":
        return { label: "Activity missing", text: "Relabel" };
      case "ready":
        return { label: "Labelled", text: activity!.name };
      case "parked":
        return { label: "In slot · idle", text: activity!.name };
      default:
        return { label: "Standby", text: "No cartridge" };
    }
  })();

  const lamps = [
    { label: "NFC", on: state.phase === "reading", blink: true },
    { label: "Link", on: true },
    { label: "Cart", on: !!state.slot },
    { label: "Rec", on: state.phase === "playing", breathe: true },
    { label: "New", on: state.phase === "unknown", blink: true },
  ];

  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-[#1c2f29] px-6 pb-5 pt-4 font-mono uppercase"
      style={{
        background: "radial-gradient(120% 160% at 25% 0%, #0f201b 0%, #050c0a 65%)",
        boxShadow: "inset 0 2px 24px rgb(0 0 0 / 0.85), 0 20px 40px -24px rgb(0 0 0 / 0.9)",
      }}
    >
      {/* scanlines and a glass reflection: the panel reads as a window onto a tube */}
      <div className="pointer-events-none absolute inset-0 opacity-60" style={{ background: "repeating-linear-gradient(0deg, rgb(0 0 0 / 0.28) 0 1px, transparent 1px 3px)" }} />
      <div className="pointer-events-none absolute inset-0" style={{ background: "linear-gradient(165deg, rgb(255 255 255 / 0.05), transparent 35%)" }} />

      <div className="relative flex items-center gap-4 text-[10px] tracking-[0.2em]">
        {lamps.map((lamp) => (
          <span key={lamp.label} className="flex items-center gap-1.5" style={lamp.on ? glow : ghost}>
            <span
              className={cn("h-1.5 w-1.5 rounded-full", lamp.on && lamp.blink && "cp-blink", lamp.on && lamp.breathe && "cp-breathe")}
              style={{ background: lamp.on ? VFD : "rgb(114 247 207 / 0.1)", boxShadow: lamp.on ? `0 0 6px ${VFD}` : undefined }}
            />
            {lamp.label}
          </span>
        ))}
        <span className="ml-auto" style={ghost}>
          ch 01
        </span>
      </div>

      <div className="relative mt-4 grid items-end gap-6 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={line.label + line.text}
              initial={{ opacity: 0, filter: "blur(2px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(2px)" }}
              transition={{ duration: 0.18, ease: EASE_OUT }}
            >
              <div className="text-[11px] tracking-[0.3em]" style={glow}>
                {line.label}
                {state.phase === "reading" && <ReadingBar />}
              </div>
              <VfdText text={line.text} />
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="relative text-right text-5xl tabular-nums tracking-[0.06em]">
          <span className="absolute inset-0" style={ghost} aria-hidden>
            88:88:88
          </span>
          <span className="relative" style={state.phase === "playing" ? glow : ghost}>
            {state.phase === "playing" && state.session ? clock(Date.now() - state.session.startedAt) : "--:--:--"}
          </span>
        </div>
      </div>

      <div className="relative mt-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2 text-[10px] tracking-[0.18em]">
        <div className="flex flex-wrap gap-x-5" style={{ color: "rgb(114 247 207 / 0.55)" }}>
          <span>tag {tag ?? "—"}</span>
          {state.session && <span>since {timeOfDay(state.session.startedAt)}</span>}
          {state.session && <span>play {String(state.stats[state.session.tag]?.plays ?? 0).padStart(3, "0")}</span>}
        </div>
        <EventLog log={state.log} />
      </div>
    </section>
  );
}

/** Long titles scroll across the tube like a real VFD; reduced motion truncates them instead. */
function VfdText({ text }: { text: string }) {
  const long = text.length > 20;
  return (
    <div className="mt-1 overflow-hidden whitespace-nowrap text-[34px] leading-tight tracking-[0.12em]" style={glow}>
      {long ? (
        <div className="vfd-scroll inline-flex">
          <span className="pr-16">{text}</span>
          <span className="pr-16" aria-hidden>
            {text}
          </span>
        </div>
      ) : (
        text
      )}
      <style>{`
        @keyframes vfd-scroll { from { transform: translateX(0) } to { transform: translateX(-50%) } }
        .vfd-scroll { animation: vfd-scroll 14s linear 1.2s infinite; }
        @media (prefers-reduced-motion: reduce) {
          .vfd-scroll { animation: none; display: block; }
          .vfd-scroll span + span { display: none; }
          .vfd-scroll span { display: block; overflow: hidden; text-overflow: ellipsis; padding-right: 0; }
        }
      `}</style>
    </div>
  );
}

function ReadingBar() {
  return (
    <span className="ml-3 inline-flex gap-1 align-middle">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="cp-blink inline-block h-2 w-3" style={{ background: VFD, animationDelay: `${i * 84}ms` }} />
      ))}
    </span>
  );
}

const LOG_GLYPH: Record<LogEntry["kind"], string> = {
  insert: "▶",
  start: "▶",
  eject: "■",
  new: "+",
  label: "✎",
  relabel: "✎",
  forget: "×",
};

function EventLog({ log }: { log: LogEntry[] }) {
  return (
    <ol className="min-w-[260px] space-y-0.5 text-right">
      <AnimatePresence initial={false}>
        {log.slice(0, 3).map((e, i) => {
          const activity = activityById(e.activityId);
          const what =
            e.kind === "new"
              ? "blank cartridge"
              : e.kind === "forget"
                ? `forgot ${activity?.name ?? "cartridge"}`
                : `${activity?.name ?? "deleted activity"}${e.kind === "eject" && e.minutes ? ` · ${hours(e.minutes)}` : ""}`;
          return (
            <motion.li
              key={e.id}
              layout="position"
              initial={{ opacity: 0, transform: "translateY(-6px)" }}
              animate={{ opacity: 1 - i * 0.28, transform: "translateY(0px)" }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: EASE_OUT }}
              className="truncate"
              style={{ color: VFD }}
            >
              {timeOfDay(e.at)} {LOG_GLYPH[e.kind]} {what}
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Controls under the display, only when the player needs something                                              */
/* ------------------------------------------------------------------------------------------------------------ */

function Controls({ player }: { player: Player }) {
  const { state } = player;
  const tag = state.slot?.tag;
  const activity = tag ? activityById(state.mappings[tag]) : null;
  if (!tag || !["unknown", "orphan", "ready", "parked"].includes(state.phase)) return null;

  return (
    <motion.div
      initial={{ opacity: 0, transform: "translateY(-6px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
      className="rounded-2xl border border-[#72f7cf]/15 bg-content1 p-4"
    >
      {(state.phase === "unknown" || state.phase === "orphan") && (
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="shrink-0 md:w-56">
            <div className="text-sm font-medium">{state.phase === "unknown" ? "Label this cartridge" : "Relabel this cartridge"}</div>
            <div className="text-xs text-default-500">
              {state.phase === "unknown" ? "Keep it in the player until it's labelled." : "Its activity was deleted."}
            </div>
          </div>
          <ActivityPicker
            autoFocus
            size="sm"
            className="md:max-w-xs"
            placeholder="Type an activity…"
            onChange={(id) => id && (state.phase === "unknown" ? player.label(tag, id) : player.relabel(tag, id))}
          />
          {state.phase === "unknown" && (
            <SuggestionChips activities={unlabelledActivities(state).slice(0, 4)} onPick={(id) => player.label(tag, id)} />
          )}
        </div>
      )}
      {(state.phase === "ready" || state.phase === "parked") && (
        <div className="flex flex-wrap items-center gap-3">
          <Icon path={activity!.iconPath} color={activity!.color} className="h-5 w-5" />
          <div className="mr-auto text-sm">
            <span className="font-medium">{activity!.name}</span>
            <span className="text-default-500">
              {state.phase === "ready" ? " is labelled and still in the player." : " is in the player, not tracking."}
            </span>
          </div>
          <Button size="sm" color="primary" startContent={<Play className="h-3.5 w-3.5" />} onPress={player.start}>
            Start tracking
          </Button>
          {state.phase === "ready" && (
            <Button size="sm" variant="flat" onPress={player.park}>
              Later
            </Button>
          )}
        </div>
      )}
    </motion.div>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The tape index                                                                                               */
/* ------------------------------------------------------------------------------------------------------------ */

const COLS = "grid-cols-[34px_minmax(0,1.7fr)_minmax(0,1.1fr)_128px_minmax(0,1fr)_64px] max-md:grid-cols-[28px_minmax(0,1fr)_96px_64px]";

function TapeIndex({ player, sort, onSort }: { player: Player; sort: SortKey; onSort: (k: SortKey) => void }) {
  const items = library(player.state, sort);
  const max = Math.max(1, ...items.map((i) => i.minutes));
  const head = (key: SortKey | null, label: string, className?: string) =>
    key ? (
      <button onClick={() => onSort(key)} className={cn("text-left uppercase transition-colors duration-150 hover:text-foreground", sort === key && "text-foreground", className)}>
        {label}
        {sort === key && " ↓"}
      </button>
    ) : (
      <span className={className}>{label}</span>
    );

  return (
    <section className="overflow-hidden rounded-2xl border border-default-100">
      <div className={cn("grid items-center gap-3 bg-content1 px-4 py-2.5 text-[11px] uppercase tracking-wider text-default-400", COLS)}>
        {head(null, "#")}
        {head("name", "Cartridge")}
        {head(null, "Tag", "max-md:hidden")}
        {head("recent", "Last played")}
        {head("played", "Tracked", "max-md:hidden")}
        <span />
      </div>
      <ol>
        <AnimatePresence initial={false}>
          {items.map((item, i) => (
            <Row key={item.tag} item={item} index={i} max={max} player={player} />
          ))}
        </AnimatePresence>
      </ol>
    </section>
  );
}

function Row({ item, index, max, player }: { item: LibraryItem; index: number; max: number; player: Player }) {
  const [mode, setMode] = useState<"view" | "relabel" | "forget">("view");
  const fresh = player.state.fresh === item.tag;
  const { activity } = item;

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={{ layout: { duration: 0.3, ease: EASE_OUT }, opacity: { duration: 0.2 } }}
      className={cn(
        "group relative grid items-center gap-3 border-t border-default-100 px-4 py-2.5 text-sm transition-colors duration-150 hover:bg-default-50",
        COLS,
        item.inSlot && "bg-[#72f7cf]/[0.04]",
      )}
    >
      {item.inSlot && <span className="absolute inset-y-0 left-0 w-0.5" style={{ background: VFD, boxShadow: `0 0 8px ${VFD}` }} />}
      {fresh && (
        <motion.span
          className="pointer-events-none absolute inset-0"
          style={{ background: "rgb(114 247 207 / 0.16)" }}
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 1.4, ease: EASE_OUT, delay: 0.2 }}
        />
      )}
      <span className="font-mono text-xs text-default-400">
        {item.live ? <span className="cp-breathe inline-block h-2 w-2 rounded-full" style={{ background: VFD, boxShadow: `0 0 6px ${VFD}` }} /> : String(index + 1).padStart(2, "0")}
      </span>

      <div className="min-w-0">
        {mode === "relabel" ? (
          <ActivityPicker
            autoFocus
            openOnFocus
            size="sm"
            aria-label="Relabel"
            placeholder={activity ? `${activity.name} → type a new label` : "Type an activity…"}
            onChange={(id) => {
              if (id && id !== activity?.id) player.relabel(item.tag, id);
              setMode("view");
            }}
          />
        ) : activity ? (
          <div className="flex min-w-0 items-center gap-2.5">
            <Icon path={activity.iconPath} color={activity.color} className="h-4 w-4 shrink-0" />
            <span className="truncate">{activity.name}</span>
            <span className="hidden shrink-0 text-xs text-default-400 lg:inline">{categoryById(activity.categoryId)?.name}</span>
          </div>
        ) : (
          <button onClick={() => setMode("relabel")} className="text-left text-danger hover:underline">
            Activity deleted · relabel
          </button>
        )}
      </div>

      <span className="truncate font-mono text-[11px] text-default-400 max-md:hidden">{item.tag}</span>
      <span className="text-xs text-default-500">{item.inSlot ? "In the player" : ago(item.lastSeen)}</span>

      <div className="flex items-center gap-2 max-md:hidden">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-default-100">
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.max(item.minutes ? 3 : 0, (item.minutes / max) * 100)}%`, background: activity?.color ?? "#71717a" }}
          />
        </div>
        <span className="w-12 text-right text-xs tabular-nums text-default-500">{item.minutes ? hours(item.minutes) : "—"}</span>
      </div>

      <div className="flex justify-end gap-0.5">
        {mode === "forget" ? (
          <div className="absolute inset-y-1 right-2 flex items-center gap-2 rounded-lg bg-content2 px-3 text-xs shadow">
            Forget? It'll read as blank next time.
            <Button size="sm" color="danger" variant="flat" onPress={() => player.forget(item.tag)}>
              Forget
            </Button>
            <Button size="sm" variant="light" onPress={() => setMode("view")}>
              Keep
            </Button>
          </div>
        ) : (
          <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100">
            <button aria-label="Relabel" onClick={() => setMode(mode === "relabel" ? "view" : "relabel")} className="cp-press grid h-7 w-7 place-items-center rounded-md text-default-500 hover:bg-default-100 hover:text-foreground">
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              aria-label="Forget"
              disabled={item.inSlot}
              title={item.inSlot ? "Take it out of the player first" : undefined}
              onClick={() => setMode("forget")}
              className="cp-press grid h-7 w-7 place-items-center rounded-md text-default-500 hover:bg-default-100 hover:text-danger disabled:opacity-30"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </motion.li>
  );
}
