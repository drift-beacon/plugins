// Prototype-only (prototype.html?setup): four directions for the first-run screen, one at a time, over the simulator's
// first-run model. Nothing here ships. Keys: 1-4 or arrows switch direction, R restarts it, P connects the player,
// H toggles whether the page knows the hub's address, M previews a phone, L switches theme.
import { MotionConfig } from "motion/react";
import { type ReactNode, useEffect, useMemo, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import manifest from "../../../../manifest.json";
import "./setup.css";
import "../harness.css";
import "../sim-panel.css";
import { ModelProvider } from "../../model.ts";
import { PickerHarness, type Variant } from "../Picker.tsx";
import { useSimModel } from "../sim-model.ts";
import { applyHostTheme, hostMode } from "../theme.ts";
import { Checklist } from "./Checklist.tsx";
import { Guided } from "./Guided.tsx";
import { ProtoContext } from "./shared.tsx";
import { Storyboard } from "./Storyboard.tsx";
import { Ticket } from "./Ticket.tsx";

interface Controls {
  readonly connected: boolean;
  readonly phone: boolean;
  /** The page was opened at an address a player can reach, so the hub's address is prefilled. */
  readonly hubKnown: boolean;
  readonly mode: "dark" | "light";
}

const query = new URLSearchParams(location.search);
const flag = (name: string, fallback: boolean) => (query.has(name) ? query.get(name) !== "0" : fallback);
if (flag("light", false)) applyHostTheme("light");

// Kept outside the directions: the picker remounts a direction when it switches, and these describe the world.
let controls: Controls = {
  connected: flag("connected", false),
  phone: flag("phone", false),
  hubKnown: flag("hub", true),
  mode: hostMode(),
};
const listeners = new Set<() => void>();
function set(patch: Partial<Controls>) {
  controls = { ...controls, ...patch };
  for (const listener of listeners) listener();
}
const useControls = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => controls,
  );

function Frame({ children }: { children: ReactNode }) {
  const { phone } = useControls();
  return (
    <div className={phone ? "harness-room setup-phone" : "harness-room"}>
      <div className="harness-inner">
        <header className="harness-header">
          <img src="/icon.png" alt="" />
          <div>
            <div className="harness-title">Cartridge Player</div>
            <div className="harness-sub">@rshallam · v{manifest.version} · first run, explorations</div>
          </div>
        </header>
        <div className="harness-frame">{children}</div>
      </div>
    </div>
  );
}

function direction(name: string, Direction: () => ReactNode): Variant {
  function Screen() {
    const sim = useSimModel("first-run");
    const { connected, phone, hubKnown } = useControls();
    // The simulator runs on localhost, which no player can reach; a real page is usually opened at the hub's address.
    const model = useMemo(() => ({ ...sim, pageHost: hubKnown ? "192.168.1.12" : "localhost" }), [sim, hubKnown]);
    const proto = useMemo(() => ({ connected, phone }), [connected, phone]);
    return (
      <Frame>
        <ModelProvider value={model}>
          <ProtoContext.Provider value={proto}>
            {/* Remounted when the address case changes: the fields start from the page's guess. */}
            <Direction key={String(hubKnown)} />
          </ProtoContext.Provider>
        </ModelProvider>
      </Frame>
    );
  }
  return { name, Component: Screen };
}

const variants: Variant[] = [
  direction("Guided", Guided),
  direction("Ticket", Ticket),
  direction("Checklist", Checklist),
  direction("Storyboard", Storyboard),
];

const toggleTheme = () => {
  const mode = hostMode() === "dark" ? "light" : "dark";
  applyHostTheme(mode);
  set({ mode });
};

const BUTTONS: [label: (c: Controls) => string, key: string, run: () => void, title: string][] = [
  [(c) => (c.connected ? "Disconnect" : "Player connects"), "P", () => set({ connected: !controls.connected }), "The player reports for the first time"],
  [(c) => (c.hubKnown ? "Hub unknown" : "Hub known"), "H", () => set({ hubKnown: !controls.hubKnown }), "Whether the page can guess the hub's address"],
  [(c) => (c.phone ? "Desktop" : "Phone"), "M", () => set({ phone: !controls.phone }), "Preview at a phone's width"],
  [(c) => (c.mode === "dark" ? "Light" : "Dark"), "L", toggleTheme, "Light or dark host theme"],
];

function Panel() {
  const state = useControls();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.defaultPrevented || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      BUTTONS.find(([, key]) => key === e.key.toUpperCase())?.[2]();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="sim-panel" aria-label="Prototype controls">
      <div className="sim-title">
        <span>First run</span>
      </div>
      <div className="sim-grid">
        {BUTTONS.map(([label, key, run, title]) => (
          <button key={key} className="sim-btn" title={`${title} (${key})`} onClick={run}>
            {label(state)}
            <kbd>{key}</kbd>
          </button>
        ))}
      </div>
    </div>
  );
}

const root: Root = import.meta.hot?.data.root ?? createRoot(document.getElementById("proto-root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(
  <MotionConfig reducedMotion="user">
    <PickerHarness variants={variants} />
    <Panel />
  </MotionConfig>,
);
