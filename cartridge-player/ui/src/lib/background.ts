import { MotionGlobalConfig } from "motion/react";

let settling = false;

/**
 * A hidden tab draws no frames, so nothing Motion starts there can finish: swap cartridges with the app in the
 * background (the normal way to use a player) and the exits pile up, to replay through each other when the tab is
 * shown again. While the tab is hidden, animations are created to skip: whatever happened in the background settles
 * on the first frame after the tab is shown, and the interface is simply up to date. State that waits on an
 * animation finishing keeps its own timer (hooks/useShownTag.ts), since even a skipped one needs that first frame.
 */
export function settleWhileHidden(): void {
  // Once per page: the entry module runs again on a hot update.
  if (settling) return;
  settling = true;
  const sync = () => {
    MotionGlobalConfig.skipAnimations = document.hidden;
  };
  sync();
  document.addEventListener("visibilitychange", sync);
}
