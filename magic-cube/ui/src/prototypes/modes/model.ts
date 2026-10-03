import { useState } from "react";
import type { FaceArt } from "./cube/faceArt";
import { ACTIVITIES, activityById, CATEGORIES, categoryById, type FxActivity, type IconVerb, MDI, spanActivitiesIn } from "./fixtures";

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

const act = (id: string): Mapping => ({ type: "activity", id });
const cat = (id: string): Mapping => ({ type: "category", id });
const emptyManual = (): Record<Face, Mapping | null> => ({ "1": null, "2": null, "3": null, "4": null, "5": null, "6": null });

export function blankSetup(mode: ModeId = "duel"): ModeState {
  return { mode, duel: { should: null, feel: null }, shortlist: { items: [], faces: {} }, roulette: null, rouletteOff: {}, manual: emptyManual() };
}

// ── Presets: a mode with its config, plus auto-start. The NFC reader plugin switches between them.

export interface Preset {
  id: string;
  name: string;
  setup: ModeState;
  autoStart: boolean;
}

const saturdayItems = [act("fix"), act("tidy"), act("gym"), act("call-mum")];

export const SEED_PRESETS: Preset[] = [
  { id: "p-weeknights", name: "Weeknights", autoStart: true, setup: { ...blankSetup("duel"), duel: { should: act("tax"), feel: cat("creative") } } },
  {
    id: "p-saturday",
    name: "Saturday chores",
    autoStart: false,
    setup: { ...blankSetup("shortlist"), shortlist: { items: saturdayItems, faces: evenFaces(saturdayItems.length) } },
  },
  { id: "p-focus", name: "Deep focus", autoStart: true, setup: { ...blankSetup("roulette"), roulette: "work" } },
  {
    id: "p-sunday",
    name: "Lazy Sunday",
    autoStart: false,
    setup: {
      ...blankSetup("manual"),
      manual: { "1": act("read"), "2": act("water"), "3": act("games"), "4": act("guitar"), "5": cat("rest"), "6": act("friends") },
    },
  },
];

export function useWorkspace(initialPresets: Preset[] = SEED_PRESETS) {
  const [presets, setPresets] = useState<Preset[]>(initialPresets);
  const [activeId, setActiveId] = useState<string | null>(initialPresets[0]?.id ?? null);
  const [setup, setSetupState] = useState<ModeState>(initialPresets[0]?.setup ?? blankSetup());
  const [autoStart, setAutoStartState] = useState(initialPresets[0]?.autoStart ?? false);
  const [bootKey, setBootKey] = useState(0);

  // Edits write through to the selected preset, as the plugin does today.
  const writeBack = (nextSetup: ModeState, nextAuto: boolean) => {
    if (!activeId) return;
    setPresets((ps) => ps.map((p) => (p.id === activeId ? { ...p, setup: nextSetup, autoStart: nextAuto } : p)));
  };

  return {
    presets,
    activeId,
    active: presets.find((p) => p.id === activeId) ?? null,
    setup,
    autoStart,
    /** Bumps whenever a whole preset loads, so the cube can "boot" it. */
    bootKey,
    update(patch: Partial<ModeState>) {
      const next = { ...setup, ...patch };
      setSetupState(next);
      writeBack(next, autoStart);
    },
    setAutoStart(value: boolean) {
      setAutoStartState(value);
      writeBack(setup, value);
    },
    select(id: string | null) {
      setActiveId(id);
      const p = presets.find((x) => x.id === id);
      if (p) {
        setSetupState(p.setup);
        setAutoStartState(p.autoStart);
        setBootKey((k) => k + 1);
      }
    },
    saveAsNew(name: string) {
      const p: Preset = { id: `p-${Date.now()}`, name, setup, autoStart };
      setPresets((ps) => [...ps, p]);
      setActiveId(p.id);
      return p;
    },
    /** A fresh preset in the given mode, selected and empty. */
    create(name: string, mode: ModeId) {
      const p: Preset = { id: `p-${Date.now()}`, name, setup: blankSetup(mode), autoStart: false };
      setPresets((ps) => [...ps, p]);
      setActiveId(p.id);
      setSetupState(p.setup);
      setAutoStartState(false);
      setBootKey((k) => k + 1);
      return p;
    },
    rename(name: string, id = activeId) {
      if (!id) return;
      setPresets((ps) => ps.map((p) => (p.id === id ? { ...p, name } : p)));
    },
    duplicate(id: string) {
      const source = presets.find((p) => p.id === id);
      if (!source) return;
      const copy = { ...source, id: `p-${crypto.randomUUID()}`, name: `${source.name} copy`, setup: structuredClone(source.setup) };
      setPresets((ps) => [...ps, copy]);
    },
    remove(id = activeId) {
      if (!id) return;
      setPresets((ps) => ps.filter((p) => p.id !== id));
      if (id === activeId) setActiveId(null);
    },
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;

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
    if (!c) return null;
    const n = spanActivitiesIn(c.id).length;
    return { name: c.name, color: c.color, iconPath: c.iconPath, verb: c.verb, isCategory: true, isPoint: false, subtitle: `any of ${n}` };
  }
  const x = activityById(mapping.id);
  if (!x) return null;
  const c = categoryById(x.categoryId)!;
  return { name: x.name, color: x.color, iconPath: x.iconPath, verb: x.verb, isCategory: false, isPoint: x.trackingType === "point", subtitle: c.name };
}

// ── Category draws.

/** The activities a category face can draw in this setup: its spans, minus any left out in roulette. */
export function drawPool(s: ModeState, categoryId: string): FxActivity[] {
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
        out[f] = { mapping: s.roulette ? cat(s.roulette) : null };
        break;
      case "manual":
        out[f] = { mapping: s.manual[f] };
        break;
    }
  }
  return out;
}

export function isReady(s: ModeState) {
  return Object.values(faceSlots(s)).every((slot) => slot.mapping);
}

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

export function activityArt(face: Face, activity: FxActivity, tag: FaceArt["tag"], from: string | null): FaceArt {
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

export { ACTIVITIES, CATEGORIES };
