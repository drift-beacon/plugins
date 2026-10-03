import { cn } from "@heroui/theme";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Cube3D } from "./cube/Cube3D";
import { LIVE_COPY, LiveStepper, ModeCards, ModeEditor, NoticeToast, PinTrackSwitch, PresetMenu, ResultBody } from "./kit";
import { resultFor, useCubeArt, useMediaQuery } from "./live";
import { type Face, isReady, useWorkspace } from "./model";
import { EASE_OUT } from "./motion";
import { type CubeSim, useCubeSim } from "./sim";

const STAGE_H = 580;
const NARROW_STAGE_H = 420;

/**
 * Direction 1 — Twin: the config and the cube side by side, linked both ways (hover a card, the cube turns to its
 * faces; click a face, its card answers). When the real cube is picked up, the config steps back and the cube
 * glides to centre stage on the same canvas — nothing resizes, nothing reloads. On a narrow screen the options come
 * first and the cube sits below them.
 */
export function Twin() {
  const ws = useWorkspace();
  const sim = useCubeSim(ws);
  const wide = useMediaQuery("(min-width: 768px)");
  const reduced = useReducedMotion();
  const [hoverFaces, setHoverFaces] = useState<Face[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [selected, setSelected] = useState<Face | null>(null);
  const [flash, setFlash] = useState<{ key: string; n: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const art = useCubeArt(ws.setup, preview);
  const live = sim.view !== "idle";
  const mode = ws.setup.mode;
  const focus = selected ? [selected] : hoverFaces;

  // Narrow: the options fold away when the real cube is picked up, so bring the cube into view.
  useEffect(() => {
    if (live && !wide) stageRef.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [live, wide, reduced]);

  const onFaceClick = (f: Face) => {
    const slot = art.slots[f];
    if (mode === "manual") setSelected(f === selected ? null : f);
    else if (mode === "duel" && slot.side) setFlash({ key: slot.side, n: (flash?.n ?? 0) + 1 });
    else if (mode === "shortlist" && slot.item != null) setFlash({ key: String(slot.item), n: (flash?.n ?? 0) + 1 });
  };

  const config = (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PresetMenu ws={ws} />
        <PinTrackSwitch ws={ws} />
      </div>
      <ModeCards
        compact
        value={mode}
        onChange={(m) => {
          ws.update({ mode: m });
          setSelected(null);
        }}
      />
      <ModeEditor ws={ws} onHoverFaces={setHoverFaces} onPreview={setPreview} selected={selected} onSelect={setSelected} flash={flash} />
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
        selected={selected}
        onFaceClick={onFaceClick}
        bootKey={ws.bootKey}
        shift={wide && !live ? 0.3 : 0}
        zoom={live ? (wide ? 1.32 : 1.6) : wide ? 1.12 : 1.2}
        frameY={sim.view === "result" ? (wide ? -0.42 : -0.5) : 0}
        background="#18181b"
      />
      {/* Stacked under the options, the stage's glow melts into them instead of starting at a hard edge. */}
      {!wide && <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-content1 to-transparent" />}
      <LiveOverlay sim={sim} narrow={!wide} />
    </div>
  );

  return (
    <div className="relative">
      <NoticeToast notice={sim.notice} onDone={sim.clearNotice} className="absolute left-1/2 top-3 z-30 -translate-x-1/2" />
      <div className="relative overflow-hidden rounded-3xl border border-default-100 bg-content1" style={{ minHeight: wide ? STAGE_H : undefined }}>
        {wide ? (
          <>
            {stage}
            {/* The config steps back (and stops taking input) while the hardware has the floor. */}
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
  );
}

/** The stepper up top, and the prompt or the result below the cube. */
export function LiveOverlay({ sim, narrow }: { sim: CubeSim; narrow: boolean }) {
  const live = sim.view !== "idle";
  return (
    <>
      <AnimatePresence>
        {live && (
          <motion.div
            key="stepper"
            className={cn("absolute left-1/2 z-20 -translate-x-1/2", narrow ? "top-3" : "top-6")}
            initial={{ opacity: 0, transform: "translateY(-8px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            exit={{ opacity: 0, transform: "translateY(-8px)", transition: { duration: 0.15, ease: EASE_OUT } }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
          >
            <LiveStepper view={sim.view} size={narrow ? "sm" : "md"} />
          </motion.div>
        )}
      </AnimatePresence>
      <div className={cn("pointer-events-none absolute inset-x-0 z-20 flex justify-center px-5", narrow ? "bottom-5" : "bottom-8")}>
        <AnimatePresence mode="wait">
          {(sim.view === "held" || sim.view === "activated") && (
            <motion.div
              key={sim.view}
              className="text-center"
              initial={{ opacity: 0, transform: "translateY(8px)" }}
              animate={{ opacity: 1, transform: "translateY(0px)" }}
              exit={{ opacity: 0, transform: "translateY(-6px)", transition: { duration: 0.12, ease: EASE_OUT } }}
              transition={{ duration: 0.22, ease: EASE_OUT }}
            >
              <div className={cn("font-bold", narrow ? "text-2xl" : "text-3xl")}>{LIVE_COPY[sim.view].title}</div>
              <div className="mt-1 text-default-500">{LIVE_COPY[sim.view].body}</div>
            </motion.div>
          )}
          {sim.view === "result" && sim.roll && (
            <motion.div key={`result-${sim.roll.id}`} className="pointer-events-auto" exit={{ opacity: 0, transform: "translateY(8px)", transition: { duration: 0.15, ease: EASE_OUT } }}>
              <ResultBody roll={sim.roll} onTrack={sim.track} onDismiss={sim.dismiss} onDiscard={sim.discard} hideIcon compact={narrow} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}
