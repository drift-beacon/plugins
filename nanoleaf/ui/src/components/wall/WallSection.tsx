import { cn } from "@heroui/theme";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { placeLayout } from "../../../../shared/geometry.ts";
import { resolveOrder } from "../../../../shared/order.ts";
import { orderSweepMs } from "../../../../shared/render.ts";
import type { AutoOrder, OrderMode, PanelOrder, PlacedPanel } from "../../../../shared/types.ts";
import { useRenderState } from "../../hooks/useRenderState.ts";
import { useScene } from "../../hooks/useScene.ts";
import { useWallPreview } from "../../hooks/useWallPreview.ts";
import { accentRgb } from "../../lib/color.ts";
import { nextSeed, panelName } from "../../lib/panels.ts";
import { wallShowing } from "../../lib/showing.ts";
import { useModel } from "../../model.ts";
import { EASE_OUT } from "../../motion.ts";
import { swapIds } from "./badges.ts";
import { DraftPanel, type DraftSource } from "./DraftPanel.tsx";
import { OrderEditor, type UndoOffer } from "./OrderEditor.tsx";
import { customOrder, leavesCustom, orderForAuto, orderForMode, orderForShuffle } from "./orderModes.ts";
import { refusedText, stageLabel } from "./readout.ts";
import { Scrubber } from "./Scrubber.tsx";
import type { NumbersLevel } from "./StageBadges.tsx";
import type { PanelFlash } from "./StageCanvas.tsx";
import type { ToastMessage } from "./StageToast.tsx";
import { StageToolbar } from "./StageToolbar.tsx";
import { STAGE_BG, WallStage } from "./WallStage.tsx";
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

/** Said after leaving a hand-made order: it isn't lost. */
const KEPT = "Your own order is kept: My own brings it back.";

const NO_PANELS: readonly PlacedPanel[] = [];
/** Appended to a repeated announcement so a screen reader reads it again. */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/** Tap to order in progress: where taps come from and the panels numbered so far. */
interface Draft {
  readonly source: DraftSource;
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
export function WallSection({ arrange, cap }: { arrange?: (parts: WallParts) => ReactNode; cap?: number } = {}) {
  const model = useModel();
  const { layout, controller, settings, order: saved, connection, actions } = model;
  const reduced = useReducedMotion();

  const placed = useMemo(
    () => (layout ? placeLayout(layout, settings.viewRotation) : null),
    [layout, settings.viewRotation],
  );
  const panels = placed?.panels ?? NO_PANELS;
  const byId = useMemo(() => new Map(panels.map((p) => [p.id, p])), [panels]);
  const resolved = useMemo(() => resolveOrder(saved, panels), [saved, panels]);
  const n = resolved.length;

  const scene = useScene();
  const preview = useWallPreview();
  const { showLocal, showWall } = preview;
  const stateRef = useRenderState(scene, preview.local);
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
  const [goal, setGoal] = useState<number | null>(null);
  const [onWall, setOnWall] = useState(true);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [undo, setUndo] = useState<{ readonly offer: UndoOffer; readonly order: PanelOrder } | null>(null);
  const [refocus, setRefocus] = useState<DraftSource | null>(null);
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
    if (canWall && onWall) showWall({ mode: "fill", fraction });
    window.clearTimeout(timers.current.goal);
    timers.current.goal = window.setTimeout(stopPreviews, GOAL_IDLE_MS);
  };

  const togglePlay = () => {
    if (playing) return stopPreviews();
    stopPreviews();
    const ms = orderSweepMs(n) * PLAY_SWEEPS - SWEEP_TAIL_MS;
    showLocal({ mode: "order", rgb: null }, ms);
    if (canWall && onWall) showWall({ mode: "order" }, ms);
    setPlaying(true);
    timers.current.play = window.setTimeout(() => setPlaying(false), ms);
  };

  const changeOnWall = (on: boolean) => {
    setOnWall(on);
    if (!canWall) return;
    if (!on) showWall(null);
    else if (goal !== null) showWall({ mode: "fill", fraction: goal });
  };

  /* ---- Saving ---- */

  /** A refused save (the SDK has rolled the value back) says so on the stage instead of silently snapping back. */
  const refused = useCallback(
    (what: string) => (error: unknown) => setToast({ id: Date.now(), text: refusedText(what, error) }),
    [],
  );

  /** Saves an order, then plays one sweep of it on the drawing and shows the numbers while they settle. */
  const commit = useCallback(
    (next: PanelOrder) => {
      stopPreviews();
      // Any new order replaces the one an undo would bring back.
      setUndo(null);
      void actions.saveOrder(next).catch(refused("the order"));
      showLocal({ mode: "order", rgb: null }, orderSweepMs(n) - SWEEP_TAIL_MS);
      setEmphasised(true);
      window.clearTimeout(timers.current.emphasis);
      timers.current.emphasis = window.setTimeout(() => setEmphasised(false), EMPHASIS_MS);
    },
    [actions, n, refused, showLocal, stopPreviews],
  );

  const custom = useCallback((ids: readonly number[]): PanelOrder => customOrder(saved, ids), [saved]);

  // Leaving Custom keeps the hand-made ids (Auto and Random ignore them), so Custom brings them back; Undo too.
  const chooseMode = (mode: OrderMode) => {
    if (mode === saved.mode) return;
    commit(orderForMode(saved, mode, resolved));
    setRefocus(null);
    if (leavesCustom(saved, mode)) {
      setUndo({ offer: { id: Date.now(), text: KEPT }, order: saved });
    }
    announce(
      mode === "custom"
        ? saved.ids.length > 0
          ? "Custom order restored"
          : "Custom order"
        : `${mode === "auto" ? "Automatic" : "Random"} order. Your custom order is kept.`,
    );
  };
  const undoMode = () => {
    if (!undo) return;
    commit(undo.order);
    announce("Custom order restored");
  };
  const chooseAuto = (auto: AutoOrder) => {
    if (saved.mode === "auto" && saved.auto === auto) return;
    commit(orderForAuto(saved, auto));
    // Straight from a hand-made order to a direction: the same reassurance as choosing a mode.
    if (leavesCustom(saved, "auto")) {
      setUndo({ offer: { id: Date.now(), text: KEPT }, order: saved });
      announce("Automatic order. Your own order is kept.");
    }
  };
  const shuffle = () => {
    commit(orderForShuffle(saved, nextSeed(saved.seed)));
    announce("Shuffled");
  };
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

  /** Tap to order ends: keyboard focus goes back to the button that started it, unless the user has moved on. */
  const endDraft = useCallback(() => {
    const source = draftRef.current?.source ?? null;
    window.clearTimeout(timers.current.finish);
    updateDraft(null);
    setFocus(null);
    const el = document.activeElement;
    if (source && (!el || el === document.body || sectionRef.current?.contains(el))) setRefocus(source);
  }, [updateDraft]);

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

  const startDraft = (source: DraftSource, keyboard: boolean) => {
    stopPreviews();
    setRefocus(null);
    focusDraft.current = source === "stage" && keyboard;
    updateDraft({ source, keyboard, ids: [] });
    setFocus(null);
    // Narrow, the drawing sits above the editor: bring it into view to be tapped.
    stageRef.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    announce(
      source === "wall" ? "Touch the panels on your wall in order" : "Tap the panels in the order they should fill",
    );
  };
  const refocused = useCallback(() => setRefocus(null), []);

  const tapDraft = (id: number) => {
    const current = draftRef.current;
    if (!current || !byId.has(id)) return;
    pulse(id);
    identify(id);
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
    : !numbersOn
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
        n={n}
        value={goal}
        now={scene.progress ? scene.progress.fraction : null}
        accent={accent}
        canWall={canWall}
        onWall={onWall}
        onChange={scrub}
        onEnd={stopPreviews}
        onWallChange={changeOnWall}
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
        rotation={settings.viewRotation}
        stateRef={stateRef}
        order={resolved}
        numberOrder={resolved}
        drafting={draft !== null}
        draft={draft?.ids ?? []}
        numbers={numbers}
        focusId={focus}
        flash={flash}
        accent={accent}
        wash={muted ? null : scene.cssColor}
        muted={muted && preview.local === null}
        status={muted ? showing.reason : null}
        label={label}
        toast={toast}
        onToastDone={() => setToast(null)}
        onHover={setFocus}
        onActivate={activate}
        onSwap={swap}
        header={
          <StageToolbar
            panels={n}
            name={controller.name}
            rotation={settings.viewRotation}
            numbers={numbersOn}
            onRotate={() =>
              void actions
                .saveSettings({ viewRotation: (settings.viewRotation + 30) % 360 })
                .catch(refused("the rotation"))
            }
            onNumbers={setNumbersOn}
          />
        }
        footer={arrange ? undefined : scrubber}
        cap={cap}
      />
    </div>
  );

  const editor = (
    <div className="@container rounded-3xl bg-content1 @sm:p-5 p-4 ring-1 ring-default-100">
      <AnimatePresence mode="wait" initial={false}>
        {draft ? (
          <motion.div key="draft" {...swapMotion} transition={{ duration: 0.2, ease: EASE_OUT }}>
            <DraftPanel
              source={draft.source}
              count={draft.ids.length}
              total={n}
              accent={accent}
              autoFocus={!(draft.source === "stage" && draft.keyboard)}
              onUndo={undoDraft}
              onReset={() => {
                window.clearTimeout(timers.current.finish);
                updateDraft({ ...draft, ids: [] });
                announce("Cleared: start again from number 1");
              }}
              onCancel={() => {
                endDraft();
                announce("Tap to order cancelled");
              }}
              onDone={() => finishDraft(draft.ids)}
            />
          </motion.div>
        ) : (
          <motion.div key="editor" {...swapMotion} transition={{ duration: 0.2, ease: EASE_OUT }}>
            <OrderEditor
              placed={placed}
              resolved={resolved}
              order={saved}
              accent={accent}
              canTouch={canTouch}
              playing={playing}
              refocus={refocus}
              undo={undo?.offer ?? null}
              onMode={chooseMode}
              onAuto={chooseAuto}
              onShuffle={shuffle}
              onDraft={startDraft}
              onPlay={togglePlay}
              onRefocused={refocused}
              onUndo={undoMode}
              onUndoDone={() => setUndo(null)}
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
