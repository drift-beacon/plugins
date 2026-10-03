import { Tooltip } from "@heroui/react";
import { cn } from "@heroui/theme";
import { Hash, RotateCcw } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useState } from "react";

interface StageToolbarProps {
  readonly panels: number;
  readonly name: string | null;
  /** The saved view rotation, degrees. */
  readonly rotation: number;
  readonly numbers: boolean;
  onRotate(): void;
  onNumbers(on: boolean): void;
}

/** The stage's header: what the drawing is, and the two view controls (rotate the drawing, numbers on or off). */
export function StageToolbar({ panels, name, rotation, numbers, onRotate, onNumbers }: StageToolbarProps) {
  const reduced = useReducedMotion();
  const [turns, setTurns] = useState(0);
  return (
    <div className="flex items-center gap-3 @md:px-5 px-4 pt-3.5">
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-[10px] text-default-400 uppercase tracking-wider">Your wall</div>
        <div className="truncate text-default-500 text-xs">
          {name ? `${name} · ` : ""}
          {panels} {panels === 1 ? "panel" : "panels"}
        </div>
      </div>
      <IconButton
        label={numbers ? "Hide the numbers" : "Show the numbers"}
        pressed={numbers}
        onPress={() => onNumbers(!numbers)}
      >
        <Hash className="h-4 w-4" />
      </IconButton>
      <IconButton
        label={`Rotate the drawing to match your wall${rotation ? ` (turned ${rotation}°)` : ""}`}
        onPress={() => {
          setTurns((n) => n + 1);
          onRotate();
        }}
      >
        {/* The arrow turns with the drawing: a quarter-ish turn per press. */}
        <motion.span
          className="grid place-items-center"
          animate={{ transform: `rotate(${reduced ? 0 : -30 * turns}deg)` }}
          transition={{ type: "spring", duration: 0.55, bounce: 0.2 }}
        >
          <RotateCcw className="h-4 w-4" />
        </motion.span>
      </IconButton>
    </div>
  );
}

function IconButton({
  label,
  pressed,
  onPress,
  children,
}: {
  label: string;
  pressed?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label} delay={400} closeDelay={0} placement="bottom">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onPress}
        className={cn(
          "grid h-8 w-8 shrink-0 place-items-center rounded-xl ring-1 transition-[background-color,color,transform]",
          "duration-150 ease-out active:scale-[0.9]",
          pressed
            ? "bg-white/12 text-foreground ring-white/10"
            : "bg-white/5 text-default-400 ring-white/5 hover:bg-white/10 hover:text-foreground",
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}
