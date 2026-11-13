import { cn } from "@heroui/theme";
import { Hexagon, MousePointerClick, Trash2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cssRgb } from "../../../../shared/color.ts";
import { fillsAsLine } from "../../../../shared/order.ts";
import { describeProgress } from "../../../../shared/scene.ts";
import { freeMembers } from "../../../../shared/storage.ts";
import type { ResolvedZone, Scene } from "../../../../shared/types.ts";
import { zoneTag } from "../../../../shared/zones.ts";
import { holderName } from "../../lib/control.ts";
import { zoneErrorText } from "../../lib/zone-actions.ts";
import { wallScene } from "../../lib/zones.ts";
import { type NanoleafModel, useModel } from "../../model.ts";
import { EASE_OUT, SPRING_SETTLE } from "../../motion.ts";
import { Icon } from "../Icon.tsx";
import { PanelBar } from "../PanelBar.tsx";
import { onWall, wallStatus } from "../status.ts";
import { activityStyle } from "../tint.ts";
import { AddZone, ICON_BUTTON, PersonChoice, QUIET_BUTTON } from "./WhoseZone.tsx";
import { useZoneEditing } from "./ZoneContext.ts";
import { ZONE_WORDS as W } from "./words.ts";

/** How long a note under the cards (a zone removed, a refusal) stays. */
const NOTE_MS = 6000;

const PRIMARY =
  "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-foreground px-3.5 font-medium text-background text-xs transition-transform duration-150 ease-out active:scale-[0.97]";

const PILL = {
  live: "bg-success/15 text-success",
  pinned: "bg-default-100 text-foreground",
  control: "bg-default-100 text-foreground",
  off: "bg-default-100 text-default-500",
} as const;

/** A member's name, or a stand-in for one this device hasn't heard of. */
export function memberName(model: Pick<NanoleafModel, "members">, id: string | null): string {
  return model.members.find((m) => m.id === id)?.name ?? "Someone";
}

/** Names as a sentence: "Rich", "Rich and Sam", "Rich, Sam and Alex". */
function names(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** A zone's tag colour as CSS. */
export function tagCss(zone: Pick<ResolvedZone, "position">): string {
  return cssRgb(zoneTag(zone.position));
}

/**
 * What a zone shows now: the activity in its colour, Live / Pinned / Off (claimed only while the wall shows it), who is
 * in it or why it shows the pin, and the goal as numbers and a bar of the zone's own panels. A zone with no panels
 * shows nothing, whatever its scene.
 */
function ZoneNow({ zone, scene, showing }: { zone: ResolvedZone; scene: Scene; showing: boolean }) {
  const model = useModel();
  const empty = zone.panels.length === 0;
  const name = memberName(model, zone.member);
  const activity = !empty && scene.activityId ? model.activities.find((a) => a.id === scene.activityId) : undefined;
  const style = activityStyle(scene.cssColor);
  const kind = empty ? "off" : scene.kind;
  const live = kind === "live" ? model.sessions.find((s) => `live:${s.id}` === scene.key) : undefined;
  const progress = activity && scene.progress ? describeProgress(scene.progress, activity.trackingType) : null;
  const title = empty
    ? W.noPanels
    : scene.kind === "control"
      ? `${holderName(scene.holder)} controls your wall`
      : (activity?.name ?? W.off);
  const line = empty
    ? W.emptyZone
    : live
      ? W.inIt(names(live.currentMemberIds.map((id) => memberName(model, id))), live.currentMemberIds.length > 1)
      : kind === "pinned"
        ? W.pinnedWhy(name)
        : kind === "off"
          ? W.offWhy(name)
          : null;
  const pill = kind === "live" ? W.live : kind === "pinned" ? W.pinned : kind === "control" ? "Controlled" : W.off;
  const n = fillsAsLine(zone.order) ? 1 : Math.max(zone.panels.length, 1);
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-xl transition-[filter,opacity] duration-300",
            !showing && activity && "opacity-60 grayscale",
          )}
          style={{ background: activity ? style.tile : "hsl(var(--heroui-default-100))" }}
        >
          {activity ? (
            <Icon path={activity.iconPath} color={style.solid} className="h-5 w-5" />
          ) : (
            <Hexagon className="h-4 w-4 text-default-400" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-sm">{title}</div>
          {line && <div className="truncate text-default-500 text-xs">{line}</div>}
        </div>
        {/* Live and Pinned only while the wall shows them; otherwise the line above the cards says why not. */}
        {!empty && (showing || kind === "off") && (
          <span className={cn("shrink-0 rounded-full px-2.5 py-1 font-semibold text-xs", PILL[kind])}>{pill}</span>
        )}
      </div>
      {!empty && kind !== "off" && kind !== "control" && activity && (
        <div className="space-y-1.5">
          {/* A pin shows its goal only when the setting says so; then there is nothing to say here. */}
          {(progress || !activity.goal) && (
            <div className="text-default-500 text-xs tabular-nums">
              {progress
                ? `${progress.percent}% · ${progress.currentLabel} of ${progress.targetLabel} ${progress.periodLabel}`
                : W.noGoal}
            </div>
          )}
          <PanelBar scene={scene} n={n} muted={!showing} />
        </div>
      )}
    </div>
  );
}

/**
 * What the Now card says about the wall not showing what the cards say (paused, offline, someone else driving,
 * another plugin holding it), said once, above the cards. Nothing while the wall shows them.
 */
export function WallLine() {
  const model = useModel();
  const editing = useZoneEditing();
  const shown = onWall(model);
  const scene = editing ? wallScene(editing.zones, editing.scenes, model.sessions) : null;
  if (!scene) return <div role="status" className="hidden" />;
  const status = wallStatus(model, scene);
  const text =
    scene.kind === "control"
      ? `${holderName(scene.holder)} controls your wall`
      : !shown.showing && shown.reason
        ? W.notOnWall(shown.reason)
        : null;
  // The live region stays mounted, empty while there is nothing to say, so filling it is announced.
  return (
    <div role="status" className="flex items-center gap-2 px-1 text-xs empty:hidden">
      {text && <WallLineText label={status.label} tone={status.tone} text={text} />}
    </div>
  );
}

function WallLineText({ label, tone, text }: { label: string; tone: string; text: string }) {
  return (
    <>
      <span
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 font-semibold",
          tone === "danger"
            ? "bg-danger/15 text-danger"
            : tone === "warning"
              ? "bg-warning/15 text-warning"
              : "bg-default-100 text-default-600",
        )}
      >
        {label}
      </span>
      <span className="min-w-0 text-default-600 leading-snug">{text}</span>
    </>
  );
}

/**
 * The zone cards, for a wall that more than one zone stands on: one card per zone with its tag colour, its person,
 * its panel count, what it shows now, whose it is (a single choice among its own person and the members who have no
 * zone), Choose panels and remove; then Add a zone. They replace "This wall follows" and the Now card. Nothing when
 * the wall is one zone.
 */
export function ZoneCards({ className }: { className?: string }) {
  const model = useModel();
  const editing = useZoneEditing();
  const reduced = useReducedMotion();
  const [note, setNote] = useState<{ text: string; danger: boolean } | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // A zone removed under focus: focus goes to the next card's remove button, else Add a zone, else (the wall unsplit
  // again) Split the wall. Done once the zone has gone from what stands.
  const removing = useRef<{ readonly id: string; readonly next: string | null } | null>(null);
  const standing = editing?.zones;
  useEffect(() => {
    const pending = removing.current;
    if (!pending || !standing || standing.some((zone) => zone.id === pending.id)) return;
    removing.current = null;
    // Focus still in the removed card counts as lost: it is on its way out (an exit animation keeps it a moment).
    const el = document.activeElement;
    const inRemoved = !!el?.closest(`[data-zone-card="${pending.id}"]`);
    if (el && el !== document.body && el.isConnected && !inRemoved) return;
    const selectors = [
      ...(pending.next ? [`[data-remove-zone="${pending.next}"]`] : []),
      "[data-add-zone]:not(:disabled)",
      "[data-split-wall]",
      "[data-zone-card-heading]",
    ];
    for (const selector of selectors) {
      const found = document.querySelector<HTMLElement>(selector);
      if (found) return void found.focus({ preventScroll: true });
    }
  }, [standing]);
  if (!editing?.split) return null;
  const { zones, scenes, choosing, choose } = editing;
  const showing = onWall(model).showing;
  const free = freeMembers(model.zones, model.members);

  const say = (text: string, danger: boolean) => {
    setNote({ text, danger });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(null), NOTE_MS);
  };
  const failed = (error: unknown) => say(zoneErrorText(error), true);

  const remove = (zone: ResolvedZone) => {
    const rest = zones.filter((z) => z.id !== zone.id);
    const at = zones.findIndex((z) => z.id === zone.id);
    removing.current = { id: zone.id, next: zones[at + 1]?.id ?? null };
    if (choosing === zone.id) choose(null);
    model.actions.removeZone(zone.id).then(
      () => {
        const first = rest[0];
        if (first) say(W.removed(memberName(model, first.member)), false);
      },
      (error) => {
        removing.current = null;
        failed(error);
      },
    );
  };
  const add = (member: string) => {
    model.actions.addZone(member).then((id) => {
      if (id) choose(id);
    }, failed);
  };

  return (
    <section aria-label={W.zonesLabel} data-zone-cards className={cn("space-y-3", className)}>
      <WallLine />
      <AnimatePresence initial={false} mode="popLayout">
        {zones.map((zone) => {
          const scene = scenes.find((s) => s.id === zone.id)?.scene;
          const on = choosing === zone.id;
          const name = memberName(model, zone.member);
          const tag = tagCss(zone);
          const options = model.members.filter((m) => m.id === zone.member || free.some((f) => f.id === m.id));
          return (
            <motion.article
              key={zone.id}
              data-zone-card={zone.id}
              aria-label={name}
              layout={!reduced}
              initial={{ opacity: 0, transform: reduced ? "none" : "scale(0.96)" }}
              animate={{ opacity: 1, transform: "scale(1)" }}
              exit={{
                opacity: 0,
                transform: reduced ? "none" : "scale(0.96)",
                transition: { duration: 0.14, ease: EASE_OUT },
              }}
              transition={{ ...SPRING_SETTLE, opacity: { duration: 0.2, ease: EASE_OUT } }}
              className="relative overflow-hidden rounded-2xl bg-content1 ring-1 ring-default-100 transition-shadow duration-200"
              // Always set: motion keeps a style it was given, so leaving it out wouldn't take the ring away.
              style={{ boxShadow: on ? `inset 0 0 0 2px ${tag}` : "inset 0 0 0 0px transparent" }}
            >
              <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ background: tag }} />
              <div className="flex items-center gap-2 pt-2 pr-2 pl-4">
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: tag }} />
                <h3 tabIndex={-1} data-zone-card-heading className="min-w-0 truncate font-semibold text-sm outline-none">
                  {name}
                </h3>
                <span className="shrink-0 text-default-500 text-xs tabular-nums">
                  {zone.panels.length > 0 ? W.panels(zone.panels.length) : W.noPanels}
                </span>
                <button
                  type="button"
                  className={cn(ICON_BUTTON, "ml-auto hover:text-danger")}
                  aria-label={`${W.removeZone}: ${name}`}
                  data-remove-zone={zone.id}
                  title={W.removeZone}
                  onClick={() => remove(zone)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
              {scene && <ZoneNow zone={zone} scene={scene} showing={showing} />}
              <div className="space-y-3 border-default-100 border-t px-4 py-3">
                <div className="space-y-1.5">
                  <div className="text-default-500 text-xs">{W.whose}</div>
                  <PersonChoice
                    value={zone.member}
                    options={options}
                    label={`${W.whose}: ${name}`}
                    onPick={(member) => void model.actions.giveZone(zone.id, member).catch(failed)}
                  />
                </div>
                {on ? (
                  <button type="button" className={PRIMARY} onClick={() => choose(null)}>
                    {W.done}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-choose-zone={zone.id}
                    className={QUIET_BUTTON}
                    onClick={() => choose(zone.id)}
                  >
                    <MousePointerClick className="h-4 w-4" aria-hidden />
                    {W.choosePanels}
                  </button>
                )}
              </div>
            </motion.article>
          );
        })}
      </AnimatePresence>
      <AddZone
        free={free}
        onAdd={add}
        marker="add-zone"
        className="rounded-2xl border border-default-300 border-dashed p-2"
        triggerClassName="flex h-8 w-full items-center justify-center gap-1.5 rounded-xl font-medium text-default-600 text-sm transition-[background-color,transform] duration-150 ease-out hover:bg-default-100 active:scale-[0.99] disabled:pointer-events-none disabled:opacity-40"
      />
      <p role="status" className={cn("px-1 text-xs empty:hidden", note?.danger ? "text-danger" : "text-default-500")}>
        {note?.text}
      </p>
    </section>
  );
}
