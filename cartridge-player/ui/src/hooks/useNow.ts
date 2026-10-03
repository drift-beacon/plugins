import { useEffect, useState } from "react";

/** The time, re-rendering every `ms` while `enabled`. Timers never animate: they just tick. */
export function useNow(ms = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, enabled]);
  return now;
}
