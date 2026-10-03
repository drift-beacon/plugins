import { ChevronDown,X } from "lucide-react";
import { AnimatePresence,motion } from "motion/react";
import { useEffect,useState,type ReactNode } from "react";
import { Cube3D } from "./cube/Cube3D";
import { useCubeEditor } from "./editor";
import { FaceEditor } from "./face-editor";
import { LiveIcon } from "./icons";
import { LightsToggle,ModeEditor,PinTrackSwitch } from "./kit";
import { resultFor } from "./live";
import { LiveOverlay } from "./LiveOverlay";
import { cubeArt,FACES,faceSlots,isReady,MODES,type Workspace } from "./model";
import { ModeNav } from "./ModeTabs";
import { EASE_DRAWER,EASE_OUT } from "./motion";
import { PresetActions } from "./preset-card";
import { NewPreset } from "./preset-controls";

/**
 * The phone layout: the cube comes first and stays put. It is pinned to the top of the view under the loaded
 * preset's name, the options scroll underneath it, and the presets live in a sheet opened from that name.
 */
export function PhoneView({ ws }: { ws: Workspace }) {
  const ed = useCubeEditor(ws);
  const { runtime, live } = ed;
  const [presetsOpen, setPresetsOpen] = useState(false);
  const mode = MODES.find((m) => m.id === ed.mode)!;
  const name = ws.active?.name ?? "Unsaved setup";

  // The hardware has the floor: back to the top, where the cube now fills the view.
  useEffect(() => {
    if (!live) return;
    setPresetsOpen(false);
    window.scrollTo({ top: 0 });
  }, [live]);

  return (
    <div className="ps-study phone-view">
      <div className="phone-stage">
        <div className="phone-bar">
          <button className="phone-switcher" aria-haspopup="dialog" aria-label={`Presets, ${name} loaded`} disabled={live} onClick={() => setPresetsOpen(true)}>
            <LiveIcon path={mode.iconPath} size={18} />
            <span className={ws.active ? "truncate" : "truncate text-default-500"}>{name}</span>
            <ChevronDown size={16} className="shrink-0 text-default-400" />
          </button>
          <LightsToggle ws={ws} />
          <PinTrackSwitch ws={ws} className="phone-switch shrink-0" />
        </div>
        <div className="phone-cube" data-live={live}>
          <Cube3D
            className="absolute inset-0"
            faces={ed.art.faces}
            flicker={ed.art.flicker}
            phase={runtime.view}
            result={runtime.view === "result" ? resultFor(runtime.roll) : null}
            highlight={ed.focus}
            focus={ed.focus}
            selected={ed.editing}
            onFaceClick={ed.onFaceClick}
            anchors={ed.anchors}
            bootKey={ws.bootKey}
            zoom={live ? 1.6 : 1.12}
            frameY={runtime.view === "result" ? -0.5 : 0}
            background={ed.background}
          />
          <LiveOverlay runtime={runtime} narrow />
          {runtime.error && <p role="alert" className="absolute bottom-1 inset-x-4 z-30 text-center text-sm text-danger">{runtime.error}</p>}
        </div>
      </div>
      {ws.error && <div role="alert" className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-xl bg-danger/10 p-3 text-sm text-danger"><span>{ws.error}</span><button onClick={ws.clearError} aria-label="Dismiss error">Dismiss</button></div>}
      {!live && (
        <div className="preset-editor-config phone-config">
          <ModeNav value={ed.mode} onChange={(m) => ws.update({ mode: m })} />
          <ModeEditor ws={ws} onHoverFaces={ed.setHoverFaces} onPreview={ed.setPreview} selected={ed.cardFace} onSelect={ed.selectCard} flash={ed.flash} />
          {!isReady(ws.setup) && <p className="mt-3 text-xs text-warning">Some faces are empty — rolling one of them won't start anything.</p>}
        </div>
      )}
      <Sheet open={presetsOpen} onClose={() => setPresetsOpen(false)} title="Presets">
        <PresetRows ws={ws} onDone={() => setPresetsOpen(false)} />
      </Sheet>
      {/* Docked to the view, not the stage: a phone's stage is too short for the picker, and the cube stays in sight above it. */}
      <div className="phone-face-dock">
        <AnimatePresence>
          {ed.editing && !live && <FaceEditor key="editor" face={ed.editing} ws={ws} slot={ed.art.slots[ed.editing]} anchors={ed.anchors} placement="bottom" onClose={() => ed.setEditing(null)} />}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** A sheet over the whole view, from the bottom edge. Tapping outside or Esc closes it. */
function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && <motion.div key="scrim" className="phone-scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: EASE_OUT }} />}
      {open && (
        <motion.div
          key="sheet"
          role="dialog"
          aria-modal
          aria-label={title}
          className="phone-sheet"
          initial={{ transform: "translateY(100%)" }}
          animate={{ transform: "translateY(0%)" }}
          exit={{ transform: "translateY(100%)", transition: { duration: 0.2, ease: EASE_OUT } }}
          transition={{ duration: 0.28, ease: EASE_DRAWER }}
        >
          <div className="phone-sheet-head">
            <strong>{title}</strong>
            <button aria-label="Close" onClick={onClose} className="phone-icon-button"><X size={16} /></button>
          </div>
          <div className="phone-sheet-body">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Every preset as a full-width row: the whole name, its mode, its faces. */
function PresetRows({ ws, onDone }: { ws: Workspace; onDone: () => void }) {
  const unsaved = !ws.active && Object.values(faceSlots(ws.setup)).some(s => s.mapping);
  return (
    <div className="phone-presets">
      {ws.presets.map((p) => {
        const mode = MODES.find((m) => m.id === p.setup.mode)!;
        const { faces } = cubeArt(p.setup);
        const active = p.id === ws.activeId;
        return (
          <div key={p.id} className="phone-preset" data-active={active}>
            <button aria-pressed={active} aria-label={`Load ${p.name}`} onClick={() => { if (!active) void ws.select(p.id); onDone(); }}>
              <span className="phone-preset-icon"><LiveIcon path={mode.iconPath} size={18} /></span>
              <span className="min-w-0 flex-1">
                <span className="phone-preset-name">{p.name}</span>
                <span className="phone-preset-meta">{mode.name} · {p.autoStart ? "Track" : "Pin"}</span>
              </span>
              <span className="phone-preset-faces" aria-hidden>{FACES.map((f) => <i key={f} style={{ background: faces[f].color ?? "color-mix(in srgb, var(--db-foreground) 12%, transparent)" }} />)}</span>
            </button>
            <PresetActions preset={p} ws={ws} />
          </div>
        );
      })}
      {!ws.presets.length && <p className="ps-empty-copy">A preset saves the way your cube chooses. Start with one for your everyday routine.</p>}
      {unsaved && <NewPreset ws={ws} saveCurrent tile label="Save setup" onCreated={onDone} />}
      <NewPreset ws={ws} tile onCreated={onDone} />
    </div>
  );
}
