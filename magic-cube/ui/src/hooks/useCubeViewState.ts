import { useCallback, useEffect, useRef, useState } from "react";
import type { CubeStatusState, LastRollState } from "../storage";

type CubeState = "idle" | "held" | "activated";

export type ViewState = "idle" | "held" | "activated" | "result";

interface CubeViewState {
  viewState: ViewState;
  transientRoll: LastRollState | null;
  dismiss: () => void;
}

/** How long a cube that lands without a roll waits for one before the view calls it cancelled. */
const ROLL_GRACE_MS = 3_000;

type Timer = { current: ReturnType<typeof setTimeout> | null };

function stop(timer: Timer) {
  if (timer.current) clearTimeout(timer.current);
  timer.current = null;
}

/**
 * Held, then activated, then the roll's result until it's dismissed. The cube's status and its roll are separate
 * storage keys that can reach the UI in separate updates, in either order: a roll counts when it's newer than the one
 * there was when the cube was picked up, and a cube that goes idle without one waits briefly for it.
 */
export function useCubeViewState(cubeStatus: CubeStatusState | null, lastRoll: LastRollState | null): CubeViewState {
  const [viewState, setViewState] = useState<ViewState>("idle");
  const [resultRoll, setResultRoll] = useState<LastRollState | null>(null);
  const prevCubeState = useRef<CubeState>("idle");
  const rollBefore = useRef<string | null>(null);
  const waitingForRoll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cubeState = cubeStatus?.state ?? "idle";

  const dismiss = useCallback(() => {
    stop(waitingForRoll);
    setViewState("idle");
    setResultRoll(null);
  }, []);

  useEffect(() => {
    const prev = prevCubeState.current;
    prevCubeState.current = cubeState;
    const rollKey = lastRoll?.timestamp ?? null;

    if (cubeState === "held" || cubeState === "activated") {
      if (prev === "idle") rollBefore.current = rollKey;
      if (prev !== cubeState) {
        stop(waitingForRoll);
        setViewState(cubeState);
        setResultRoll(null);
      }
      return;
    }

    const newRoll = lastRoll && rollKey !== rollBefore.current ? lastRoll : null;
    const showResult = (roll: LastRollState) => {
      stop(waitingForRoll);
      setResultRoll(roll);
      setViewState("result");
    };

    if (prev === "activated") {
      // Landed: the roll came first or with this update, or is still on its way. None within the grace period means
      // the activation timed out instead.
      if (newRoll) showResult(newRoll);
      else {
        waitingForRoll.current = setTimeout(() => {
          waitingForRoll.current = null;
          setViewState("idle");
        }, ROLL_GRACE_MS);
      }
      return;
    }
    if (prev === "idle") {
      if (newRoll && waitingForRoll.current) showResult(newRoll);
      return;
    }

    // Put down (or timed out) before it was shaken: cancelled.
    setViewState("idle");
    setResultRoll(null);
  }, [cubeState, lastRoll]);

  useEffect(() => () => stop(waitingForRoll), []);

  // The live copy of the shown roll, so a later change to it (a failed auto-start) shows too.
  const transientRoll = resultRoll && lastRoll?.timestamp === resultRoll.timestamp ? lastRoll : resultRoll;
  return { viewState, transientRoll, dismiss };
}
