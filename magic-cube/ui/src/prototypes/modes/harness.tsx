import { HeroUIProvider } from "@heroui/react";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../../styles.css";
import { PickerHarness } from "../Picker";
import { SimPanel } from "../SimPanel";
import { Deck } from "./Deck";
import { Final } from "./Final";
import { Stage } from "./Stage";
import { Twin } from "./Twin";

/** Stand-in for the control room around the plugin iframe, so each variant is judged at its real size. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-black px-4 pb-40 pt-8">
      <div className="mx-auto max-w-[1072px]">
        <header className="mb-6 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-orange-500/90 text-lg">💡</div>
          <div>
            <div className="text-lg font-semibold leading-tight">Magic Cube</div>
            <div className="text-xs text-default-400">@rshallam · v1.1.0</div>
          </div>
          <div className="ml-auto rounded-full bg-content1 p-1 text-xs">
            <span className="rounded-full bg-default-200 px-3 py-1.5">Interface</span>
            <span className="px-3 py-1.5 text-default-400">Settings</span>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

const modeVariants = [
  {
    name: "Combined",
    Component: () => (
      <Frame>
        <Final />
      </Frame>
    ),
  },
  {
    name: "Twin",
    Component: () => (
      <Frame>
        <Twin />
      </Frame>
    ),
  },
  {
    name: "Stage",
    Component: () => (
      <Frame>
        <Stage />
      </Frame>
    ),
  },
  {
    name: "Deck",
    Component: () => (
      <Frame>
        <Deck />
      </Frame>
    ),
  },
];

const root = createRoot(document.getElementById("proto-root")!);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
root.render(
  <HeroUIProvider>
    <MotionConfig reducedMotion="user">
      {new URLSearchParams(location.search).get("explore") === "modes" ? <PickerHarness variants={modeVariants} /> : <Frame><Final /></Frame>}
      <SimPanel />
    </MotionConfig>
  </HeroUIProvider>,
);
