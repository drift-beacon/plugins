import { lightOpacity } from "../../../shared/color.ts";
import type { PanelLight, Rgb } from "../../../shared/types.ts";

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * How opaque a panel's light is drawn: the shared `lightOpacity` of its level, so a dim or part-filled panel looks as
 * dim on the drawing as the controller makes it on the wall. Rounded, so the light loop skips unchanged writes.
 */
export function panelOpacity(light: PanelLight | undefined): number {
  return light ? round3(lightOpacity(light.level)) : 0;
}

/** Light pooling on the floor: the lit panels' colour (weighted by how bright each is drawn) and a soft opacity. */
export function floorGlow(
  lights: ReadonlyMap<number, PanelLight>,
  ids: readonly number[],
): { readonly rgb: Rgb | null; readonly opacity: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let sum = 0;
  for (const id of ids) {
    const light = lights.get(id);
    const w = panelOpacity(light);
    if (!light || w <= 0) continue;
    r += light.rgb[0] * w;
    g += light.rgb[1] * w;
    b += light.rgb[2] * w;
    sum += w;
  }
  const mean = sum / Math.max(1, ids.length);
  return {
    rgb: sum > 0 ? [r / sum, g / sum, b / sum] : null,
    opacity: round3(Math.min(0.5, mean * 0.6)),
  };
}
