import { cn } from "@heroui/theme";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import "./components/ui.css";
import { Board } from "./components/Board.tsx";
import { ControllerCard } from "./components/ControllerCard.tsx";
import { Notices } from "./components/Notice.tsx";
import { NowCard } from "./components/NowCard.tsx";
import { PhoneTabs } from "./components/phone/PhoneTabs.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { type SetupIntent, SetupFlow } from "./components/setup/SetupFlow.tsx";
import { WallSection } from "./components/wall/WallSection.tsx";
import { useMediaQuery } from "./hooks/useMediaQuery.ts";
import { useSwapMotion } from "./hooks/useSwapMotion.ts";
import { useModel } from "./model.ts";

/** The drawing takes at most this share of a phone's frame on the Order tab, the goal preview and compass under it. */
const PHONE_CAP = 0.36;
/** The drawing's height limit on the board, px: the wall card then ends near the side column beside it. */
const BOARD_CAP = 300;

/**
 * The layout, once a controller is paired and its wall is known. Narrow (the iframe under 768 px): three tabs over a
 * bar at the bottom (PhoneTabs). Wide: the Board, the wall and how it fills on top and one card per situation under
 * them. On a phone, first run is the Wall tab, the other tabs disabled until a wall is paired. Otherwise, until then
 * and while pairing again, the setup takes the wall's place with Settings beside it (under it when narrow), and Now
 * too when pairing again; notices sit above everything.
 */
function useViewportHeight(): number {
  const [height, setHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return height;
}

export function App() {
  const model = useModel();
  const [setup, setSetup] = useState<SetupIntent | null>(() => (model.controller ? null : { mode: "first" }));
  const phone = useMediaQuery("(max-width: 767px)");
  const height = useViewportHeight();

  // Forgotten (here, or from another device): back to the start.
  useEffect(() => {
    if (!model.controller) setSetup((s) => s ?? { mode: "first" });
  }, [model.controller]);

  const target = () => ({
    host: model.controller?.host ?? "",
    port: model.controller?.port ?? 16021,
    name: model.connection?.name ?? model.controller?.name ?? null,
    model: model.controller?.model ?? null,
  });

  const swap = useSwapMotion();

  const stage: ReactNode = (
    <AnimatePresence mode="wait" initial={false}>
      {setup ? (
        <motion.div key="setup" {...swap}>
          <SetupFlow
            intent={setup}
            onDone={() => setSetup(null)}
            onCancel={model.controller ? () => setSetup(null) : undefined}
          />
        </motion.div>
      ) : (
        <motion.div key="wall" {...swap}>
          <WallSection />
        </motion.div>
      )}
    </AnimatePresence>
  );

  const notices = (
    <Notices
      onPairAgain={() => setSetup({ mode: "repair", target: target() })}
      onEditAddress={() => setSetup({ mode: "edit", target: target() })}
      setupOpen={setup !== null}
    />
  );

  // A phone has its tabs from first run on: the setup is the Wall tab until a wall is paired, the other tabs wait.
  const firstRun = setup?.mode === "first";
  if (phone && (firstRun || (!setup && model.layout))) {
    return (
      <PhoneTabs
        cap={Math.round(height * PHONE_CAP)}
        notices={notices}
        setup={firstRun ? <SetupFlow intent={setup} onDone={() => setSetup(null)} /> : null}
      />
    );
  }

  // Wide, paired, with a wall to draw. Phone and board are two trees: crossing 768 px remounts the wall (or a first
  // run), which a phone never does.
  if (!setup && model.layout) {
    return (
      // The night sky reaches past the wall's column: clipped at the frame, so the page never scrolls sideways.
      <div className="mx-auto w-full max-w-7xl overflow-x-clip p-px">
        {notices}
        <WallSection cap={BOARD_CAP} sky arrange={(parts) => <Board parts={parts} />} />
      </div>
    );
  }

  return (
    // Padded: the cards' rings draw outside their boxes, and the frame's edge would clip them.
    <div className="mx-auto w-full max-w-7xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:p-px">
      {notices}
      {/* One tree for both widths (CSS decides), so crossing 768 px never remounts pairing again in progress. */}
      <div
        className={cn(
          "flex flex-col gap-3",
          "md:grid md:grid-cols-[minmax(0,1fr)_320px] md:items-start md:gap-4 xl:grid-cols-[minmax(0,1fr)_360px]",
        )}
      >
        <div className="order-2 min-w-0 space-y-3 md:sticky md:top-4 md:order-none md:space-y-4">
          <ControllerCard />
          {stage}
        </div>
        <div className="contents md:block md:min-w-0 md:space-y-4">
          {/* First run is about the setup: there's no wall yet for Now to speak for. */}
          {setup?.mode !== "first" && (
            <div className="order-1 md:order-none">
              <NowCard />
            </div>
          )}
          <div className="order-3 md:order-none">
            <SettingsPanel />
          </div>
        </div>
      </div>
    </div>
  );
}
