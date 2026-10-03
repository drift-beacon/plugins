import { cn } from "@heroui/theme";
import { Hexagon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useRef } from "react";
import { describeProgress } from "../../../shared/scene.ts";
import { cssRgb } from "../../../shared/color.ts";
import type { ActivityLike, ControlScene, Scene } from "../../../shared/types.ts";
import { useNow } from "../hooks/useNow.ts";
import { useScene } from "../hooks/useScene.ts";
import { holderName } from "../lib/control.ts";
import { type NanoleafModel, useModel } from "../model.ts";
import { EASE_OUT } from "../motion.ts";
import { pulseWave } from "./bar-light.ts";
import { elapsed, lightCount, panelLine } from "./format.ts";
import { Icon } from "./Icon.tsx";
import { PanelBar, useLightClock } from "./PanelBar.tsx";
import { onWall, type WallStatus, wallStatus } from "./status.ts";
import { activityStyle, tint } from "./tint.ts";

const PILL: Record<WallStatus["tone"], string> = {
  live: "bg-success/15 text-success",
  accent: "bg-default-100 text-foreground",
  muted: "bg-default-100 text-default-500",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
};

/** The pinned pulse's dot: it breathes with the wall's first panel, on the drawing's clock, not from its own mount. */
function PulseDot({ scene, color }: { scene: Scene; color: string | undefined }) {
  const reduced = useReducedMotion() ?? false;
  const dot = useRef<HTMLSpanElement>(null);
  const draw = useCallback(
    (t: number) => {
      if (dot.current) dot.current.style.opacity = pulseWave(scene, t, reduced).toFixed(3);
    },
    [scene, reduced],
  );
  useLightClock(!reduced, draw);
  return (
    <span
      ref={dot}
      className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current"
      style={color ? { background: color } : undefined}
    />
  );
}

function StatusPill({ status, scene }: { status: WallStatus; scene: Scene }) {
  const reduced = useReducedMotion();
  // A pinned pill's dot is the activity's colour; everything else uses the tone.
  const dotColor = status.tone === "accent" && scene.cssColor ? tint(scene.cssColor, 1) : undefined;
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={status.label}
        className={cn(
          "flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-2 font-semibold text-xs",
          PILL[status.tone],
        )}
        initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "scale(0.94)", filter: "blur(2px)" }}
        animate={{ opacity: 1, transform: "scale(1)", filter: "blur(0px)" }}
        exit={
          reduced
            ? { opacity: 0 }
            : {
                opacity: 0,
                transform: "scale(0.94)",
                filter: "blur(2px)",
                transition: { duration: 0.12 },
              }
        }
        transition={{ duration: 0.2, ease: EASE_OUT }}
      >
        {status.dot !== "none" && (
          <span className="relative flex h-1.5 w-1.5">
            {status.dot === "ping" && (
              <span className="absolute size-full rounded-full bg-current opacity-60 motion-safe:animate-ping" />
            )}
            {status.dot === "pulse" ? (
              <PulseDot scene={scene} color={dotColor} />
            ) : (
              <span
                className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current"
                style={dotColor ? { background: dotColor } : undefined}
              />
            )}
          </span>
        )}
        {status.label}
      </motion.span>
    </AnimatePresence>
  );
}

/** Goal text and the panel bar, with a small percentage at its right edge. */
function Progress(props: { scene: Scene; n: number; activity: ActivityLike; muted: boolean }) {
  const { scene, n, activity, muted } = props;
  const progress = scene.progress;
  if (!progress) return null;
  const copy = describeProgress(progress, activity.trackingType);
  const description =
    n > 0
      ? `${Math.round(Math.min(Math.max(progress.fraction, 0), 1) * n * 10) / 10} of ${n} panels lit. ${panelLine(progress.fraction, n)}`
      : `${copy.percent}% of goal completed`;
  return (
    <div className="mt-4">
      <div className="text-default-500 text-sm tabular-nums">
        {copy.currentLabel} of {copy.targetLabel} {copy.periodLabel}
      </div>
      <div className="mt-1.5 flex items-center gap-2.5">
        <PanelBar className="min-w-0 flex-1" scene={scene} n={Math.max(n, 1)} muted={muted} ariaLabel={description} />
        <span
          className={cn(
            "shrink-0 font-medium text-xs tabular-nums",
            progress.fraction >= 1 ? "text-success" : "text-default-500",
          )}
        >
          {copy.percent}%
        </span>
      </div>
    </div>
  );
}

/** Why there's no goal to show: the activity has none, pins hide it, or the app doesn't send goals. */
function noGoalLine(model: NanoleafModel, scene: Scene, activity: ActivityLike): string {
  if (!model.supportsGoals) return "Every panel glows in its colour.";
  if (scene.kind === "pinned" && activity.goal && !model.settings.pinnedProgress) {
    return "Goal progress is hidden for pins: turn on Show goal progress below.";
  }
  const level = scene.kind === "pinned" ? ` at ${Math.round(scene.level * 100)}%` : "";
  return `No goal on this activity, so every panel glows${level}.`;
}

interface ActivityNowProps {
  readonly model: NanoleafModel;
  readonly scene: Scene;
  readonly activity: ActivityLike;
  /** Why the wall isn't showing it, or null while it is: then the card shows it greyed and still, as what would. */
  readonly away: string | null;
}

function ActivityNow({ model, scene, activity, away }: ActivityNowProps) {
  const live = scene.kind === "live";
  const session = live ? model.sessions.find((s) => `live:${s.id}` === scene.key) : undefined;
  const now = useNow(1000, live);
  const n = lightCount(model.layout);
  const style = activityStyle(activity.color);
  const muted = away !== null;
  return (
    <>
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "grid h-12 w-12 shrink-0 place-items-center rounded-xl transition-[filter,opacity] duration-300",
            muted && "opacity-60 grayscale",
          )}
          style={{ background: style.tile }}
        >
          <Icon path={activity.iconPath} color={style.solid} className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 font-semibold text-lg leading-tight">{activity.name}</div>
        </div>
        {session && (
          <div className="shrink-0 self-center font-bold text-2xl tabular-nums leading-none" title="Running time">
            {elapsed(now - session.startedAt.getTime())}
          </div>
        )}
      </div>
      {scene.progress ? (
        <Progress scene={scene} n={n} activity={activity} muted={muted} />
      ) : (
        <div className="mt-4">
          <PanelBar
            scene={scene}
            n={Math.max(n, 1)}
            muted={muted}
            ariaLabel={`${n > 0 ? `All ${n} panels lit` : "Activity light preview"}. ${noGoalLine(model, scene, activity)}`}
          />
        </div>
      )}
    </>
  );
}

/** Another plugin or Home Assistant holds the wall: who, and the colours it plays with. */
function ControlNow({ scene, muted }: { scene: ControlScene; muted: boolean }) {
  const { effect } = scene;
  const swatches = effect.color ? [...effect.colors, effect.color] : effect.colors;
  return (
    <div className="flex items-start gap-3">
      <span
        className={cn(
          "grid h-12 w-12 shrink-0 place-items-center rounded-xl transition-[filter,opacity] duration-300",
          muted && "opacity-60 grayscale",
        )}
        style={{ background: tint(scene.cssColor, 0.15), color: tint(scene.cssColor, 1) }}
      >
        <Hexagon className="h-6 w-6" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-lg leading-tight">{holderName(scene.holder)} controls your wall</div>
        <div aria-hidden className={cn("mt-2.5 flex flex-wrap gap-1.5", muted && "opacity-60 grayscale")}>
          {swatches.map((rgb, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a palette may repeat a colour, and never reorders
              key={index}
              className="h-2.5 w-2.5 rounded-full ring-1 ring-default-200"
              style={{ background: cssRgb(rgb) }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function NothingNow({ model }: { model: NanoleafModel }) {
  const paused = !model.settings.enabled;
  const previewing = !paused && model.output?.mode === "preview" && model.output.inControl;
  const title = !model.controller
    ? "Nothing to show yet"
    : paused
      ? "Driving is paused"
      : previewing
        ? "Previewing on your wall"
        : "Nothing live or pinned";
  const body = !model.controller
    ? "Pair your Nanoleaf to get started."
    : paused
      ? "Your wall keeps its own scene."
      : previewing
        ? model.settings.idle === "off"
          ? "Your wall turns off shortly."
          : "Returns to your wall’s own scene shortly."
        : model.settings.idle === "off"
          ? "Your wall is off."
          : "Showing your wall’s own scene.";
  return (
    <div className="flex items-start gap-3">
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-default-100 text-default-400">
        <Hexagon className="h-6 w-6" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-lg leading-tight">{title}</div>
        <p className="mt-1 text-default-500 text-sm leading-snug">{body}</p>
      </div>
    </div>
  );
}

/**
 * What the wall shows now: the activity in its colour, the goal as numbers that tick each second, and a bar that
 * fills like the panels do. The wall shows it only while main drives it (`output.inControl`); otherwise the card
 * shows it greyed as what would show, with its status in the badge. A different scene swaps in with a short blurred
 * crossfade, so it reads as one card changing rather than two cards trading places.
 */
export function NowCard() {
  const model = useModel();
  const scene = useScene();
  const reduced = useReducedMotion();
  const activity = scene.activityId ? (model.activities.find((a) => a.id === scene.activityId) ?? null) : null;
  const status = wallStatus(model, scene);
  const shown = onWall(model);
  const controlled = scene.kind === "control" ? scene : null;
  const subject = activity !== null || controlled !== null;
  const away = subject && !shown.showing ? (shown.reason ?? "The plugin isn't driving it right now") : null;
  const heading = subject && away !== null ? "Would show on your wall" : "Now on your wall";
  const key = subject ? scene.key : `none-${model.settings.enabled}-${!!model.controller}`;
  const swap = {
    initial: reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(6px)", filter: "blur(2px)" },
    animate: { opacity: 1, transform: "translateY(0px)", filter: "blur(0px)" },
    exit: reduced
      ? { opacity: 0, transition: { duration: 0.12 } }
      : {
          opacity: 0,
          transform: "translateY(-4px)",
          filter: "blur(2px)",
          transition: { duration: 0.12, ease: EASE_OUT },
        },
    transition: { duration: 0.22, ease: EASE_OUT },
  };

  return (
    <section
      aria-label="What your wall shows"
      className="relative overflow-hidden rounded-2xl bg-content1 ring-1 ring-default-100"
    >
      {/* The wash follows the colour: keyed by it, so a new activity's light fades in over the old one. */}
      <AnimatePresence initial={false}>
        {activity && (
          <motion.div
            key={activity.color}
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: activityStyle(activity.color).wash }}
            initial={{ opacity: 0 }}
            animate={{ opacity: away === null ? 1 : 0.3 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: "easeInOut" }}
          />
        )}
      </AnimatePresence>
      <div className="relative flex items-center justify-between gap-3 px-4 pt-3.5">
        <span className="font-semibold text-[10px] text-default-400 uppercase tracking-wider">{heading}</span>
        <StatusPill status={status} scene={scene} />
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={key} className="relative px-4 pt-3 pb-4" {...swap}>
          {activity ? (
            <ActivityNow model={model} scene={scene} activity={activity} away={away} />
          ) : controlled ? (
            <ControlNow scene={controlled} muted={away !== null} />
          ) : (
            <NothingNow model={model} />
          )}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
