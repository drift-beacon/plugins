export const FACES = ["1", "2", "3", "4", "5", "6"] as const;
export type Face = (typeof FACES)[number];

/**
 * The two halves for Feel vs Should, as corners of the die-laid-out cube (1 +Y, 2 +Z, 3 +X, 4 −X, 5 −Z, 6 −Y):
 * 1-2-3 meet at the corner facing you, 4-5-6 at the opposite one.
 */
export const SHOULD_FACES: Face[] = ["1", "2", "3"];
export const FEEL_FACES: Face[] = ["4", "5", "6"];

export interface Mapping {
  type: "activity" | "category";
  id: string;
}

export type ModeId = "duel" | "shortlist" | "roulette" | "manual";

export interface ModeState {
  mode: ModeId;
  duel: { should: Mapping | null; feel: Mapping | null };
  /** Shortlist picks, and which pick each face belongs to (an index into items). */
  shortlist: { items: Mapping[]; faces: Partial<Record<Face, number>> };
  roulette: string | null;
  /** Activities left out of a category's draw, per category (kept when you switch categories and back). */
  rouletteOff: Record<string, string[]>;
  manual: Record<Face, Mapping | null>;
}

export function evenFaces(count: number): Partial<Record<Face, number>> {
  const faces: Partial<Record<Face, number>> = {};
  if (count === 0) return faces;
  const base = Math.floor(6 / count);
  const extra = 6 % count;
  let face = 0;
  for (let i = 0; i < count; i++) {
    const n = base + (i < extra ? 1 : 0);
    for (let k = 0; k < n; k++) faces[FACES[face++]] = i;
  }
  return faces;
}

export function blankSetup(mode: ModeId = "manual"): ModeState {
  return { mode, duel: { should: null, feel: null }, shortlist: { items: [], faces: {} }, roulette: null, rouletteOff: {}, manual: { "1": null, "2": null, "3": null, "4": null, "5": null, "6": null } };
}
export interface FaceSlot {
  mapping: Mapping | null;
  side?: "should" | "feel";
  item?: number;
}

/** What each face does in the current mode. */
export function faceSlots(s: ModeState): Record<Face, FaceSlot> {
  const out = {} as Record<Face, FaceSlot>;
  for (const f of FACES) {
    switch (s.mode) {
      case "duel": {
        const side = SHOULD_FACES.includes(f) ? "should" : "feel";
        out[f] = { mapping: s.duel[side], side };
        break;
      }
      case "shortlist": {
        const item = s.shortlist.faces[f];
        out[f] = { mapping: item == null ? null : (s.shortlist.items[item] ?? null), item };
        break;
      }
      case "roulette":
        out[f] = { mapping: s.roulette ? { type: "category", id: s.roulette } : null };
        break;
      case "manual":
        out[f] = { mapping: s.manual[f] };
        break;
    }
  }
  return out;
}


/** Resolve the selected mode into the six hardware faces. */
export interface StoredMapping extends Mapping { excludedActivityIds?: string[] }
export type StoredMappings = Record<string, StoredMapping>;

export function mappingsForSetup(setup: ModeState): StoredMappings {
  const mappings: StoredMappings = {};
  for (const [face, slot] of Object.entries(faceSlots(setup))) {
    if (!slot.mapping) continue;
    mappings[face] = { ...slot.mapping };
    if (setup.mode === "roulette" && setup.roulette) {
      mappings[face].excludedActivityIds = [...(setup.rouletteOff[setup.roulette] ?? [])];
    }
  }
  return mappings;
}
