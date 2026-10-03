import { useEffect, useState } from "react";
import { FACES } from "./modes/model";
import { type CubeState, fireSim, onSimState, type SimAction } from "./modes/sim";
import "./sim-panel.css";

const KEYS: Record<string, SimAction> = {
  h: { type: "hold" },
  s: { type: "shake" },
  d: { type: "setDown" },
  t: { type: "timeout" },
  c: { type: "nextPreset" },
  p: { type: "fullRoll" },
};

/**
 * Harness chrome: stands in for the Aqara cube and NFC reader by firing the hardware events the plugin
 * listens to. Keys avoid the picker's (digits, arrows, R).
 */
export function SimPanel({ initialOpen }: { initialOpen?: boolean } = {}) {
  const [state, setState] = useState<CubeState>("idle");
  // On a phone-sized window the panel starts folded so it doesn't cover the layout; the keys work either way.
  const [open, setOpen] = useState(() => initialOpen ?? window.innerWidth >= 640);
  useEffect(() => onSimState(setState), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const action = KEYS[e.key.toLowerCase()];
      if (action) fireSim(action);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="sim-panel" aria-label="Cube simulator">
      <button className="sim-panel-head" aria-expanded={open} title={open ? "Fold the simulator" : "Show the simulator"} onClick={() => setOpen((o) => !o)}>
        <span>Aqara cube</span>
        <span className="sim-panel-state">
          <span className="sim-panel-dot" data-state={state} />
          {state}
        </span>
      </button>
      {open && (
        <>
          <div className="sim-panel-row">
            <button className="sim-panel-btn sim-panel-primary" onClick={() => fireSim({ type: "fullRoll" })}>
              ▶ Full roll <kbd>P</kbd>
            </button>
            <button className="sim-panel-btn" onClick={() => fireSim({ type: "nextPreset" })}>
              Next preset <kbd>C</kbd>
            </button>
          </div>
          <div className="sim-panel-row">
            <button className="sim-panel-btn" onClick={() => fireSim({ type: "hold" })}>
              Pick up <kbd>H</kbd>
            </button>
            <button className="sim-panel-btn" onClick={() => fireSim({ type: "shake" })}>
              Shake <kbd>S</kbd>
            </button>
            <button className="sim-panel-btn" onClick={() => fireSim({ type: "timeout" })}>
              1 min idle <kbd>T</kbd>
            </button>
          </div>
          <div className="sim-panel-row">
            <button className="sim-panel-btn" onClick={() => fireSim({ type: "setDown" })}>
              Set down <kbd>D</kbd>
            </button>
            {FACES.map((f) => (
              <button key={f} className="sim-panel-btn sim-panel-face" title={`Set down, face ${f} up`} onClick={() => fireSim({ type: "setDown", side: f })}>
                {f}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
