import { useCallback, useEffect, useState } from "react";
import { EJECT_S } from "../motion.ts";

/**
 * The cartridge the scene draws, which lags the slot by one exit: when one cartridge replaces another in a single
 * update (a swap the player reported as one change, or a missed removal), the old one slides out first and only then
 * the new one goes in, so two cartridges never pass through each other. `onExitComplete` goes on the scene's
 * AnimatePresence; a timer stands in when the browser isn't drawing frames (a hidden tab), so the scene never sticks.
 */
export function useShownTag(tag: string | null): { readonly shown: string | null; readonly onExitComplete: () => void } {
  const [shown, setShown] = useState(tag);
  const [leaving, setLeaving] = useState(false);

  const onExitComplete = useCallback(() => setLeaving(false), []);

  useEffect(() => {
    if (tag === shown || leaving) return;
    if (shown === null) {
      setShown(tag);
    } else {
      setLeaving(true);
      setShown(null);
    }
  }, [tag, shown, leaving]);

  useEffect(() => {
    if (!leaving) return;
    const id = window.setTimeout(onExitComplete, EJECT_S * 1000 + 250);
    return () => window.clearTimeout(id);
  }, [leaving, onExitComplete]);

  return { shown, onExitComplete };
}
