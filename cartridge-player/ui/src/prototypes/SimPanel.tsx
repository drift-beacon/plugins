// Prototype-only: stands in for the physical player, the workspace and the plugin's main. Every hardware button is a
// report the player would send; the rest are things that happen elsewhere (the app, the server).
import { useEffect, useState } from "react";
import { onSimState, type SimEvent, type SimReadout, sendSim } from "./sim-model.ts";
import { applyHostTheme, hostMode } from "./theme.ts";
import "./sim-panel.css";

const HARDWARE: [label: string, key: string, event: SimEvent, title: string][] = [
  ["Insert", "I", { type: "insert" }, "Insert the next labelled cartridge (ejects first)"],
  ["Blank", "N", { type: "blank" }, "Insert a blank cartridge (ejects first)"],
  ["Eject", "E", { type: "eject" }, "Pull the cartridge out"],
  ["Swap", "W", { type: "swap" }, "One cartridge replaces another in a single report"],
  ["Report", "P", { type: "report" }, "The player reports its slot as it is: its first report after it's set up"],
];

const ELSEWHERE: [label: string, key: string, event: SimEvent, title: string][] = [
  ["End session", "X", { type: "end-elsewhere" }, "End the slot's session in the app; the cartridge stays in"],
  ["Start other", "S", { type: "start-elsewhere" }, "Start Cook dinner in the app"],
  ["Delete act.", "D", { type: "delete-activity" }, "Delete the slot's activity (Deep work if empty)"],
  ["Archive act.", "A", { type: "archive-activity" }, "Archive or restore the slot's activity"],
  ["Offline", "O", { type: "offline" }, "The player stops (or starts again) reporting"],
  ["Main", "M", { type: "main" }, "Stop or start the plugin's main; started again, it waits a few seconds to hear from the player"],
  ["Fail next", "F", { type: "fail-next" }, "The next request to main times out"],
  ["Fail save", "V", { type: "fail-save" }, "Storage refuses the next label, forget or dismiss: main answers that it couldn't save it"],
  ["Fail start", "T", { type: "fail-start" }, "The next start or mark is refused by the app: main records the error on the slot"],
  ["Late beat", "B", { type: "late-beat" }, "The reading message arrives after its outcome (toggle)"],
];

/** The simulator's controls, outside the variant tree; keys work anywhere except in a text field. */
export function SimPanel({ onReducedMotion, reduced }: { onReducedMotion(): void; reduced: boolean }) {
  const [readout, setReadout] = useState<SimReadout | null>(null);
  const [mode, setMode] = useState(hostMode);
  useEffect(() => onSimState(setReadout), []);

  useEffect(() => {
    const all = [...HARDWARE, ...ELSEWHERE];
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      // Keys the interface itself answered, or pressed inside it, are its own: the panel takes the rest.
      if (e.defaultPrevented || t.closest(".cp-deck, [role='dialog'], [role='listbox']")) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toUpperCase();
      const hit = all.find(([, key]) => key === k);
      if (hit) sendSim(hit[2]);
      else if (k === "L") toggleTheme();
      else if (k === "Q") onReducedMotion();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const toggleTheme = () => {
    const next = hostMode() === "dark" ? "light" : "dark";
    applyHostTheme(next);
    setMode(next);
  };

  const row = (buttons: typeof HARDWARE) => (
    <div className="sim-grid">
      {buttons.map(([label, key, event, title]) => (
        <button key={key} className="sim-btn" title={`${title} (${key})`} onClick={() => sendSim(event)}>
          {label}
          <kbd>{key}</kbd>
        </button>
      ))}
    </div>
  );

  return (
    <div className="sim-panel" aria-label="Simulator">
      <div className="sim-title">
        <span>Player</span>
        <button className="sim-item" style={{ width: "auto", padding: 0 }} onClick={() => sendSim({ type: "reset" })}>
          <span>Reset</span>
        </button>
      </div>
      {row(HARDWARE)}
      <div className="sim-title sim-gap">
        <span>Elsewhere</span>
      </div>
      {row(ELSEWHERE)}
      <div className="sim-grid sim-gap">
        <button className="sim-btn" onClick={toggleTheme} title="Light or dark host theme (L)">
          {mode === "dark" ? "Light" : "Dark"}
          <kbd>L</kbd>
        </button>
        <button className="sim-btn" onClick={onReducedMotion} title="Force reduced motion, in Motion and in the CSS loops (Q)">
          {reduced ? "Motion" : "Reduce"}
          <kbd>Q</kbd>
        </button>
      </div>
      {readout && (
        <p className="sim-foot">
          {readout.slot ? `In: ${readout.slot.slice(0, 8)}` : "Slot empty"} · {readout.online ? "online" : "offline"} ·{" "}
          {readout.mainRunning ? (readout.waiting ? "main waiting to hear" : "main running") : "main stopped"}
          {readout.failNext ? " · next times out" : ""}
          {readout.failSave ? " · next save refused" : ""}
          {readout.failStart ? " · next start fails" : ""}
          {readout.lateBeat ? " · beat late" : ""}
        </p>
      )}
    </div>
  );
}
