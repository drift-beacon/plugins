import { useEffect, useRef, useState } from "react";
import { activityById, BLANK_TAGS, LIBRARY } from "./fixtures";
import { sendSim } from "./model";
import "../sim-panel.css";

/** Stands in for the physical player: every button is a report the ESP32 would send. */
export function SimPanel() {
  const [open, setOpen] = useState(false);
  const nextKnown = useRef(1);
  const nextBlank = useRef(0);

  const insertKnown = () => {
    const c = LIBRARY[nextKnown.current % LIBRARY.length];
    nextKnown.current += 1;
    sendSim({ action: "insert", tag: c.tag });
  };
  const insertBlank = () => {
    const tag = BLANK_TAGS[nextBlank.current % BLANK_TAGS.length];
    nextBlank.current += 1;
    sendSim({ action: "insert", tag });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "i") insertKnown();
      else if (k === "n") insertBlank();
      else if (k === "e") sendSim({ action: "eject" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="sim-panel" aria-label="Player simulator">
      <div className="sim-title">
        <span>Player simulator</span>
        <button className="sim-item" style={{ width: "auto", padding: 0 }} onClick={() => sendSim({ action: "reset" })}>
          <span>Reset</span>
        </button>
      </div>
      <div className="sim-row">
        <button className="sim-btn" onClick={() => setOpen((o) => !o)} title="Insert a labelled cartridge (I)">
          Insert<kbd>I</kbd>
        </button>
        <button className="sim-btn" onClick={insertBlank} title="Insert a blank cartridge (N)">
          Blank<kbd>N</kbd>
        </button>
        <button className="sim-btn" onClick={() => sendSim({ action: "eject" })} title="Pull the cartridge out (E)">
          Eject<kbd>E</kbd>
        </button>
      </div>
      {open && (
        <div className="sim-list">
          <div className="sim-group">Labelled</div>
          {LIBRARY.map((c) => (
            <button
              key={c.tag}
              className="sim-item"
              onClick={() => {
                sendSim({ action: "insert", tag: c.tag });
                setOpen(false);
              }}
            >
              <span>{activityById(c.activityId)?.name ?? "Deleted activity"}</span>
              <span>{c.tag.slice(0, 8)}</span>
            </button>
          ))}
          <div className="sim-group">Blank</div>
          {BLANK_TAGS.map((tag, i) => (
            <button
              key={tag}
              className="sim-item"
              onClick={() => {
                sendSim({ action: "insert", tag });
                setOpen(false);
              }}
            >
              <span>Blank cartridge {i + 1}</span>
              <span>{tag.slice(0, 8)}</span>
            </button>
          ))}
        </div>
      )}
      <p className="sim-foot">Swapping cartridges ejects the one in the slot first.</p>
    </div>
  );
}
