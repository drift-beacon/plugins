import { Tooltip } from "@heroui/react";
import { cn } from "@heroui/theme";
import { Hash, Play, RotateCcw, RotateCw, Square } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useState } from "react";

interface StageToolbarProps {
  readonly panels: number;
  readonly name: string | null;
  /** The saved view rotation, degrees. */
  readonly rotation: number;
  /** Whether the fill numbers show; null when the fill has none to show (a line), and # is left out. */
  readonly numbers: boolean | null;
  /** The order is sweeping across the drawing (Play): the button stops it. */
  readonly playing: boolean;
  onPlay(): void;
  /** Turn the view 30°: +30 anticlockwise, -30 clockwise. */
  onTurn(step: 30 | -30): void;
  onNumbers(on: boolean): void;
  /** On the night sky: what the drawing is stays for screen readers only; the tools keep their place. */
  readonly sky?: boolean;
}

/**
 * The stage's header: what the drawing is, then Play (the order swept across it) and the view controls (numbers on or
 * off, a turn either way).
 */
export function StageToolbar(props: StageToolbarProps) {
  const { panels, name, rotation, numbers, playing, onPlay, onTurn, onNumbers, sky = false } = props;
  const reduced = useReducedMotion();
  // Each arrow turns with the drawing, a step per press, the way it turns.
  const [turns, setTurns] = useState(0);
  const turn = (step: 30 | -30) => {
    setTurns((n) => n + step / 30);
    onTurn(step);
  };
  const turned = rotation ? ` (turned ${rotation}°)` : "";
  return (
    <div className="flex items-center gap-3 @md:px-5 px-4 pt-3.5">
      <div className={sky ? "sr-only" : "min-w-0 flex-1"}>
        <div className="font-semibold text-[10px] text-default-400 uppercase tracking-wider">Your wall</div>
        <div className="truncate text-default-500 text-xs">
          {name ? `${name} · ` : ""}
          {panels} {panels === 1 ? "panel" : "panels"}
        </div>
      </div>
      {sky && <div className="flex-1" />}
      <IconButton label={playing ? "Stop" : "Play the order"} pressed={playing} onPress={onPlay}>
        {playing ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </IconButton>
      {numbers !== null && (
        <IconButton
          label={numbers ? "Hide the numbers" : "Show the numbers"}
          pressed={numbers}
          onPress={() => onNumbers(!numbers)}
        >
          <Hash className="h-4 w-4" />
        </IconButton>
      )}
      <IconButton label={`Turn the drawing anticlockwise${turned}`} onPress={() => turn(30)}>
        <motion.span
          className="grid place-items-center"
          animate={{ transform: `rotate(${reduced ? 0 : -30 * turns}deg)` }}
          transition={{ type: "spring", duration: 0.55, bounce: 0.2 }}
        >
          <RotateCcw className="h-4 w-4" />
        </motion.span>
      </IconButton>
      <IconButton label={`Turn the drawing clockwise${turned}`} onPress={() => turn(-30)}>
        <motion.span
          className="grid place-items-center"
          animate={{ transform: `rotate(${reduced ? 0 : -30 * turns}deg)` }}
          transition={{ type: "spring", duration: 0.55, bounce: 0.2 }}
        >
          <RotateCw className="h-4 w-4" />
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
