import { MotionConfig } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import manifest from "../../../manifest.json";
import "../styles.css";
import "./harness.css";
import { App } from "../App.tsx";
import { settleWhileHidden } from "../lib/background.ts";
import { ModelProvider } from "../model.ts";
import { PickerHarness, type Variant } from "./Picker.tsx";
import { SimPanel } from "./SimPanel.tsx";
import type { StartState } from "./sim-fixtures.ts";
import { useSimModel } from "./sim-model.ts";

/** Stand-in for the control room around the plugin's iframe, so the interface is judged at its real size. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="harness-room">
      <div className="harness-inner">
        <header className="harness-header">
          <img src="/icon.png" alt="" />
          <div>
            <div className="harness-title">Cartridge Player</div>
            <div className="harness-sub">@rshallam · v{manifest.version} · simulated</div>
          </div>
        </header>
        <div className="harness-frame">{children}</div>
      </div>
    </div>
  );
}

/** The production App over the simulator: the variants differ only in where the simulator starts. */
function simVariant(name: string, start: StartState): Variant {
  function SimulatedApp() {
    const sim = useSimModel(start);
    return (
      <Frame>
        <ModelProvider value={sim}>
          <App />
        </ModelProvider>
      </Frame>
    );
  }
  return { name, Component: SimulatedApp };
}

const variants: Variant[] = [
  simVariant("Playing", "playing"),
  simVariant("First run", "first-run"),
  simVariant("Empty shelf", "empty-shelf"),
  simVariant("Seen, not labelled", "seen"),
  simVariant("60 cartridges", "big"),
];

/**
 * Reduced motion can be forced here, since a browser can't be told to prefer it from a page: Motion through its own
 * setting, and the CSS loops through `data-reduce` on the root, under which harness.css repeats deck.css's
 * reduced-motion rules.
 */
function Harness() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    document.documentElement.toggleAttribute("data-reduce", reduced);
  }, [reduced]);
  return (
    <MotionConfig reducedMotion={reduced ? "always" : "user"}>
      <PickerHarness variants={variants} />
      <SimPanel reduced={reduced} onReducedMotion={() => setReduced((r) => !r)} />
    </MotionConfig>
  );
}

// One root across hot updates: an edit to a module this one imports re-runs it.
const root: Root = import.meta.hot?.data.root ?? createRoot(document.getElementById("proto-root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
settleWhileHidden();
root.render(<Harness />);
