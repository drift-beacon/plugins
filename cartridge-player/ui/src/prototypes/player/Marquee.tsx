import { Button, Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { cn } from "@heroui/theme";
import { ArrowDown, Play, Ticket } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Fragment, useRef, useState } from "react";
import { activityById, CATEGORIES, categoryById, type FxCategory } from "./fixtures";
import { lastHeard, library, type LibraryItem, type Player, type SortKey, unlabelledActivities, usePlayer } from "./model";
import {
  ActivityPicker,
  ago,
  clock,
  EASE_IN_OUT,
  EASE_OUT,
  hours,
  Icon,
  SetupGuide,
  shortTag,
  SuggestionChips,
  timeOfDay,
  useNow,
} from "./shared";
import "./player.css";

/** Direction 2 — Marquee: the collection is the product. Posters in aisles, a cinema marquee for what's showing. */
export function Marquee() {
  const player = usePlayer();
  const [filter, setFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("played");
  const pickerRef = useRef<HTMLDivElement>(null);
  const items = library(player.state, sort);
  const { state } = player;
  const newTag = state.phase === "unknown" ? state.slot!.tag : null;

  const aisles = CATEGORIES.map((c) => ({ category: c, items: items.filter((i) => i.activity?.categoryId === c.id) }))
    .filter((a) => a.items.length > 0 && (!filter || a.category.id === filter));
  const missing = items.filter((i) => i.missing);

  return (
    <div className="space-y-8">
      <MarqueeBanner
        player={player}
        onLabel={() => {
          pickerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
          pickerRef.current?.querySelector("input")?.focus();
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip active={!filter} onClick={() => setFilter(null)} label="All" count={items.length} />
          {CATEGORIES.map((c) => {
            const count = items.filter((i) => i.activity?.categoryId === c.id).length;
            return count ? (
              <FilterChip key={c.id} active={filter === c.id} onClick={() => setFilter(c.id)} label={c.name} count={count} color={c.color} />
            ) : null;
          })}
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-full bg-content1 px-3 py-1.5 text-xs text-default-600 outline-none"
          >
            <option value="played">Most played</option>
            <option value="recent">Recently shown</option>
            <option value="name">A–Z</option>
          </select>
          <BoxOffice player={player} />
        </div>
      </div>

      <LayoutGroup>
        <AnimatePresence initial={false}>
          {newTag && (
            <motion.section
              key="arrivals"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
              className="space-y-3"
            >
              <AisleSign label="New arrivals" color="#fbbf24" />
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                <NewRelease tag={newTag} player={player} pickerRef={pickerRef} />
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {/* One flowing shelf: category dividers sit in the flow like the plastic tabs in a video store. */}
        <div className="flex flex-wrap gap-x-3 gap-y-5">
          {[
            ...aisles.map(({ category, items: aisleItems }) => ({ id: category.id, label: category.name, color: category.color, items: aisleItems })),
            ...(!filter && missing.length ? [{ id: "lost", label: "Lost property", color: "#71717a", items: missing }] : []),
          ].map((group) => (
            <Fragment key={group.id}>
              {/* The divider travels with its first cover, so a tab never ends a row on its own. */}
              <div className="flex gap-3">
                <ShelfDivider label={group.label} color={group.color} count={group.items.length} />
                <Poster item={group.items[0]} player={player} index={0} />
              </div>
              {group.items.slice(1).map((item, i) => (
                <Poster key={item.tag} item={item} player={player} index={i + 1} />
              ))}
            </Fragment>
          ))}
        </div>
      </LayoutGroup>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The marquee                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

type BulbMode = "off" | "chase" | "flash" | "alternate";

function Bulbs({ mode }: { mode: BulbMode }) {
  const row = (count: number, side: string) =>
    Array.from({ length: count }, (_, i) => (
      <span
        key={`${side}-${i}`}
        className={cn(
          "h-1.5 w-1.5 rounded-full bg-[#ffd08a] transition-opacity duration-500",
          mode === "off" && "opacity-20",
          mode === "chase" && "cp-bulb",
          mode === "flash" && "cp-blink",
          mode === "alternate" && "cp-blink-slow",
        )}
        style={{
          boxShadow: mode === "off" ? "none" : "0 0 6px 1px rgb(255 190 100 / 0.75)",
          animationDelay: mode === "chase" ? `${(i % 3) * 300}ms` : mode === "alternate" ? `${(i % 2) * 550}ms` : undefined,
        }}
      />
    ));
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className="absolute inset-x-5 top-2.5 flex justify-between">{row(44, "t")}</div>
      <div className="absolute inset-x-5 bottom-2.5 flex justify-between">{row(44, "b")}</div>
      <div className="absolute inset-y-6 left-2.5 flex flex-col justify-between">{row(7, "l")}</div>
      <div className="absolute inset-y-6 right-2.5 flex flex-col justify-between">{row(7, "r")}</div>
    </div>
  );
}

function MarqueeBanner({ player, onLabel }: { player: Player; onLabel: () => void }) {
  const { state } = player;
  const tag = state.slot?.tag;
  const activity = tag ? activityById(state.mappings[tag]) : null;
  useNow(1000, state.phase === "playing");

  const view = (() => {
    switch (state.phase) {
      case "playing":
        return { mode: "chase" as const, eyebrow: "Now showing", title: activity!.name, lit: true };
      case "reading":
        return { mode: "flash" as const, eyebrow: "Loading the reel", title: "· · ·", lit: false };
      case "unknown":
        return { mode: "alternate" as const, eyebrow: "New release", title: "Untitled", lit: true };
      case "orphan":
        return { mode: "alternate" as const, eyebrow: "Missing title", title: "Unknown", lit: false };
      case "ready":
        return { mode: "chase" as const, eyebrow: "Ready to show", title: activity!.name, lit: true };
      case "parked":
        return { mode: "off" as const, eyebrow: "In the player", title: activity!.name, lit: true };
      default:
        return { mode: "off" as const, eyebrow: "Intermission", title: "Insert a cartridge", lit: false };
    }
  })();

  const last = state.phase === "empty" && state.lastEject ? state.lastEject : null;

  return (
    <section
      className="relative overflow-hidden rounded-3xl border border-[#ffbe6e]/15 px-8 pb-9 pt-10"
      style={{ background: "radial-gradient(ellipse 80% 120% at 50% 0%, #2a1609, #120b07 70%)" }}
    >
      <Bulbs mode={view.mode} />
      <div className="relative grid items-end gap-6 md:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.35em] text-[#ffbe6e]">
            <Ticket className="h-3.5 w-3.5" /> {view.eyebrow}
          </div>
          <div
            className={cn(
              "mt-3 inline-block max-w-full rounded-lg px-4 py-2 transition-colors duration-300",
              view.lit ? "bg-[#f4ead6] text-[#1a1410]" : "bg-[#f4ead6]/10 text-[#f4ead6]/40",
            )}
            style={view.lit ? { boxShadow: "0 0 40px rgb(255 214 150 / 0.18)" } : undefined}
          >
            <LetterBoard text={view.title} />
          </div>
          <div className="mt-3 min-h-5 text-sm text-[#f4ead6]/60">
            {state.phase === "playing" && state.session && (
              <>
                {categoryById(activity?.categoryId)?.name} · since {timeOfDay(state.session.startedAt)} · cartridge{" "}
                <span className="font-mono text-xs">{shortTag(state.session.tag)}</span>
              </>
            )}
            {state.phase === "unknown" && "A blank cartridge. Give it a title while it's in the player."}
            {state.phase === "orphan" && "This cartridge's activity was deleted. Pick a new title for it below."}
            {state.phase === "ready" && "Titled. It's still in the player, so the show can start now."}
            {state.phase === "parked" && "Not showing. It starts by itself the next time it goes in."}
            {state.phase === "empty" &&
              (last ? `Last show: ${activityById(last.activityId)?.name} · ${hours(last.minutes)}` : "Slide a cartridge in to start tracking.")}
          </div>
        </div>

        <div className="flex flex-col items-start gap-3 md:items-end">
          {state.phase === "playing" && state.session && <Runtime ms={Date.now() - state.session.startedAt} />}
          {state.phase === "unknown" && (
            <Button radius="full" className="bg-[#ffbe6e] font-semibold text-[#1a1410]" endContent={<ArrowDown className="h-4 w-4" />} onPress={onLabel}>
              Give it a title
            </Button>
          )}
          {(state.phase === "ready" || state.phase === "parked") && (
            <div className="flex gap-2">
              <Button radius="full" className="bg-[#ffbe6e] font-semibold text-[#1a1410]" startContent={<Play className="h-4 w-4" />} onPress={player.start}>
                Start the show
              </Button>
              {state.phase === "ready" && (
                <Button radius="full" variant="bordered" className="border-[#f4ead6]/20 text-[#f4ead6]/80" onPress={player.park}>
                  Later
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Marquee letters go up one at a time when the bill changes (occasional, so it earns a stagger). */
function LetterBoard({ text }: { text: string }) {
  const long = text.length > 22;
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={text}
        exit={{ opacity: 0, transform: "translateY(-12%)", transition: { duration: 0.15, ease: EASE_OUT } }}
        className={cn(
          "font-black uppercase leading-[0.95] tracking-[0.04em]",
          long ? "text-2xl md:text-3xl" : "text-4xl md:text-5xl",
        )}
        aria-label={text}
      >
        {text.split(" ").map((word, w, words) => (
          <span key={w} className="inline-block whitespace-nowrap">
            {[...word].map((ch, i) => {
              const index = words.slice(0, w).join(" ").length + i;
              return (
                <motion.span
                  key={i}
                  aria-hidden
                  className="inline-block"
                  initial={{ opacity: 0, transform: "translateY(45%)" }}
                  animate={{ opacity: 1, transform: "translateY(0%)" }}
                  transition={{ duration: 0.22, ease: EASE_OUT, delay: Math.min(index * 0.02, 0.35) }}
                >
                  {ch}
                </motion.span>
              );
            })}
            {w < words.length - 1 && <span>&nbsp;</span>}
          </span>
        ))}
      </motion.div>
    </AnimatePresence>
  );
}

/** Runtime on backlit tiles. It ticks every second, so the digits never animate. */
function Runtime({ ms }: { ms: number }) {
  return (
    <div className="text-right">
      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.3em] text-[#ffbe6e]/70">Runtime</div>
      <div className="flex gap-1 font-mono text-3xl font-bold tabular-nums text-[#ffcf8f]">
        {[...clock(ms)].map((ch, i) =>
          ch === ":" ? (
            <span key={i} className="px-0.5 text-[#ffcf8f]/50">
              :
            </span>
          ) : (
            <span key={i} className="grid w-8 place-items-center rounded-md border border-[#ffbe6e]/15 bg-black/40 py-1">
              {ch}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The collection                                                                                               */
/* ------------------------------------------------------------------------------------------------------------ */

function FilterChip({ active, onClick, label, count, color }: { active: boolean; onClick: () => void; label: string; count: number; color?: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "cp-press flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition-colors duration-150",
        active ? "bg-foreground text-background" : "bg-content1 text-default-600 hover:text-foreground",
      )}
    >
      {color && <span className="h-2 w-2 rounded-full" style={{ background: color }} />}
      {label}
      <span className={active ? "text-background/60" : "text-default-400"}>{count}</span>
    </button>
  );
}

function ShelfDivider({ label, color, count }: { label: string; color: string; count: number }) {
  return (
    <motion.div
      layout="position"
      transition={{ layout: { duration: 0.35, ease: EASE_IN_OUT } }}
      className="relative flex h-[237px] w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-content1"
    >
      <span className="absolute inset-x-0 top-0 h-1.5" style={{ background: color }} />
      <span className="rotate-180 text-[11px] font-bold uppercase tracking-[0.25em] text-default-500 [writing-mode:vertical-rl]">
        {label} · {count}
      </span>
    </motion.div>
  );
}

function AisleSign({ label, color }: { label: string; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="h-3.5 w-1 rounded-full" style={{ background: color }} />
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-default-500">{label}</h3>
      <span className="h-px flex-1 bg-default-100" />
    </div>
  );
}

const posterMove = { layout: { duration: 0.35, ease: EASE_IN_OUT } };

function posterBackground(category: FxCategory | null, color: string | undefined) {
  if (!color) return "linear-gradient(160deg, #3f3f46, #18181b)";
  return `radial-gradient(120% 80% at 50% 30%, ${color} 0%, ${color}cc 35%, ${category ? "#0b0b0e" : "#000"} 110%)`;
}

function Poster({ item, player, index }: { item: LibraryItem; player: Player; index: number }) {
  const { activity } = item;
  const category = categoryById(activity?.categoryId);
  const fresh = player.state.fresh === item.tag;
  const title = activity?.name ?? "Missing title";

  return (
    <motion.div
      layoutId={`poster-${item.tag}`}
      transition={{ ...posterMove, default: { duration: 0.3, ease: EASE_OUT, delay: Math.min(index, 6) * 0.04 } }}
      initial={fresh ? false : { opacity: 0, transform: "translateY(8px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
    >
      {/* The lift lives on an inner element: Motion owns the outer one's transform. */}
      <div className="cp-lift group relative w-[158px]">
      <div
        className={cn(
          "relative aspect-[2/3] overflow-hidden rounded-xl ring-1 ring-white/10",
          item.live && "ring-2 ring-[#ffbe6e]",
          item.missing && "grayscale",
        )}
        style={{
          background: posterBackground(category, activity?.color),
          boxShadow: item.live ? "0 0 36px -6px rgb(255 190 110 / 0.55)" : "0 16px 30px -18px rgb(0 0 0 / 0.9)",
        }}
      >
        {/* halftone, fading in toward the bottom like a printed cover */}
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage: "radial-gradient(circle at 1px 1px, rgb(0 0 0 / 0.55) 1px, transparent 1.4px)",
            backgroundSize: "6px 6px",
            maskImage: "linear-gradient(to bottom, transparent 15%, black 75%)",
          }}
        />
        <div className="absolute inset-x-3 top-3 flex justify-between text-[10px] font-bold uppercase tracking-[0.18em] text-white/80">
          <span>{category?.name ?? "Lost"}</span>
        </div>
        {activity ? (
          <div className="absolute inset-x-0 top-[18%] flex justify-center">
            <div className={item.live ? "cp-float" : undefined}>
              <Icon path={activity.iconPath} className="h-20 w-20 text-white drop-shadow-[0_6px_14px_rgba(0,0,0,0.45)]" />
            </div>
          </div>
        ) : (
          <div className="absolute inset-x-0 top-[26%] text-center text-5xl font-black text-white/25">?</div>
        )}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/50 to-transparent p-3 pt-10">
          <div className="line-clamp-3 text-[17px] font-black uppercase leading-[1.02] tracking-tight text-white">{title}</div>
          <div className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/60">
            {item.missing
              ? "Activity deleted"
              : item.plays
                ? `${item.plays} shows · ${hours(item.minutes)} · ${ago(item.lastSeen)}`
                : "Never shown"}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span
              className="h-3 w-14"
              style={{ background: "repeating-linear-gradient(90deg, #fff 0 1px, transparent 1px 3px, #fff 3px 5px, transparent 5px 6px, #fff 6px 7px, transparent 7px 9px)", opacity: 0.55 }}
            />
            <span className="font-mono text-[9px] text-white/45">{shortTag(item.tag)}</span>
          </div>
        </div>

        {item.inSlot && (
          <motion.span
            initial={{ opacity: 0, transform: "rotate(45deg) scale(0.9)" }}
            animate={{ opacity: 1, transform: "rotate(45deg) scale(1)" }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
            className={cn(
              "absolute -right-9 top-5 w-36 py-1 text-center text-[9px] font-black uppercase tracking-[0.2em] shadow",
              item.live ? "bg-[#ffbe6e] text-[#1a1410]" : "bg-default-200 text-foreground",
            )}
          >
            {item.live ? "Now showing" : "In the player"}
          </motion.span>
        )}

        {/* A freshly titled cover develops from the bottom up, once. */}
        {fresh && (
          <motion.div
            className="absolute inset-0 bg-[#f3ead6]"
            initial={{ clipPath: "inset(0 0 0 0)" }}
            animate={{ clipPath: "inset(0 0 100% 0)" }}
            transition={{ duration: 0.6, ease: EASE_OUT, delay: 0.35 }}
          />
        )}
        {fresh && <span className="cp-shine" style={{ animationDelay: "900ms" }} />}

        {/* Hover/focus reveals the counter: retitle or forget. */}
        <div className="absolute inset-x-2 bottom-2 flex translate-y-[130%] gap-1.5 opacity-0 transition-[transform,opacity] duration-200 ease-out group-focus-within:translate-y-0 group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-hover:opacity-100">
          <Popover placement="top" offset={10}>
            <PopoverTrigger>
              <button className="cp-press flex-1 rounded-lg bg-black/70 py-1.5 text-xs font-medium text-white backdrop-blur hover:bg-black/85">
                Retitle
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-3">
              <ActivityPicker
                size="sm"
                label="Title"
                openOnFocus
                value={activity?.id ?? null}
                onChange={(id) => id && id !== activity?.id && player.relabel(item.tag, id)}
              />
            </PopoverContent>
          </Popover>
          <Popover placement="top" offset={10}>
            <PopoverTrigger>
              <button
                disabled={item.inSlot}
                className="cp-press rounded-lg bg-black/70 px-2.5 py-1.5 text-xs font-medium text-white backdrop-blur hover:bg-black/85 disabled:opacity-40"
              >
                Forget
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-60 p-3">
              <div className="space-y-2 text-xs">
                <p>Forget “{title}”? Next time it goes in, the player treats it as blank.</p>
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" color="danger" onPress={() => player.forget(item.tag)}>
                    Forget
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      </div>
    </motion.div>
  );
}

function NewRelease({ tag, player, pickerRef }: { tag: string; player: Player; pickerRef: React.RefObject<HTMLDivElement | null> }) {
  const suggestions = unlabelledActivities(player.state);
  return (
    <motion.div layoutId={`poster-${tag}`} transition={posterMove} className="col-span-2 sm:col-span-3 lg:col-span-3">
      <div className="flex gap-4 rounded-xl border border-dashed border-[#ffbe6e]/40 bg-[#ffbe6e]/5 p-3">
        <div
          className="relative aspect-[2/3] w-32 shrink-0 overflow-hidden rounded-lg"
          style={{ background: "repeating-linear-gradient(135deg, #2a2520 0 10px, #221e1a 10px 20px)" }}
        >
          <span className="cp-wiggle absolute left-2 top-3 -rotate-6 rounded bg-[#fbbf24] px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#1a1410]">
            New release
          </span>
          <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-4xl font-black text-white/15">?</span>
          <span className="absolute inset-x-2 bottom-2 font-mono text-[9px] text-white/40">{tag}</span>
        </div>
        <div ref={pickerRef} className="flex min-w-0 flex-1 flex-col justify-center gap-3">
          <div>
            <div className="font-semibold">What's showing on this one?</div>
            <p className="text-sm text-default-500">Leave it in the player while you title it.</p>
          </div>
          {suggestions.length > 0 && <SuggestionChips activities={suggestions} onPick={(id) => player.label(tag, id)} />}
          <ActivityPicker size="sm" placeholder="Search every activity" onChange={(id) => id && player.label(tag, id)} />
        </div>
      </div>
    </motion.div>
  );
}

function BoxOffice({ player }: { player: Player }) {
  const heard = lastHeard(player.state);
  return (
    <Popover placement="bottom-end" offset={8}>
      <PopoverTrigger>
        <button className="cp-press flex items-center gap-2 rounded-full bg-content1 px-3 py-1.5 text-xs text-default-600 hover:text-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-success" /> Player · {ago(heard)}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4">
        <div className="w-full space-y-3">
          <div>
            <div className="font-medium">The box office</div>
            <p className="text-xs text-default-500">Connect a player in three fields.</p>
          </div>
          <SetupGuide />
        </div>
      </PopoverContent>
    </Popover>
  );
}
