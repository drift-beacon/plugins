import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { useSwapMotion } from "../../hooks/useSwapMotion.ts";
import { SettingsCards } from "../SettingsPanel.tsx";
import { Starfield } from "../Starfield.tsx";
import { WallSection } from "../wall/WallSection.tsx";
import { TAB_BAR, TabBar, type TabId } from "./TabBar.tsx";
import { WallTab } from "./WallTab.tsx";

/**
 * The phone layout (the frame under 768 px, full screen on a phone), once a controller is paired: three tabs over a bar
 * at the bottom. Wall is the everyday one (the wall small beside what it shows, both brightnesses, the controller);
 * Order has the full drawing with its tools and goal preview, and the order as a compass; Settings has what the wall
 * does in each situation. Notices sit above every tab. In first run the setup is the Wall tab and the others are
 * disabled: there's no wall yet to order or set up.
 */
export function PhoneTabs({ cap, notices, setup }: { cap: number; notices: ReactNode; setup: ReactNode | null }) {
  const swap = useSwapMotion();
  const [tab, setTab] = useState<TabId>("wall");
  const go = (next: TabId) => {
    setTab(next);
    window.scrollTo({ top: 0 });
  };
  return (
    <>
      {/* The sky and the horizon reach past the content's edges: clipped here, so the page never pans sideways. */}
      <div className="w-full overflow-x-clip px-3 pt-3" style={{ paddingBottom: `calc(${TAB_BAR + 12}px + env(safe-area-inset-bottom))` }}>
        {notices}
        <AnimatePresence mode="wait" initial={false}>
          {setup ? (
            <motion.div key="setup" {...swap}>
              {setup}
            </motion.div>
          ) : (
            <motion.div key="wall" {...swap}>
              <WallSection
                cap={cap}
                toolbar={false}
                tools
                // Leaving the Order tab cancels a draft in progress: it holds the wall, and nothing would show it.
                shown={tab === "order"}
                sky
                arrange={(parts) => (
                  <div className="space-y-3">
                    {/* The full drawing is the Order tab's; kept mounted on the others, so zoom survives a trip to
                        another tab. */}
                    <div hidden={tab !== "order"} className="relative">
                      {/* The drawing hangs in the night sky, as on the board. */}
                      <div className="night-sky pointer-events-none absolute -inset-x-3 -top-3 bottom-0">
                        <Starfield />
                      </div>
                      <div className="relative">{parts.stage}</div>
                    </div>
                    {tab === "wall" && <WallTab onOpenWall={() => go("order")} />}
                    {tab === "order" && parts.editor}
                    {tab === "settings" && (
                      <SettingsCards groups={["pinned", "track", "schedule", "plugins"]} />
                    )}
                  </div>
                )}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <TabBar value={tab} onChange={go} only={setup ? "wall" : null} />
    </>
  );
}
