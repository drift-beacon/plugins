import { type ReactNode, useEffect, useState } from "react";
import { progressPercent } from "../../../shared/scene.ts";
import { onSimState, type SimAction, type SimReadout, sendSim } from "./sim-model.ts";
import "./sim-panel.css";
import { applyHostTheme, hostMode } from "./theme.ts";

interface SimButton {
  readonly key: string;
  readonly label: string;
  readonly title: string;
  readonly action: SimAction;
}

/** The app and the wall, as keys that avoid the picker's (1…n, ←/→, R). */
const APP: readonly SimButton[] = [
  {
    key: "S",
    label: "Start",
    title: "Start a session on an activity with a goal",
    action: { type: "start", goal: true },
  },
  {
    key: "G",
    label: "No goal",
    title: "Start a session on an activity without a goal",
    action: { type: "start", goal: false },
  },
  { key: "E", label: "End", title: "End the live session", action: { type: "end" } },
  { key: "P", label: "Pin", title: "Pin or unpin an activity", action: { type: "pin" } },
  {
    key: "X",
    label: "Archive",
    title: "Archive (again to restore) the activity you're live on: its session still glows",
    action: { type: "archive" },
  },
  { key: "+", label: "+10%", title: "Add 10% of the goal to what the wall shows", action: { type: "progress" } },
  { key: "T", label: "Time ×60", title: "Run the clock sixty times faster", action: { type: "speed" } },
];

const WALL: readonly SimButton[] = [
  {
    key: "U",
    label: "Offline",
    title: "The controller stops answering (again to reconnect)",
    action: { type: "unreachable" },
  },
  {
    key: "A",
    label: "Token",
    title: "The controller rejects the token (again to restore)",
    action: { type: "unauthorized" },
  },
  { key: "Y", label: "Takeover", title: "Someone picks an effect in the Nanoleaf app", action: { type: "takeover" } },
  {
    key: "C",
    label: "Cube",
    title: "Magic Cube takes the wall: picked up, shaken, landed, let go (press again for the next step)",
    action: { type: "control" },
  },
  { key: "W", label: "Touch", title: "Tap a random panel on the wall", action: { type: "tap" } },
  { key: "B", label: "Busy", title: "Another user's instance holds the controller", action: { type: "busy" } },
  { key: "M", label: "Main", title: "Main stops running (again to restart)", action: { type: "main" } },
  {
    key: "D",
    label: "Other copy",
    title: "Another copy of the interface pairs the controller (again to forget it)",
    action: { type: "elsewhere" },
  },
  {
    key: "O",
    label: "Old app",
    title: "The app doesn't send goals or pins (SDK < 0.2.2)",
    action: { type: "old-app" },
  },
];

/** The app switches between its light and dark theme (the plugin's UI must read in both). */
const THEME = { key: "L", title: "The app switches between its light and dark theme" } as const;

const toggleTheme = () => applyHostTheme(hostMode() === "dark" ? "light" : "dark");

/** Stands in for Drift Beacon and the wall: every button is something the app or the controller would do. */
export function SimPanel() {
  const [readout, setReadout] = useState<SimReadout | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => onSimState(setReadout), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key === "=" ? "+" : e.key.toUpperCase();
      const button = [...APP, ...WALL].find((b) => b.key === key);
      if (button) sendSim(button.action);
      else if (key === THEME.key) toggleTheme();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const row = (buttons: readonly SimButton[], extra?: ReactNode) => (
    <div className="sim-row">
      {buttons.map((b) => (
        <button key={b.key} className="sim-btn" title={`${b.title} (${b.key})`} onClick={() => sendSim(b.action)}>
          {b.label}
          <kbd>{b.key}</kbd>
        </button>
      ))}
      {extra}
    </div>
  );
  const theme = (
    <button className="sim-btn" title={`${THEME.title} (${THEME.key})`} onClick={toggleTheme}>
      Theme
      <kbd>{THEME.key}</kbd>
    </button>
  );

  return (
    <div className="sim-panel" aria-label="Nanoleaf simulator" data-collapsed={collapsed ? "" : undefined}>
      <button className="sim-title" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
        <span className="sim-name">Simulator</span>
        <span className="sim-readout">
          {readout && <span className="sim-dot" data-mode={readout.mode} />}
          {readout ? describe(readout) : "…"}
        </span>
      </button>
      {!collapsed && (
        <>
          <div className="sim-group">Drift Beacon</div>
          {row(APP, theme)}
          <div className="sim-group">Wall and main</div>
          {row(WALL)}
          <p className="sim-foot">Pairing with Winds fails once; an address starting 10. never answers.</p>
        </>
      )}
    </div>
  );
}

function describe(r: SimReadout): string {
  const parts: string[] = [r.mode];
  if (r.activity) parts.push(r.activity);
  if (r.fraction !== null) parts.push(`${progressPercent(r.fraction)}%`);
  if (r.speed > 1) parts.push(`×${r.speed}`);
  return parts.join(" · ");
}
