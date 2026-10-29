import { cn } from "@heroui/theme";
import { Hash, Play, RotateCcw, RotateCw, Square } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { placeLayout } from "../../../../shared/geometry.ts";
import { fillSpans, fillsAsLine, resolveOrder } from "../../../../shared/order.ts";
import { orderSweepMs } from "../../../../shared/render.ts";
import type { AutoOrder, OrderMode, PanelOrder, PlacedPanel, SweepFill } from "../../../../shared/types.ts";
import { setDrafting, useDrawnLight } from "../../hooks/useDrawnLight.ts";
import { useRenderState } from "../../hooks/useRenderState.ts";
import { useScene } from "../../hooks/useScene.ts";
import { useWallPreview } from "../../hooks/useWallPreview.ts";
import { accentRgb } from "../../lib/color.ts";
import { nextSeed, panelName } from "../../lib/panels.ts";
import { wallShowing } from "../../lib/showing.ts";
import { useModel } from "../../model.ts";
import { EASE_OUT } from "../../motion.ts";
import { swapIds } from "./badges.ts";
import { Compass } from "./Compass.tsx";
import { DraftPanel } from "./DraftPanel.tsx";
import {
  customOrder,
  leavesCustom,
  orderForAuto,
  orderForMode,
  orderForShuffle,
  orderForSweepFill,
} from "./orderModes.ts";
import { refusedText, stageLabel } from "./readout.ts";
import { Scrubber } from "./Scrubber.tsx";
import type { NumbersLevel } from "./StageBadges.tsx";
import type { PanelFlash } from "./StageCanvas.tsx";
import type { ToastMessage } from "./StageToast.tsx";
import { StageToolbar } from "./StageToolbar.tsx";
import { STAGE_BG, toolClass, WallStage } from "./WallStage.tsx";
import "./wall.css";

/** A goal preview left alone this long lets go of the wall (and the drawing) by itself. */
const GOAL_IDLE_MS = 15000;
/** Numbers show fully for this long after the order changes, so the flight to new panels is seen. */
const EMPHASIS_MS = 2400;
/** A panel picked or tapped flashes on the wall this long. */
const IDENTIFY_MS = 1400;
/** Plays of the order sweep per press of Play. */
const PLAY_SWEEPS = 2;
/** Local sweeps end a hair before their period wraps, so the last frame is the full wall, not the restart. */
const SWEEP_TAIL_MS = 80;
/** The first "not on your wall" waits this long, so connecting at load never flashes a muted drawing. */
const MUTE_AFTER_MS = 700;
/** Every view rotation the turn buttons reach, 30° apart. */
const VIEW_TURNS = Array.from({ length: 12 }, (_, k) => k * 30);

/** Said after leaving a hand-made order: it isn't lost. */
const KEPT = "Your own order is kept: My own brings it back.";

const NO_PANELS: readonly PlacedPanel[] = [];
/** Appended to a repeated announcement so a screen reader reads it again. */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/** Tap to order in progress: how it started and the panels numbered so far. */
interface Draft {
  /** Started from the keyboard: focus goes to the drawing's first panel rather than the draft panel. */
  readonly keyboard: boolean;
  readonly ids: readonly number[];
}

/** The wall section's parts, for a layout to place. */
export interface WallParts {
  /** The drawing with its toolbar. */
  readonly stage: ReactNode;
  /** The goal preview, in its own card. */
  readonly scrubber: ReactNode;
  /** The fill order editor (the draft panel while tapping an order). */
  readonly editor: ReactNode;
}

/**
 * The hero of the plugin: the wall drawn to scale and lit like the real one, and the fill order editor beside it
 * (below it when the column is narrow). The shell's layouts place the parts themselves (`arrange`), with the
 * drawing's height limited to `cap` px. Renders nothing without a paired controller and a layout: the shell shows
 * setup instead.
 */
export function WallSection({
  arrange,
  cap,
  toolbar = true,
  tools = false,
  shown = true,
  sky = false,
}: {
  arrange?: (parts: WallParts) => ReactNode;
  cap?: number;
  toolbar?: boolean;
  /** Play, the numbers and the turn as icon buttons on the drawing, beside zoom. */
  tools?: boolean;
  /**
   * Whether the drawing is on screen (the phone's other tabs hide it). Tap to order can't go on unseen: once it isn't,
   * a draft in progress is cancelled and the wall handed back.
   */
  shown?: boolean;
  /** The drawing on the night sky (the board): no surface around it, and no label over it. */
  sky?: boolean;
} = {}) {
  const model = useModel();
  const { layout, controller, settings, order: saved, connection, actions } = model;
  const reduced = useReducedMotion();

  const placed = useMemo(
    () => (layout ? placeLayout(layout, settings.viewRotation) : null),
    [layout, settings.viewRotation],
  );
  // A pinned drawing (the phone) is sized for every turn, so turning it never moves what's below.
  const turns = useMemo(
    () => (layout && cap !== undefined ? VIEW_TURNS.map((r) => placeLayout(layout, r)) : undefined),
    [layout, cap],
  );
  const panels = placed?.panels ?? NO_PANELS;
  const byId = useMemo(() => new Map(panels.map((p) => [p.id, p])), [panels]);
  const resolved = useMemo(() => resolveOrder(saved, panels), [saved, panels]);
  const n = resolved.length;
  // A sweep filling as a line lights each panel by the stretch of the wall it covers, as main does; it has no
  // sequence to number.
  const spans = useMemo(() => fillSpans(saved, panels, resolved), [saved, panels, resolved]);
  const line = fillsAsLine(saved);

  const scene = useScene();
  const preview = useWallPreview();
  const { showLocal, showWall } = preview;
  // The drawing's own previews, or a brightness slider's while one is dragged, at the wall's brightness.
  const drawn = useDrawnLight(preview.local);
  const stateRef = useRenderState(scene, drawn.preview);
  const accent = useMemo(() => accentRgb(scene.cssColor), [scene.cssColor]);
  const canWall = connection?.status === "connected" && settings.enabled;
  const canTouch = connection?.status === "connected" && connection.events;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [flash, setFlash] = useState<PanelFlash | null>(null);
  const [numbersOn, setNumbersOn] = useState(true);
  const [stageHover, setStageHover] = useState(false);
  const [emphasised, setEmphasised] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Counts plays, so the goal preview restarts its sweep when a direction is pressed again mid-play.
  const [plays, setPlays] = useState(0);
  const [goal, setGoal] = useState<number | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [refocus, setRefocus] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const timers = useRef({ emphasis: 0, play: 0, goal: 0, finish: 0 });
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const flashes = useRef(0);

  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const id of Object.values(t)) window.clearTimeout(id);
    };
  }, []);

  const announce = useCallback((text: string) => {
    // Alternate a zero-width space so the same sentence twice is still read out.
    setAnnouncement((old) => (old === text ? `${text}${ZERO_WIDTH_SPACE}` : text));
  }, []);
  const pulse = useCallback((id: number) => setFlash({ id, n: ++flashes.current }), []);
  const identify = useCallback(
    (id: number) => {
      if (canWall) showWall({ mode: "identify", panelIds: [id] }, IDENTIFY_MS);
    },
    [canWall, showWall],
  );

  /* ---- Previews: goal scrubber and Play ---- */

  const stopPreviews = useCallback(() => {
    window.clearTimeout(timers.current.play);
    window.clearTimeout(timers.current.goal);
    setPlaying(false);
    setGoal(null);
    showLocal(null);
    showWall(null);
  }, [showLocal, showWall]);

  const scrub = (fraction: number) => {
    window.clearTimeout(timers.current.play);
    setPlaying(false);
    setGoal(fraction);
    showLocal({ mode: "fill", fraction, rgb: null });
    if (canWall) showWall({ mode: "fill", fraction });
    window.clearTimeout(timers.current.goal);
    timers.current.goal = window.setTimeout(stopPreviews, GOAL_IDLE_MS);
  };

  /** Plays the order on the drawing and the wall: Play's two sweeps, or one (a chosen direction pressed again). */
  const playOrder = (sweeps: number) => {
    stopPreviews();
    const ms = orderSweepMs(n) * sweeps - SWEEP_TAIL_MS;
    showLocal({ mode: "order", rgb: null }, ms);
    if (canWall) showWall({ mode: "order" }, ms);
    setPlaying(true);
    setPlays((k) => k + 1);
    timers.current.play = window.setTimeout(() => setPlaying(false), ms);
  };
  const togglePlay = () => (playing ? stopPreviews() : playOrder(PLAY_SWEEPS));

  /* ---- Saving ---- */

  /** A refused save (the SDK has rolled the value back) says so on the stage instead of silently snapping back. */
  const refused = useCallback(
    (what: string) => (error: unknown) => setToast({ id: Date.now(), text: refusedText(what, error) }),
    [],
  );

  /**
   * Saves an order, then plays one sweep of it on the drawing and shows the numbers while they settle. A direction is
   * only chosen (`sweep: false`): pressing it again plays it.
   */
  const commit = useCallback(
    (next: PanelOrder, { sweep = true }: { sweep?: boolean } = {}) => {
      stopPreviews();
      void actions.saveOrder(next).catch(refused("the order"));
      if (!sweep) return;
      showLocal({ mode: "order", rgb: null }, orderSweepMs(n) - SWEEP_TAIL_MS);
      setEmphasised(true);
      window.clearTimeout(timers.current.emphasis);
      timers.current.emphasis = window.setTimeout(() => setEmphasised(false), EMPHASIS_MS);
    },
    [actions, n, refused, showLocal, stopPreviews],
  );

  const custom = useCallback((ids: readonly number[]): PanelOrder => customOrder(saved, ids), [saved]);

  // Leaving Custom keeps the hand-made ids (Auto and Random ignore them), so My own brings them back: said on the
  // stage, so nobody fears a hand-made order lost.
  const keptIfLeaving = (mode: OrderMode) => {
    if (leavesCustom(saved, mode)) setToast({ id: Date.now(), text: KEPT });
  };
  const chooseMode = (mode: OrderMode) => {
    if (mode === saved.mode) return;
    commit(orderForMode(saved, mode, resolved));
    setRefocus(false);
    keptIfLeaving(mode);
    announce(
      mode === "custom"
        ? saved.ids.length > 0
          ? "Custom order restored"
          : "Custom order"
        : `${mode === "auto" ? "Automatic" : "Random"} order. Your custom order is kept.`,
    );
  };
  const chooseAuto = (auto: AutoOrder) => {
    if (saved.mode === "auto" && saved.auto === auto) return;
    commit(orderForAuto(saved, auto), { sweep: auto === "path" });
    keptIfLeaving("auto");
    if (leavesCustom(saved, "auto")) announce("Automatic order. Your own order is kept.");
  };
  const chooseSweepFill = (sweepFill: SweepFill) => {
    if (sweepFill === saved.sweepFill) return;
    commit(orderForSweepFill(saved, sweepFill));
    announce(sweepFill === "line" ? "Fills as a line" : "Fills one panel at a time");
  };
  const shuffle = () => {
    commit(orderForShuffle(saved, nextSeed(saved.seed)));
    keptIfLeaving("random");
    announce(leavesCustom(saved, "random") ? "Shuffled. Your own order is kept." : "Shuffled");
  };
  // The view turns 30° a step: +30 is anticlockwise on screen (the layout's y points up, the drawing's down).
  const turn = (step: 30 | -30) =>
    void actions
      .saveSettings({ viewRotation: (settings.viewRotation + step + 360) % 360 })
      .catch(refused("the rotation"));
  const swap = (a: number, b: number) => {
    const ka = resolved.indexOf(a);
    const kb = resolved.indexOf(b);
    if (ka < 0 || kb < 0) return;
    commit(custom(swapIds(resolved, a, b)));
    announce(`Swapped numbers ${ka + 1} and ${kb + 1}`);
  };

  /* ---- Tap to order ---- */

  // Taps can arrive faster than renders (a touch burst from the wall): they read and write the draft through a ref.
  const draftRef = useRef(draft);
  const updateDraft = useCallback((next: Draft | null) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  /**
   * Tap to order ends: the wall and the drawing go back to what shows, and keyboard focus to the button that started
   * it, unless the user has moved on.
   */
  const endDraft = useCallback(() => {
    const wasDrafting = draftRef.current !== null;
    window.clearTimeout(timers.current.finish);
    showLocal(null);
    showWall(null);
    updateDraft(null);
    setFocus(null);
    const el = document.activeElement;
    if (wasDrafting && (!el || el === document.body || sectionRef.current?.contains(el))) setRefocus(true);
  }, [updateDraft, showLocal, showWall]);

  const cancelDraft = useCallback(() => {
    if (!draftRef.current) return;
    endDraft();
    announce("Tap to order cancelled");
  }, [endDraft, announce]);
  useEffect(() => {
    if (!shown) cancelDraft();
  }, [shown, cancelDraft]);

  // Tap to order holds the wall from start to end (taken from whatever showed, or switched on), with nothing over it:
  // panels waiting for a number glow faintly warm white, numbered ones yellow, on the wall and on the drawing. Ending
  // lets go (endDraft), before a save's sweep plays.
  useEffect(() => {
    if (!draft) return;
    const preview = { mode: "draft", panelIds: draft.ids } as const;
    showLocal({ ...preview, rgb: null });
    showWall(canWall ? preview : null);
  }, [draft, canWall, showLocal, showWall]);
  // The brightness sliders leave the wall to it meanwhile.
  const drafting = draft !== null;
  useEffect(() => setDrafting(drafting), [drafting]);
  useEffect(() => () => setDrafting(false), []);
  // Main hears it too, so gestures on the wall leave the workspace alone meanwhile, whether or not it drives the wall.
  const { numbering } = model.actions;
  useEffect(() => {
    if (!drafting) return;
    void numbering(true);
    return () => void numbering(false);
  }, [drafting, numbering]);

  const finishDraft = useCallback(
    (ids: readonly number[]) => {
      endDraft();
      if (ids.length === 0) return;
      const full = resolveOrder(custom(ids), panels);
      commit(custom(full));
      const added = full.length - ids.length;
      if (added > 0) {
        setToast({
          id: Date.now(),
          text: `${added} untapped ${added === 1 ? "panel" : "panels"} added at the end, in path order`,
        });
      }
      announce(added > 0 ? `Order saved. ${added} untapped panels were added at the end.` : "Order saved");
    },
    [announce, commit, custom, endDraft, panels],
  );

  // Tap to order started from the keyboard puts focus on the drawing's first panel (Enter or Space numbers it); from a
  // pointer, the draft panel takes focus instead (DraftPanel autoFocus), so no panel looks hovered.
  const focusDraft = useRef(false);
  useEffect(() => {
    if (!draft || !focusDraft.current) return;
    focusDraft.current = false;
    stageRef.current?.querySelector<SVGElement>("[data-panel][tabindex]")?.focus({ preventScroll: true });
  }, [draft]);

  const startDraft = (keyboard: boolean) => {
    stopPreviews();
    setRefocus(false);
    focusDraft.current = keyboard;
    updateDraft({ keyboard, ids: [] });
    setFocus(null);
    // Narrow, the drawing sits above the editor: bring it into view to be tapped.
    stageRef.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    announce(
      canTouch
        ? "Tap the panels on the drawing or on your wall, in the order they should fill"
        : "Tap the panels in the order they should fill",
    );
  };
  const refocused = useCallback(() => setRefocus(false), []);

  const tapDraft = (id: number) => {
    const current = draftRef.current;
    if (!current || !byId.has(id)) return;
    // The drawing flashes it; the wall shows it numbered (yellow) through the draft itself.
    pulse(id);
    if (current.ids.includes(id)) return;
    const ids = [...current.ids, id];
    updateDraft({ ...current, ids });
    const panel = byId.get(id);
    if (panel) announce(`${panelName(panel)} is number ${ids.length}`);
    // The last panel lands, a beat to see it, then the order is saved.
    if (ids.length === n) timers.current.finish = window.setTimeout(() => finishDraft(ids), reduced ? 0 : 450);
  };

  const undoDraft = () => {
    const current = draftRef.current;
    if (!current || current.ids.length === 0) return;
    window.clearTimeout(timers.current.finish);
    const ids = current.ids.slice(0, -1);
    updateDraft({ ...current, ids });
    announce(`Removed number ${current.ids.length}`);
  };

  /* ---- The drawing ---- */

  const activate = (id: number) => {
    if (draftRef.current) return tapDraft(id);
    pulse(id);
    identify(id);
  };

  // A panel touched on the wall numbers it while drafting, and otherwise points it out on the drawing and list.
  const onTouched = useRef<(id: number) => void>(() => undefined);
  useLayoutEffect(() => {
    onTouched.current = (id) => {
      if (!byId.has(id)) return;
      if (draftRef.current) tapDraft(id);
      else pulse(id);
    };
  });
  const { onTouch } = model;
  useEffect(() => {
    if (!canTouch) return;
    return onTouch((panelId, gesture) => {
      if (gesture === "tap" || gesture === "double-tap") onTouched.current(panelId);
    });
  }, [onTouch, canTouch]);

  // The wall shows the scene only while main drives it: otherwise the drawing is what it *would* show, muted.
  const showing = wallShowing(model);
  const notShown = scene.kind !== "off" && !showing.showing && draft === null;
  const [muteReady, setMuteReady] = useState(false);
  useEffect(() => {
    if (!notShown || muteReady) return;
    const id = window.setTimeout(() => setMuteReady(true), MUTE_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [notShown, muteReady]);
  const muted = notShown && muteReady;

  if (!placed || !controller || panels.length === 0) return null;

  const numbers: NumbersLevel = draft
    ? "full"
    : !numbersOn || line
      ? "off"
      : emphasised || stageHover
        ? "full"
        : "dim";
  const activity = scene.activityId ? model.activities.find((a) => a.id === scene.activityId) : undefined;
  const label = stageLabel({
    panels: n,
    activity: activity?.name ?? null,
    fraction: scene.progress?.fraction ?? null,
    showing,
  });
  const swapMotion = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, transform: "translateY(6px)", filter: "blur(2px)" },
        animate: { opacity: 1, transform: "translateY(0px)", filter: "blur(0px)" },
        exit: {
          opacity: 0,
          transform: "translateY(-4px)",
          filter: "blur(2px)",
          transition: { duration: 0.12, ease: EASE_OUT },
        },
      };

  const scrubber = (
    // While drafting the drawing is for tapping: the goal preview steps back.
    <div inert={draft !== null} className={cn("transition-opacity duration-200", draft && "opacity-35")}>
      <Scrubber
        // A line's goal is a distance, not a count: one track, not a segment per panel.
        n={line ? 1 : n}
        value={goal}
        sweep={playing ? { id: plays, n } : null}
        now={scene.progress ? scene.progress.fraction : null}
        accent={accent}
        onChange={scrub}
        onEnd={stopPreviews}
      />
    </div>
  );

  const stage = (
    <div
      ref={stageRef}
      onPointerEnter={(e) => e.pointerType === "mouse" && setStageHover(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setStageHover(false)}
    >
      <WallStage
        placed={placed}
        turns={turns}
        rotation={settings.viewRotation}
        stateRef={stateRef}
        order={resolved}
        spans={spans}
        numberOrder={resolved}
        drafting={draft !== null}
        draft={draft?.ids ?? []}
        numbers={numbers}
        focusId={focus}
        flash={flash}
        accent={accent}
        wash={muted ? null : scene.cssColor}
        muted={muted && drawn.preview === null}
        level={drawn.level}
        status={muted ? showing.reason : null}
        label={label}
        toast={toast}
        onToastDone={() => setToast(null)}
        onHover={setFocus}
        onActivate={activate}
        onSwap={swap}
        sky={sky}
        header={
          toolbar ? (
            <StageToolbar
              panels={n}
              name={controller.name}
              rotation={settings.viewRotation}
              numbers={line ? null : numbersOn}
              playing={playing}
              onPlay={togglePlay}
              onTurn={turn}
              onNumbers={setNumbersOn}
              sky={sky}
            />
          ) : null
        }
        // With `tools`, the goal preview stays in the drawing's card, under the tool row.
        footer={arrange && !tools ? undefined : scrubber}
        cap={cap}
        tools={
          // While numbering your own order the drawing is for tapping: only zoom stays.
          tools && !draft ? (
            <>
              <button
                type="button"
                aria-pressed={playing}
                aria-label={playing ? "Stop" : "Play the order"}
                title={playing ? "Stop" : "Play the order"}
                onClick={togglePlay}
                className={toolClass(playing)}
              >
                {playing ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </button>
              {!line && (
                <button
                  type="button"
                  aria-pressed={numbersOn}
                  aria-label={numbersOn ? "Hide the fill numbers" : "Show the fill numbers"}
                  title={numbersOn ? "Hide the fill numbers" : "Show the fill numbers"}
                  onClick={() => setNumbersOn(!numbersOn)}
                  className={toolClass(numbersOn)}
                >
                  <Hash className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                aria-label="Turn the drawing anticlockwise"
                title="Turn the drawing anticlockwise"
                onClick={() => turn(30)}
                className={toolClass(false)}
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Turn the drawing clockwise"
                title="Turn the drawing clockwise"
                onClick={() => turn(-30)}
                className={toolClass(false)}
              >
                <RotateCw className="h-4 w-4" />
              </button>
            </>
          ) : null
        }
      />
    </div>
  );

  const draftPanel = draft ? (
    <DraftPanel
      count={draft.ids.length}
      total={n}
      accent={accent}
      autoFocus={!draft.keyboard}
      onUndo={undoDraft}
      onReset={() => {
        window.clearTimeout(timers.current.finish);
        updateDraft({ ...draft, ids: [] });
        announce("Cleared: start again from number 1");
      }}
      onCancel={cancelDraft}
      onDone={() => finishDraft(draft.ids)}
    />
  ) : null;

  const editor = (
    <div className="@container rounded-3xl bg-content1 @sm:p-5 p-4 ring-1 ring-default-100">
      <AnimatePresence mode="wait" initial={false}>
        {draft ? (
          <motion.div key="draft" {...swapMotion} transition={{ duration: 0.2, ease: EASE_OUT }}>
            {draftPanel}
          </motion.div>
        ) : (
          <motion.div key="editor" {...swapMotion} transition={{ duration: 0.2, ease: EASE_OUT }}>
            <Compass
              order={saved}
              refocus={refocus}
              onMode={chooseMode}
              onAuto={chooseAuto}
              onShuffle={shuffle}
              onSweepFill={chooseSweepFill}
              onPreview={() => playOrder(1)}
              onDraft={startDraft}
              onRefocused={refocused}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  if (arrange) {
    return (
      <section ref={sectionRef} aria-label="Your wall and its fill order">
        {arrange({
          stage,
          scrubber: (
            <div className="wall-stage rounded-3xl text-foreground ring-1 ring-default-100" style={{ background: STAGE_BG }}>
              {scrubber}
            </div>
          ),
          editor,
        })}
        <div aria-live="polite" className="sr-only">
          {announcement}
        </div>
      </section>
    );
  }

  return (
    <section ref={sectionRef} aria-label="Your wall and its fill order" className="@container/wall">
      {/* Beside the drawing from 672 px (a ~1070 px control-room frame), so the fill order controls sit beside it. */}
      <div className="grid @2xl/wall:grid-cols-[minmax(0,1fr)_300px] @2xl/wall:items-start gap-4">
        {stage}
        {editor}
      </div>
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </section>
  );
}
