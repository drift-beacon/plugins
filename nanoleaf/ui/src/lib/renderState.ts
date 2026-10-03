import { advance, samePreview, withPreview } from "../../../shared/render.ts";
import type { Preview, RenderState, Scene } from "../../../shared/types.ts";

/**
 * One step of the drawing's render state: the latest scene through `advance`, then the local preview through
 * `withPreview`. `fresh` says the preview is a new request rather than the same one again (a re-render): a fresh
 * order sweep equal to the running one restarts from panel 1, because `withPreview` treats an equal request as a
 * renewal and would keep the old phase, so a second save or Play would end its sweep part-way.
 */
export function stepRenderState(
  state: RenderState,
  scene: Scene,
  preview: Preview | null,
  fresh: boolean,
  now: number,
): RenderState {
  let next = advance(state, scene, now);
  if (fresh && preview?.mode === "order" && samePreview(next.preview, preview)) next = withPreview(next, null, now);
  return withPreview(next, preview, now);
}
