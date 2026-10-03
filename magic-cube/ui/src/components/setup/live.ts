import { useEffect,useMemo,useState } from "react";
import { activityById,getActivities,getCategories } from "./catalog";
import type { CubeResult } from "./cube/Cube3D";
import { activityArt,artFor,cubeArt,type ModeState } from "./model";
import type { Roll } from "./runtime";

/** The rolled face's art, and the pool it flickers through first when it came from a category. */
export function resultFor(roll: Roll | null): CubeResult | null {
  if (!roll) return null;
  const tag = roll.slot.side ?? null;
  if (!roll.activity) return { face: roll.face, art: artFor(roll.face, roll.slot), color: "#71717a" };
  const art = activityArt(roll.face, roll.activity, tag, roll.fromCategory ? `from ${roll.fromCategory}` : null);
  const pool = roll.poolIds.length > 1 ? roll.poolIds.filter(id => activityById(id)).map((id) => activityArt(roll.face, activityById(id)!, tag, null)) : undefined;
  return { face: roll.face, art, color: roll.activity.color, pool };
}

/** Cube art for a setup, with an optional roulette preview (hovering a category shows it on the cube). */
export function useCubeArt(setup: ModeState, roulettePreview: string | null) {
  const catalogKey = JSON.stringify([getActivities(), getCategories()]);
  const setupKey = JSON.stringify(setup);
  const shown = useMemo(
    () => (roulettePreview && setup.mode === "roulette" ? { ...setup, roulette: roulettePreview } : setup),
    [setupKey, roulettePreview],
  );
  return useMemo(() => cubeArt(shown), [shown, catalogKey]);
}

export function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}
