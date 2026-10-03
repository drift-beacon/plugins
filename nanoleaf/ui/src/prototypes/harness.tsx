import { HeroUIProvider } from "@heroui/react";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../styles.css";
import { App } from "../App.tsx";
import { ModelProvider } from "../model.ts";
import type { LayoutKey, StartState } from "./fixtures.ts";
import { PickerHarness, type Variant } from "./Picker.tsx";
import { SimPanel } from "./SimPanel.tsx";
import { useSimModel } from "./sim-model.ts";

/** Stand-in for the control room around the plugin iframe, so each variant is judged at its real size. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background px-4 pt-8 pb-40 text-foreground">
      <div className="mx-auto max-w-[1072px]">
        <header className="mb-6 flex items-center gap-3">
          <img src="/icon.png" alt="" className="h-11 w-11 rounded-xl bg-content1 object-cover" />
          <div>
            <div className="font-semibold text-lg leading-tight">Nanoleaf</div>
            <div className="text-default-400 text-xs">@rshallam · v0.2.0</div>
          </div>
          <div className="ml-auto rounded-full bg-content1 p-1 text-xs">
            <span className="rounded-full bg-default-200 px-3 py-1.5">Interface</span>
            <span className="px-3 py-1.5 text-default-400">Settings</span>
          </div>
        </header>
        {/* The control room shows the iframe in a bordered panel (no overflow clip: the wall is sticky). */}
        <div className="rounded-2xl border border-divider bg-background">{children}</div>
      </div>
    </div>
  );
}

/** The production App over the simulator: the variants differ only in fixtures and starting state. */
function simVariant(name: string, layout: LayoutKey | null, start: StartState): Variant {
  function SimulatedApp() {
    const sim = useSimModel(layout, { start });
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
  simVariant("Mixed wall", "theduck", "live-goal"),
  simVariant("Triangles", "wings", "pinned"),
  simVariant("Hexagon honeycomb", "hexagons", "live"),
  simVariant("Big mixed", "big", "near-goal"),
  simVariant("First run", null, "live-goal"),
];

// One root across hot updates: an edit to a module this one imports re-runs it.
const root: Root = import.meta.hot?.data.root ?? createRoot(document.getElementById("proto-root")!);
if (import.meta.hot) import.meta.hot.data.root = root;

root.render(
  <HeroUIProvider>
    <MotionConfig reducedMotion="user">
      <PickerHarness variants={variants} />
      <SimPanel />
    </MotionConfig>
  </HeroUIProvider>,
);
