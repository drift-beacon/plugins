import { cn } from "@heroui/theme";
import { Hash, Play, RotateCcw, RotateCw, Square } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cssRgb } from "../../../../shared/color.ts";
import { placeLayout } from "../../../../shared/geometry.ts";
import { fillsAsLine, resolveOrder } from "../../../../shared/order.ts";
import { orderSweepMs } from "../../../../shared/render.ts";
import type { AutoOrder, OrderMode, PanelOrder, PlacedPanel, SweepFill } from "../../../../shared/types.ts";
import { zoneTag } from "../../../../shared/zones.ts";
import { setDrafting, useWallLight } from "../../hooks/useDrawnLight.ts";
import { useWallZones } from "../../hooks/useZones.ts";
import { useScene } from "../../hooks/useScene.ts";
import { useWallPreview, type WallRequest } from "../../hooks/useWallPreview.ts";
import { accentRgb } from "../../lib/color.ts";
import { nextSeed, panelName } from "../../lib/panels.ts";
import { wallShowing } from "../../lib/showing.ts";
import { zoneErrorText } from "../../lib/zone-actions.ts";
import { createChoosing, type ChoosingState } from "../../lib/choosing.ts";
import { escapeEndsChoosing, focusIsLost, OVERLAY, refocusAfterEnd } from "../../lib/choosingFocus.ts";
import { createNumberingHold } from "../../lib/numbering.ts";
import { orderTarget, saveEditorOrder, showsZones, zonedRequest } from "../../lib/zones.ts";
import { useModel } from "../../model.ts";
import { EASE_OUT } from "../../motion.ts";
import { memberName } from "../zones/ZoneCards.tsx";
import { ZoneEditingContext, type ZoneEditing } from "../zones/ZoneContext.ts";
import { ZoneChips } from "../zones/ZoneChips.tsx";
import { ZONE_WORDS } from "../zones/words.ts";
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
import type { PanelFlash, PanelPresses } from "./StageCanvas.tsx";
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
  /** More than one zone stands: the zone cards (components/zones) take the place of the Now card and the picker. */
  readonly split: boolean;
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
  onChoosing,
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
  /** Choosing panels started (a zone's id) or ended (null): the phone brings the drawing's tab forward, then back. */
  onChoosing?: (zoneId: string | null) => void;
} = {}) {
  const model = useModel();
  const { layout, controller, settings, order: savedWall, connection, actions } = model;
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
  const allPanels = placed?.panels ?? NO_PANELS;

  const scene = useScene();
  const preview = useWallPreview();
  const { showLocal, showWall: showWallRaw } = preview;
  const [draft, setDraft] = useState<Draft | null>(null);
  // The zone the fill order editor works on (the first by default), and the zone whose panels are being chosen.
  const [selected, setSelected] = useState<string | null>(null);
  const [choosingState, setChoosingState] = useState<ChoosingState>({ zoneId: null, painting: [] });
  const choosing = choosingState.zoneId;
  const painting = choosingState.painting;

  const zones = useWallZones();
  const split = showsZones(zones);
  // The removed or never-chosen zone falls back to the first.
  const editZone = zones.find((zone) => zone.id === selected) ?? zones[0];
  const editZoneId = editZone?.id ?? null;
  // Previews and tap to order apply to the zone the editor works on; on an unsplit wall, to the whole wall as before.
  const target = split ? editZoneId : null;

  // The drawing's own previews (on that zone), or a brightness slider's while one is dragged, at the wall's
  // brightness; every zone lit by its own scene. Tap to order on a split wall holds the wall for its zone, the others
  // dark.
  const localZone = useMemo(() => ({ preview: preview.local, zoneId: target }), [preview.local, target]);
  const drawn = useWallLight(placed, localZone, draft && target !== null ? target : null);
  const { scenes, fills } = drawn;
  /** The wall's preview, for the zone the editor works on (left out on an unsplit wall, as before zones). */
  const showWall = useCallback(
    (request: WallRequest | null, ms?: number) => showWallRaw(request && zonedRequest(request, target), ms),
    [showWallRaw, target],
  );

  // The editor's panels and order: the selected zone's (every panel on an unsplit wall).
  const saved = editZone?.order ?? savedWall;
  const panels = useMemo(() => {
    if (!split || !editZone) return allPanels;
    const mine = new Set(editZone.panels);
    return allPanels.filter((p) => mine.has(p.id));
  }, [split, editZone, allPanels]);
  const fill = fills.find((f) => f.id === editZoneId);
  const resolved = useMemo(() => fill?.order ?? resolveOrder(saved, panels), [fill, saved, panels]);
  const byId = useMemo(() => new Map(panels.map((p) => [p.id, p])), [panels]);
  const n = resolved.length;
  // A sweep filling as a line lights each panel by the stretch of the wall it covers, as main does; it has no
  // sequence to number.
  const line = fillsAsLine(saved);
  const editScene = (split ? scenes.find((z) => z.id === editZoneId)?.scene : null) ?? scene;

  const accent = useMemo(() => accentRgb(scene.cssColor), [scene.cssColor]);
  const canWall = connection?.status === "connected" && settings.enabled;
  const canTouch = connection?.status === "connected" && connection.events;

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
      // An unsplit wall writes the wall's order as before zones; a zone of a split wall, its own.
      const to = editZoneId === null ? null : orderTarget(model.zones, zones, editZoneId);
      void saveEditorOrder(actions, to, next).catch(refused("the order"));
      if (!sweep) return;
      showLocal({ mode: "order", rgb: null }, orderSweepMs(n) - SWEEP_TAIL_MS);
      setEmphasised(true);
      window.clearTimeout(timers.current.emphasis);
      timers.current.emphasis = window.setTimeout(() => setEmphasised(false), EMPHASIS_MS);
    },
    [actions, n, refused, showLocal, stopPreviews, editZoneId, model.zones, zones],
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
    if (chooser.state.zoneId !== null) return;
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
  const drafting = draft !== null;
  // Choosing panels for a zone holds the wall too (its tag colours): presses on the drawing and touches on the wall
  // move panels, not gestures. The brightness sliders leave the wall to either meanwhile.
  const numberingNow = drafting || choosing !== null;
  useEffect(() => setDrafting(numberingNow), [numberingNow]);
  useEffect(() => () => setDrafting(false), []);
  // Main hears it too (`numbering`, held by tap to order and by choosing panels, said again on a resync since main
  // may have lost it), so gestures on the wall leave the workspace alone meanwhile, whether or not it drives the wall.
  const numberingSend = useRef(model.actions.numbering);
  useLayoutEffect(() => {
    numberingSend.current = model.actions.numbering;
  });
  const [hold] = useState(() => createNumberingHold((on) => void numberingSend.current(on)));
  useEffect(() => hold.set("draft", drafting), [hold, drafting]);
  useEffect(() => () => hold.release(), [hold]);
  useEffect(() => model.onResync(hold.resend), [model.onResync, hold]);

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
    if (n === 0) return;
    chooser.end();
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

  /* ---- Choosing panels for a zone ---- */

  const onChoosingRef = useRef(onChoosing);
  const pulseRef = useRef(pulse);
  useLayoutEffect(() => {
    onChoosingRef.current = onChoosing;
    pulseRef.current = pulse;
  });
  const zoneRefused = useCallback((error: unknown) => setToast({ id: Date.now(), text: zoneErrorText(error) }), []);
  // Where focus goes once choosing ends from the drawing, or once it starts and the button pressed is gone.
  const refocusTo = useRef<"start" | { readonly end: string } | null>(null);
  const lastChoosing = useRef<ChoosingState>(choosingState);
  const [chooser] = useState(() =>
    createChoosing({
      showWall: (request) => showWallRaw(request),
      hold: (on) => hold.set("choosing", on),
      changed: (next) => {
        const old = lastChoosing.current;
        lastChoosing.current = next;
        if (old.zoneId !== next.zoneId) {
          refocusTo.current = next.zoneId === null ? (old.zoneId ? { end: old.zoneId } : null) : "start";
          onChoosingRef.current?.(next.zoneId);
        }
        setChoosingState(next);
      },
      movePanels: (zoneId, ids) => actions.movePanels(zoneId, ids),
      refused: zoneRefused,
      pulse: (id) => pulseRef.current(id),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    }),
  );
  const chosen = choosing === null ? null : (zones.find((zone) => zone.id === choosing) ?? null);
  useLayoutEffect(() => chooser.setZones(zones), [chooser, zones]);
  useLayoutEffect(() => chooser.setCanWall(canWall), [chooser, canWall]);
  // Leaving the drawing's tab or closing ends it, and the wall goes back to what shows.
  useEffect(() => chooser.setShown(shown), [chooser, shown]);
  useEffect(() => () => chooser.end(), [chooser]);

  const startChoosing = (id: string) => {
    cancelDraft();
    stopPreviews();
    setSelected(id);
    setFocus(null);
    chooser.start(id);
    // Narrow, the drawing sits above the cards: bring it into view to choose on.
    stageRef.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  };
  const endChoosing = useCallback(() => chooser.end(), [chooser]);
  const choose = (id: string | null) => (id === null ? endChoosing() : startChoosing(id));
  // Said once the zone is there: one just added may reach the model a moment after choosing starts.
  const chosenAnnounce = chosen ? ZONE_WORDS.choosingFor(memberName(model, chosen.member)) : null;
  useEffect(() => {
    if (chosenAnnounce) announce(chosenAnnounce);
  }, [chosenAnnounce, announce]);
  // Escape ends it, unless an open popover or menu takes it first. From a panel or the banner, focus then moves on
  // (the panels stop being buttons, the banner goes).
  const escapedFromDrawing = useRef(false);
  useEffect(() => {
    if (choosing === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target instanceof Element ? e.target : null;
      if (!escapeEndsChoosing(e.defaultPrevented, target?.closest(OVERLAY) != null)) return;
      escapedFromDrawing.current = !!target && (stageRef.current?.contains(target) ?? false);
      endChoosing();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [choosing, endChoosing]);
  // Focus is never dropped to the page, and never taken from a control the person is on: when choosing starts, the
  // banner's Done takes it if the button pressed has gone (a chip in "Whose zone?", on its way out); when it ends,
  // that zone's Choose panels does, else Split the wall or the first card, but only if focus was lost (the banner's
  // Done went) or the person pressed Escape on the drawing (lib/choosingFocus.ts).
  useEffect(() => {
    const want = refocusTo.current;
    if (want === null || (want === "start" && !chosen)) return;
    refocusTo.current = null;
    const escaped = escapedFromDrawing.current;
    escapedFromDrawing.current = false;
    const lost = focusIsLost(document.activeElement, document.body);
    const focusFirst = (selectors: readonly string[]) => {
      for (const selector of selectors) {
        const found = document.querySelector<HTMLElement>(selector);
        if (found) return void found.focus({ preventScroll: true });
      }
    };
    if (want === "start") {
      if (lost) focusFirst(["[data-choosing-done]"]);
      return;
    }
    if (refocusAfterEnd(lost, escaped)) {
      focusFirst([`[data-choose-zone="${want.end}"]`, "[data-split-wall]", "[data-zone-card-heading]"]);
    }
  });

  const presses: PanelPresses = {
    onPanelDown: (id) => chooser.down(id),
    onPanelDrag: (id) => chooser.drag(id),
    onPanelUp: (tap) => chooser.up(tap),
  };

  const editing: ZoneEditing = { zones, scenes, split, choosing, choose };

  /* ---- The drawing ---- */

  const activate = (id: number) => {
    // While choosing, only Enter or Space reach here (presses go to `presses`).
    if (chooser.state.zoneId !== null) return chooser.tap(id);
    if (draftRef.current) return tapDraft(id);
    pulse(id);
    identify(id);
  };

  // A panel touched on the wall numbers it while drafting, and otherwise points it out on the drawing and list.
  const onTouched = useRef<(id: number) => void>(() => undefined);
  useLayoutEffect(() => {
    onTouched.current = (id) => {
      if (chooser.state.zoneId !== null) return chooser.touch(id);
      if (!byId.has(id)) return;
      if (draftRef.current) tapDraft(id);
      else pulse(id);
    };
  });
  const { onTouch } = model;
  useEffect(() => {
    if (!canTouch) return;
    // While choosing panels, a touch on the wall brings that panel in (a tap or double tap, as tap to order takes).
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

  if (!placed || !controller || allPanels.length === 0) return null;

  const numbers: NumbersLevel = draft
    ? "full"
    : !numbersOn || line
      ? "off"
      : emphasised || stageHover
        ? "full"
        : "dim";
  const activity = scene.activityId ? model.activities.find((a) => a.id === scene.activityId) : undefined;
  const label = stageLabel({
    panels: allPanels.length,
    activity: activity?.name ?? null,
    fraction: scene.progress?.fraction ?? null,
    showing,
  });
  // Choosing panels: the zone's own, with a drag in progress already counted.
  const chosenName = chosen ? memberName(model, chosen.member) : "";
  const chosenPanels = chosen ? (painting.length > 0 ? [...new Set([...chosen.panels, ...painting])] : chosen.panels) : [];
  const giveBackTo = chosen ? zones.find((zone) => zone.id !== chosen.id) : undefined;
  const tags = zones.map((zone) => ({
    id: zone.id,
    name: memberName(model, zone.member),
    rgb: zoneTag(zone.position),
    panels: zone.panels,
  }));
  const banner = chosen ? (
    <div className="space-y-1.5 px-3 pt-2 pb-1 text-center">
      <div
        className="mx-auto flex w-fit max-w-full items-center gap-3 rounded-2xl bg-content1/90 py-1.5 pr-1.5 pl-3 ring-1 ring-default-200 backdrop-blur"
        style={{ boxShadow: `inset 0 0 0 1.5px ${cssRgb(zoneTag(chosen.position))}` }}
      >
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: cssRgb(zoneTag(chosen.position)) }}
        />
        {/* Wraps rather than cut the name off on a phone. */}
        <span className="min-w-0 text-left font-medium text-foreground text-sm leading-tight">
          {ZONE_WORDS.choosingFor(chosenName)}
        </span>
        <span className="shrink-0 text-default-500 text-xs tabular-nums">
          {ZONE_WORDS.panels(chosenPanels.length)}
        </span>
        <button
          type="button"
          data-choosing-done
          onClick={endChoosing}
          className="inline-flex h-8 shrink-0 items-center rounded-xl bg-foreground px-3.5 font-medium text-background text-xs transition-transform duration-150 ease-out active:scale-[0.97]"
        >
          {ZONE_WORDS.done}
        </button>
      </div>
      {giveBackTo && (
        <p className="text-default-500 text-xs">{ZONE_WORDS.chooseHint(memberName(model, giveBackTo.member))}</p>
      )}
    </div>
  ) : null;

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
    <div
      inert={draft !== null || chosen !== null}
      className={cn("transition-opacity duration-200", (draft || chosen) && "opacity-35")}
    >
      <Scrubber
        // A line's goal is a distance, not a count: one track, not a segment per panel.
        n={line ? 1 : n}
        value={goal}
        sweep={playing ? { id: plays, n } : null}
        now={editScene.progress ? editScene.progress.fraction : null}
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
        lights={drawn.source}
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
        choosing={chosen ? { name: chosenName, rgb: zoneTag(chosen.position), panels: chosenPanels } : null}
        presses={presses}
        tags={split && !chosen && !draft ? tags : null}
        draftable={split && draft ? resolved : null}
        banner={banner}
        header={
          toolbar ? (
            // Choosing panels: Play and the rest step back with the editor, so nothing ends the zones preview.
            <div inert={chosen !== null} className={cn("transition-opacity duration-200", chosen && "opacity-50")}>
              <StageToolbar
                panels={allPanels.length}
                name={controller.name}
                rotation={settings.viewRotation}
                numbers={line ? null : numbersOn}
                playing={playing}
                onPlay={togglePlay}
                onTurn={turn}
                onNumbers={setNumbersOn}
                sky={sky}
              />
            </div>
          ) : null
        }
        // With `tools`, the goal preview stays in the drawing's card, under the tool row.
        footer={arrange && !tools ? undefined : scrubber}
        cap={cap}
        tools={
          // While numbering your own order the drawing is for tapping: only zoom stays.
          tools && !draft && !chosen ? (
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
    // While choosing panels the drawing is for that: the editor steps back, as the goal preview does.
    <div
      inert={chosen !== null}
      className={cn(
        "@container rounded-3xl bg-content1 @sm:p-5 p-4 ring-1 ring-default-100 transition-opacity duration-200",
        chosen && "opacity-50",
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        {draft ? (
          <motion.div key="draft" {...swapMotion} transition={{ duration: 0.2, ease: EASE_OUT }}>
            {draftPanel}
          </motion.div>
        ) : (
          <motion.div key="editor" {...swapMotion} transition={{ duration: 0.2, ease: EASE_OUT }}>
            {/* A split wall's fill order is per zone: these choose which (the first by default). */}
            {split && (
              <ZoneChips
                zones={zones}
                value={editZoneId}
                name={(zone) => memberName(model, zone.member)}
                label={ZONE_WORDS.orderTitle}
                onChange={(id) => {
                  stopPreviews();
                  setSelected(id);
                }}
                className="mb-4"
              />
            )}
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
      <ZoneEditingContext.Provider value={editing}>
        <section ref={sectionRef} aria-label="Your wall and its fill order">
          {arrange({
            stage,
            scrubber: (
              <div
                className="wall-stage rounded-3xl text-foreground ring-1 ring-default-100"
                style={{ background: STAGE_BG }}
              >
                {scrubber}
              </div>
            ),
            editor,
            split,
          })}
          <div aria-live="polite" className="sr-only">
            {announcement}
          </div>
        </section>
      </ZoneEditingContext.Provider>
    );
  }

  return (
    <ZoneEditingContext.Provider value={editing}>
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
    </ZoneEditingContext.Provider>
  );
}
