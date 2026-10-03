import { FACES,evenFaces,faceSlots,type Face,type FaceSlot,type Mapping,type ModeId,type ModeState } from "../../../../shared/setup";
import { MDI,activityById,categoryById,spanActivitiesIn,type CatalogActivity,type IconVerb } from "./catalog";
import type { FaceArt } from "./cube/faceArt";
export * from "../../../../shared/setup";
export type { Preset,Workspace } from "./workspace";

export interface ModeInfo {
  id: ModeId;
  name: string;
  short: string;
  tagline: string;
  iconPath: string;
  verb: IconVerb | "seesaw" | "tumble";
}

export const MODES: ModeInfo[] = [
  { id: "duel", name: "Feel vs Should", short: "Duel", tagline: "Let the cube settle the argument", iconPath: MDI.scale, verb: "seesaw" },
  { id: "shortlist", name: "Shortlist", short: "Shortlist", tagline: "A handful of things, shared out fairly", iconPath: MDI.listChecks, verb: "tick" },
  { id: "roulette", name: "Category roulette", short: "Roulette", tagline: "One category, surprise me", iconPath: MDI.dice, verb: "tumble" },
  { id: "manual", name: "Manual", short: "Manual", tagline: "Every face, hand-picked", iconPath: MDI.hand, verb: "wiggle" },
];

// ── Describing mappings.

export interface Described {
  name: string;
  color: string;
  iconPath: string;
  verb: IconVerb;
  isCategory: boolean;
  /** Point activities are marked, not started. */
  isPoint: boolean;
  /** Category name for an activity; "any of N" for a category. */
  subtitle: string;
}

export function describe(mapping: Mapping | null): Described | null {
  if (!mapping) return null;
  if (mapping.type === "category") {
    const c = categoryById(mapping.id);
    if (!c) return { name: "Unavailable category", color: "#71717a", iconPath: MDI.dice, verb: "nudge", isCategory: true, isPoint: false, subtitle: "Choose another category" };
    const n = spanActivitiesIn(c.id).length;
    return { name: c.name, color: c.color, iconPath: c.iconPath, verb: c.verb, isCategory: true, isPoint: false, subtitle: `any of ${n}` };
  }
  const x = activityById(mapping.id);
  if (!x) return { name: "Unavailable activity", color: "#71717a", iconPath: MDI.dice, verb: "nudge", isCategory: false, isPoint: false, subtitle: "Choose another activity" };
  const c = categoryById(x.categoryId);
  return { name: x.name, color: x.color, iconPath: x.iconPath, verb: x.verb, isCategory: false, isPoint: x.trackingType === "point", subtitle: c?.name ?? "Uncategorized" };
}

// ── Category draws.

/** The activities a category face can draw in this setup: its spans, minus any left out in roulette. */
export function drawPool(s: ModeState, categoryId: string): CatalogActivity[] {
  const all = spanActivitiesIn(categoryId);
  if (s.mode !== "roulette" || s.roulette !== categoryId) return all;
  const off = new Set(s.rouletteOff[categoryId] ?? []);
  return all.filter((x) => !off.has(x.id));
}

/** Include or leave out one activity from the roulette category's draw. The last one in can't be left out. */
export function toggleRouletteActivity(s: ModeState, activityId: string): ModeState["rouletteOff"] | null {
  const cat = s.roulette;
  if (!cat) return null;
  const off = new Set(s.rouletteOff[cat] ?? []);
  if (off.has(activityId)) off.delete(activityId);
  else {
    if (spanActivitiesIn(cat).filter((x) => !off.has(x.id)).length <= 1) return null;
    off.add(activityId);
  }
  return { ...s.rouletteOff, [cat]: [...off] };
}

export function sameMapping(x: Mapping | null, y: Mapping | null) {
  return !!x && !!y && x.type === y.type && x.id === y.id;
}

export const mappingKey = (m: Mapping) => `${m.type}:${m.id}`;

// ── Cube art.

export function artFor(face: Face, slot: FaceSlot): FaceArt {
  const d = describe(slot.mapping);
  return {
    face,
    color: d?.color ?? null,
    iconPath: d?.iconPath ?? null,
    label: d ? (d.isCategory ? `Any ${d.name}` : d.name) : null,
    sublabel: d ? (d.isCategory ? d.subtitle : null) : null,
    isCategory: d?.isCategory ?? false,
    tag: slot.side ?? null,
  };
}

export function activityArt(face: Face, activity: CatalogActivity, tag: FaceArt["tag"], from: string | null): FaceArt {
  return { face, color: activity.color, iconPath: activity.iconPath, label: activity.name, sublabel: from, isCategory: false, tag };
}

export function cubeArt(s: ModeState) {
  const slots = faceSlots(s);
  const faces = {} as Record<Face, FaceArt>;
  const flicker: Partial<Record<Face, FaceArt[]>> = {};
  for (const f of FACES) {
    faces[f] = artFor(f, slots[f]);
    const m = slots[f].mapping;
    if (m?.type === "category") {
      const pool = drawPool(s, m.id);
      const total = spanActivitiesIn(m.id).length;
      // A trimmed roulette draw says so on the face: "5 of 8".
      if (pool.length < total) faces[f] = { ...faces[f], sublabel: `${pool.length} of ${total}` };
      flicker[f] = pool.map((x) => activityArt(f, x, slots[f].side ?? null, null));
    }
  }
  return { faces, flicker, slots };
}

// ── Shortlist editing.

export function faceCount(s: ModeState["shortlist"], item: number) {
  return FACES.filter((f) => s.faces[f] === item).length;
}

/** Give one face to `item`, taken from the pick holding the most faces. */
export function growItem(s: ModeState["shortlist"], item: number): ModeState["shortlist"] {
  let donor = -1;
  let most = 1;
  s.items.forEach((_, i) => {
    const n = faceCount(s, i);
    if (i !== item && n > most) [donor, most] = [i, n];
  });
  if (donor < 0) return s;
  const face = [...FACES].reverse().find((f) => s.faces[f] === donor)!;
  return { ...s, faces: { ...s.faces, [face]: item } };
}

/** Hand one of `item`'s faces to the pick holding the fewest. */
export function shrinkItem(s: ModeState["shortlist"], item: number): ModeState["shortlist"] {
  if (faceCount(s, item) <= 1 || s.items.length < 2) return s;
  let taker = -1;
  let fewest = 7;
  s.items.forEach((_, i) => {
    const n = faceCount(s, i);
    if (i !== item && n < fewest) [taker, fewest] = [i, n];
  });
  const face = [...FACES].reverse().find((f) => s.faces[f] === item)!;
  return { ...s, faces: { ...s.faces, [face]: taker } };
}

export function addItem(s: ModeState["shortlist"], m: Mapping): ModeState["shortlist"] {
  if (s.items.length >= 6 || s.items.some((x) => sameMapping(x, m))) return s;
  const items = [...s.items, m];
  return { items, faces: evenFaces(items.length) };
}

export function removeItem(s: ModeState["shortlist"], index: number): ModeState["shortlist"] {
  const items = s.items.filter((_, i) => i !== index);
  return { items, faces: evenFaces(items.length) };
}



/** Every assigned face must still be able to resolve an activity in the live workspace. */
export function isReady(setup: ModeState) {
  return Object.values(faceSlots(setup)).every(({ mapping }) => mapping && (mapping.type === "activity" ? activityById(mapping.id) !== null : drawPool(setup, mapping.id).length > 0));
}
