import { cn } from "@heroui/theme";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ComponentType, type ComponentProps } from "react";
import { createAnchors, Cube3D } from "./cube/Cube3D";
import { FaceEditor } from "./face-editor";
import { ModeCards, ModeEditor, NoticeToast, PinTrackSwitch } from "./kit";
import { resultFor, useCubeArt, useMediaQuery } from "./live";
import { type Face, type Workspace, isReady, useWorkspace } from "./model";
import { EASE_OUT } from "./motion";
import { PresetShelf } from "./preset-shelf";
import { useCubeSim } from "./sim";
import { LiveOverlay } from "./Twin";

const STAGE_H = 580;
const NARROW_STAGE_H = 420;

/**
 * The combined direction: Twin's layout (the options beside the cube, the cube taking the stage when it's picked up),
 * presets as a shelf of cards above it (from Deck), and any face of the cube clickable to change what it holds
 * (from Stage, without the floating labels). On a narrow screen the options come first and the cube sits below them.
 */
export function Final({ workspace, hidePresets = false, ModePanel }: { workspace?: Workspace; hidePresets?: boolean; ModePanel?: ComponentType<ComponentProps<typeof ModeEditor>> } = {}) {
  const localWorkspace = useWorkspace();
  const ws = workspace ?? localWorkspace;
  const [presetsExpanded, setPresetsExpanded] = useState(false);
  const sim = useCubeSim(ws);
  const wide = useMediaQuery("(min-width: 768px)");
  const reduced = useReducedMotion();
  const anchors = useMemo(createAnchors, []);
  const [hoverFaces, setHoverFaces] = useState<Face[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // A face picked on the cube (its editor opens beside the cube), or a Manual face card whose picker is open.
  const [editing, setEditing] = useState<Face | null>(null);
  const [cardFace, setCardFace] = useState<Face | null>(null);
  const [flash, setFlash] = useState<{ key: string; n: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const art = useCubeArt(ws.setup, preview);
  const live = sim.view !== "idle";
  const mode = ws.setup.mode;
  const focus = editing ? [editing] : cardFace ? [cardFace] : hoverFaces;

  // Picking the cube up, loading another preset or changing the game closes the face being edited.
  useEffect(() => {
    if (live) setEditing(null);
  }, [live]);
  useEffect(() => {
    setEditing(null);
    setCardFace(null);
  }, [ws.bootKey, mode]);
  // Narrow: the options fold away when the real cube is picked up, so bring the cube into view.
  useEffect(() => {
    if (live && !wide) stageRef.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [live, wide, reduced]);

  const onFaceClick = (f: Face) => {
    setCardFace(null);
    setEditing(f === editing ? null : f);
    // The option that face belongs to answers too.
    const slot = art.slots[f];
    if (mode === "duel" && slot.side) setFlash({ key: slot.side, n: (flash?.n ?? 0) + 1 });
    else if (mode === "shortlist" && slot.item != null) setFlash({ key: String(slot.item), n: (flash?.n ?? 0) + 1 });
  };

  const Editor = ModePanel ?? ModeEditor;
  const config = (
    <div className="preset-editor-config space-y-4 p-5">
      <div className="preset-editor-heading grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <AnimatePresence mode="wait" initial={false}>
          <motion.h2
            key={ws.active?.id ?? "unsaved"}
            title={ws.active?.name ?? "Unsaved setup"}
            className={cn("min-w-0 whitespace-normal break-words text-xl font-bold leading-snug [overflow-wrap:anywhere]", !ws.active && "text-default-500")}
            initial={{ opacity: 0, transform: "translateY(6px)", filter: "blur(2px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)", filter: "blur(0px)" }}
            exit={{ opacity: 0, transform: "translateY(-6px)", filter: "blur(2px)" }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
          >
            {ws.active?.name ?? "Unsaved setup"}
          </motion.h2>
        </AnimatePresence>
        <PinTrackSwitch ws={ws} className="shrink-0" />
      </div>
      {!ModePanel && <ModeCards compact value={mode} onChange={(m) => ws.update({ mode: m })} />}
      <Editor
        ws={ws}
        onHoverFaces={setHoverFaces}
        onPreview={setPreview}
        selected={cardFace}
        onSelect={(f) => {
          setEditing(null);
          setCardFace(f);
        }}
        flash={flash}
      />
      {!isReady(ws.setup) && <p className="text-xs text-warning">Some faces are empty — rolling one of them won't start anything.</p>}
    </div>
  );

  const stage = (
    <div ref={stageRef} className={cn(wide ? "absolute inset-x-0 top-0" : "relative")} style={{ height: wide ? STAGE_H : NARROW_STAGE_H }}>
      <Cube3D
        className="h-full w-full"
        faces={art.faces}
        flicker={art.flicker}
        phase={sim.view}
        result={sim.view === "result" ? resultFor(sim.roll) : null}
        highlight={focus}
        focus={focus}
        selected={editing}
        onFaceClick={onFaceClick}
        anchors={anchors}
        bootKey={ws.bootKey}
        shift={wide && !live ? 0.3 : 0}
        zoom={live ? (wide ? 1.32 : 1.6) : wide ? 1.12 : 1.2}
        frameY={sim.view === "result" ? (wide ? -0.42 : -0.5) : 0}
        background="#18181b"
      />
      {/* Stacked under the options, the stage's glow melts into them instead of starting at a hard edge. */}
      {!wide && <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-content1 to-transparent" />}
      <AnimatePresence>
        {editing && !live && (
          <FaceEditor
            key="editor"
            face={editing}
            ws={ws}
            slot={art.slots[editing]}
            anchors={anchors}
            placement={wide ? "beside" : "bottom"}
            onClose={() => setEditing(null)}
          />
        )}
      </AnimatePresence>
      <LiveOverlay sim={sim} narrow={!wide} />
    </div>
  );

  return (
    <div className="relative space-y-3">
      {!hidePresets && <PresetShelf ws={ws} expanded={presetsExpanded} onExpandedChange={setPresetsExpanded} />}
      <div className="relative" hidden={presetsExpanded}>
        <NoticeToast notice={sim.notice} onDone={sim.clearNotice} className="absolute left-1/2 top-3 z-30 -translate-x-1/2" />
        <div className="relative overflow-hidden rounded-3xl border border-default-100 bg-content1" style={{ minHeight: wide ? STAGE_H : undefined }}>
          {wide ? (
            <>
              {stage}
              {/* The options step back (and stop taking input) while the hardware has the floor. */}
              <motion.div
                className="relative z-10 w-[60%]"
                animate={{ opacity: live ? 0 : 1, transform: live ? "translateX(-16px)" : "translateX(0px)" }}
                transition={{ duration: 0.22, ease: EASE_OUT }}
                style={{ pointerEvents: live ? "none" : "auto" }}
                aria-hidden={live}
              >
                {config}
              </motion.div>
            </>
          ) : (
            <>
              <AnimatePresence initial={false}>
                {!live && (
                  <motion.div
                    key="config"
                    className="overflow-hidden"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25, ease: EASE_OUT }}
                  >
                    {config}
                  </motion.div>
                )}
              </AnimatePresence>
              {stage}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
