import { MotionConfig } from "motion/react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./styles.css";
import { App } from "./App.tsx";
import { connectUi } from "./drift-beacon.ts";
import { settleWhileHidden } from "./lib/background.ts";
import { useLiveModel } from "./live-model.ts";
import { ModelProvider } from "./model.ts";

/**
 * Reduced motion from the OS around everything. MotionConfig's `reducedMotion` only reduces positional keys (x,
 * scale, width…), not the `transform` strings this code animates, so every such animation checks
 * `useReducedMotionConfig()` itself.
 */
function Providers({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
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
      <div role="status" className="cp-appear flex items-center gap-2.5 text-sm text-default-400">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-default-400" />
        Connecting to Drift Beacon…
      </div>
    </div>
  );
}

/** Something went wrong: say what, and what to try. */
function Failed({ title, error }: { title: string; error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="grid min-h-[400px] place-items-center p-6">
      <div role="alert" className="max-w-sm rounded-2xl bg-content1 p-5 ring-1 ring-default-100">
        <div className="font-semibold text-danger">{title}</div>
        <p className="mt-1.5 text-sm text-default-500">{message}</p>
        <p className="mt-3 text-xs text-default-400">Reload the page to try again.</p>
      </div>
    </div>
  );
}

/** A render error shows what happened instead of a blank frame. */
class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Cartridge Player: the interface failed", error, info.componentStack);
  }
  render() {
    return this.state.error ? <Failed title="Something went wrong on this page" error={this.state.error} /> : this.props.children;
  }
}

// One root across hot updates: an edit to a module this one imports re-runs it.
const root: Root = import.meta.hot?.data.root ?? createRoot(document.getElementById("plugin-root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
settleWhileHidden();
root.render(
  <Providers>
    <Loading />
  </Providers>,
);

connectUi().then(
  () =>
    root.render(
      <Providers>
        <Boundary>
          <LiveApp />
        </Boundary>
      </Providers>,
    ),
  (error: unknown) =>
    root.render(
      <Providers>
        <Failed title="The Cartridge Player plugin couldn't connect" error={error} />
      </Providers>,
    ),
);
