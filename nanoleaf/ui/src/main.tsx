import { HeroUIProvider } from "@heroui/react";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./styles.css";
import { App } from "./App.tsx";
import { connectUi } from "./drift-beacon.ts";
import { useLiveModel } from "./live-model.ts";
import { ModelProvider } from "./model.ts";

/**
 * Everything the view needs around it: HeroUI, reduced motion from the OS, and the model. MotionConfig's
 * `reducedMotion` only reduces positional keys (x, scale, width…), not the `transform` strings this code animates,
 * so every such animation checks `useReducedMotion()` itself.
 */
function Providers({ children }: { children: ReactNode }) {
  return (
    <HeroUIProvider>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </HeroUIProvider>
  );
}

/** The live model over the connected `ctx`. */
function LiveApp() {
  const model = useLiveModel();
  return (
    <ModelProvider value={model}>
      <App />
    </ModelProvider>
  );
}

/** Before the app answers: quiet, and only after a beat, so a quick connection never flashes it. */
function Loading() {
  return (
    <div className="grid min-h-[400px] place-items-center p-6">
      <div className="nl-appear flex items-center gap-2.5 text-default-400 text-sm">
        <span className="h-1.5 w-1.5 rounded-full bg-default-400" />
        Connecting to Drift Beacon…
      </div>
    </div>
  );
}

/** The app didn't accept this UI: say why, and what to try. */
function Failed({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="grid min-h-[400px] place-items-center p-6">
      <div className="max-w-sm rounded-2xl bg-content1 p-5 ring-1 ring-default-100">
        <div className="font-semibold text-danger">The Nanoleaf plugin couldn't connect</div>
        <p className="mt-1.5 text-default-500 text-sm">{message}</p>
        <p className="mt-3 text-default-400 text-xs">Reload the page to try again.</p>
      </div>
    </div>
  );
}

// One root across hot updates: an edit to a module this one imports re-runs it.
const root: Root = import.meta.hot?.data.root ?? createRoot(document.getElementById("plugin-root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(
  <Providers>
    <Loading />
  </Providers>,
);

connectUi().then(
  () =>
    root.render(
      <Providers>
        <LiveApp />
      </Providers>,
    ),
  (error: unknown) =>
    root.render(
      <Providers>
        <Failed error={error} />
      </Providers>,
    ),
);
