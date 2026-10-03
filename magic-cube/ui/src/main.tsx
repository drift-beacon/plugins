import { HeroUIProvider } from "@heroui/react";
import { MotionConfig } from "motion/react";
import { type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { connectUi } from "./drift-beacon";
import { MagicCubeView } from "./MagicCubeView";
import "./styles.css";

function StatusMessage({ children, className }: { children: ReactNode; className: string }) {
  return (
    <div style={{ padding: "20px" }} className={className}>
      {children}
    </div>
  );
}

const root = createRoot(document.getElementById("plugin-root")!);
root.render(
  <HeroUIProvider>
    <StatusMessage className="text-default-400">Loading...</StatusMessage>
  </HeroUIProvider>,
);

connectUi().then(
  () =>
    root.render(
      <HeroUIProvider>
        <MotionConfig reducedMotion="user"><MagicCubeView /></MotionConfig>
      </HeroUIProvider>,
    ),
  (error: unknown) =>
    root.render(
      <HeroUIProvider>
        <StatusMessage className="text-danger">{error instanceof Error ? error.message : String(error)}</StatusMessage>
      </HeroUIProvider>,
    ),
);
