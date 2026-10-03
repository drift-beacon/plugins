// Prototype-only: the three directions explored before the Deck was chosen, as they were, behind `?explore=1`.
import { HeroUIProvider } from "@heroui/react";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./explore.css";
import { PickerHarness } from "../Picker.tsx";
import { Deck } from "./Deck.tsx";
import { Marquee } from "./Marquee.tsx";
import { Receiver } from "./Receiver.tsx";
import { SimPanel } from "./SimPanel.tsx";

/** Stand-in for the control room around the plugin iframe, so each variant is judged at its real size. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-black px-4 pb-40 pt-8 text-foreground">
      <div className="mx-auto max-w-[1072px]">
        <header className="mb-6 flex items-center gap-3">
          <img src="/icon.png" alt="" className="h-11 w-11 rounded-xl bg-content1 object-cover" />
          <div>
            <div className="text-lg font-semibold leading-tight">Cartridge Player</div>
            <div className="text-xs text-default-400">@rshallam · v1.1.0 · explorations</div>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

const variants = [
  {
    name: "Deck",
    Component: () => (
      <Frame>
        <Deck />
      </Frame>
    ),
  },
  {
    name: "Marquee",
    Component: () => (
      <Frame>
        <Marquee />
      </Frame>
    ),
  },
  {
    name: "Receiver",
    Component: () => (
      <Frame>
        <Receiver />
      </Frame>
    ),
  },
];

document.documentElement.classList.add("dark");
createRoot(document.getElementById("proto-root")!).render(
  <HeroUIProvider>
    <MotionConfig reducedMotion="user">
      <PickerHarness variants={variants} />
      <SimPanel />
    </MotionConfig>
  </HeroUIProvider>,
);
