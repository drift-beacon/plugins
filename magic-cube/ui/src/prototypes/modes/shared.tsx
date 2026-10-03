import { cn } from "@heroui/theme";

const DOTS: Record<string, number[]> = { "1": [4], "2": [2, 6], "3": [2, 4, 6], "4": [0, 2, 6, 8], "5": [0, 2, 4, 6, 8], "6": [0, 3, 6, 2, 5, 8] };

/** Pips only, sized to fit its box; inherits colour. */
export function Pips({ face, size = 20, className }: { face: string; size?: number; className?: string }) {
  const dot = Math.max(2.5, size * 0.17);
  return (
    <span className={cn("grid shrink-0 grid-cols-3 grid-rows-3", className)} style={{ width: size, height: size }}>
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className="grid place-items-center">
          {DOTS[face]?.includes(i) && <span className="block rounded-full bg-current" style={{ width: dot, height: dot }} />}
        </span>
      ))}
    </span>
  );
}
