import { createContext, useContext } from "react";
import type { ZoneScene } from "../../../../shared/scene.ts";
import type { ResolvedZone } from "../../../../shared/types.ts";

/**
 * The zones as the wall section holds them, for the parts it hands to the layouts (the zone cards, the controller
 * card's Split the wall): what stands, what each shows, and choosing panels, which the drawing and the cards share.
 */
export interface ZoneEditing {
  readonly zones: readonly ResolvedZone[];
  readonly scenes: readonly ZoneScene[];
  /** More than one zone stands: the zone cards replace "This wall follows". */
  readonly split: boolean;
  /** The zone whose panels are being chosen, or null. */
  readonly choosing: string | null;
  /** Starts choosing panels for a zone (the drawing comes into view), or ends it (null). */
  choose(id: string | null): void;
}

export const ZoneEditingContext = createContext<ZoneEditing | null>(null);

/** The wall section's zones, or null outside it (the setup's layout, which has no drawing to choose panels on). */
export function useZoneEditing(): ZoneEditing | null {
  return useContext(ZoneEditingContext);
}
