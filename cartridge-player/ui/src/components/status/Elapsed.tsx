import { useNow } from "../../hooks/useNow.ts";
import { cx } from "../../lib/cx.ts";
import { clock } from "../../view/format.ts";

/**
 * The running clock, on its own so the once-a-second tick re-renders only this. It's hidden from assistive technology
 * (the line above it says when it started), which would otherwise hear a new number every second. The amber is the
 * player's display colour: brighter with a glow on a dark surface, deeper on a light one.
 */
export function Elapsed({ startedAt, compact = false }: { startedAt: number; compact?: boolean }) {
  const now = useNow(1000);
  return (
    <div
      aria-hidden="true"
      className={cx(
        "cp-clock font-mono tabular-nums tracking-tight",
        compact ? "text-2xl" : "text-4xl md:text-5xl",
      )}
    >
      {clock(now - startedAt)}
    </div>
  );
}
