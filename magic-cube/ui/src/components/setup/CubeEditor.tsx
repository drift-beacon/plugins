import { cn } from "@heroui/theme";
import { AnimatePresence,motion,useReducedMotion } from "motion/react";
import { useEffect,useRef } from "react";
import { Cube3D } from "./cube/Cube3D";
import { useCubeEditor } from "./editor";
import { FaceEditor } from "./face-editor";
import { LightsToggle,ModeEditor,PinTrackSwitch } from "./kit";
import { resultFor,useMediaQuery } from "./live";
import { LiveOverlay } from "./LiveOverlay";
import { type Workspace,isReady } from "./model";
import { ModeNav } from "./ModeTabs";
import { EASE_OUT } from "./motion";

const STAGE_H = 580;
const NARROW_STAGE_H = 420;

export function CubeEditor({ ws }: { ws: Workspace }) {
  const { runtime, background, anchors, art, live, mode, editing, cardFace, flash, focus, setHoverFaces, setPreview, setEditing, selectCard, onFaceClick } = useCubeEditor(ws);
  const wide = useMediaQuery("(min-width: 960px)");
  const reduced = useReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);

  // Narrow: the options fold away when the real cube is picked up, so bring the cube into view.
  useEffect(() => {
    if (live && !wide) stageRef.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [live, wide, reduced]);

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
        <div className="flex shrink-0 items-center gap-2">
          <LightsToggle ws={ws} />
          <PinTrackSwitch ws={ws} className="shrink-0" />
        </div>
      </div>
      <ModeNav value={mode} onChange={(m) => ws.update({ mode: m })} />
      <ModeEditor
        ws={ws}
        onHoverFaces={setHoverFaces}
        onPreview={setPreview}
        selected={cardFace}
        onSelect={selectCard}
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
        phase={runtime.view}
        result={runtime.view === "result" ? resultFor(runtime.roll) : null}
        highlight={focus}
        focus={focus}
        selected={editing}
        onFaceClick={onFaceClick}
        anchors={anchors}
        bootKey={ws.bootKey}
        shift={wide && !live ? 0.3 : 0}
        zoom={live ? (wide ? 1.32 : 1.6) : wide ? 1.12 : 1.2}
        frameY={runtime.view === "result" ? (wide ? -0.42 : -0.5) : 0}
        background={background}
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
      <LiveOverlay runtime={runtime} narrow={!wide} />
      {runtime.error && <p role="alert" className="absolute bottom-1 inset-x-4 z-30 text-center text-sm text-danger">{runtime.error}</p>}
    </div>
  );

  return (
    <div className="relative space-y-3">
      <div className="relative">
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
                inert={live}
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
