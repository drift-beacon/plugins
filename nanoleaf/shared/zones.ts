/**
 * Zones: groups of panels on the one wall, each belonging to one member. Storage keeps what was chosen (types.ts
 * `Zone`); `resolveZones` works out what each zone is on this wall now, from storage, the roster and the layout, and
 * that is never written back. Main and the interface call it with the same inputs, so the drawing matches the wall.
 */
import { actingFor } from "./acting-for.ts";
import { fillSpans, resolveOrder } from "./order.ts";
import { WALL_ZONE_ID } from "./storage.ts";
import type { FillSpan, MemberLike, PanelLight, PanelOrder, PlacedPanel, ResolvedZone, Rgb, Zone } from "./types.ts";

/** A zone that stands, before its panels are worked out. */
interface Standing {
  readonly id: string;
  readonly member: string | null;
  readonly panels: readonly number[] | undefined;
  readonly order: PanelOrder;
  readonly position: number;
}

/**
 * The zones as they stand on this wall, in stored order. `panelIds` are the wall's light panels (callers pass
 * `placeLayout(...).panels`' ids), `members` the roster and `wallOrder` the wall's stored order (storage `order`).
 *
 * - With an empty roster (a Drift Beacon that sends no members) the wall is one zone following nobody: the first
 *   stored zone's id and order, every panel.
 * - A lone stored zone acts for `actingFor` its member: its member while they are in the workspace, else the owner.
 * - With two or more stored, a zone whose member is not in the workspace is dropped, and so is a second zone for the
 *   same member (the first stands) or a repeated id.
 * - If none remains, the wall is one zone (`WALL_ZONE_ID`) for the owner, filling by the wall's order.
 * - Panels: an id not on the wall is ignored; a panel listed in two zones belongs to the first that stands; a panel in
 *   none belongs to the first zone that stands. Each zone's panels are ascending. A zone with none is kept.
 * - A zone without its own order fills by `wallOrder`.
 * - `position` is the zone's index in the stored list (0 for a zone made up here), so a dropped zone doesn't recolour
 *   the others.
 */
export function resolveZones(
  stored: readonly Zone[],
  panelIds: Iterable<number>,
  members: readonly MemberLike[],
  wallOrder: PanelOrder,
): ResolvedZone[] {
  const wall = [...new Set(panelIds)].sort((a, b) => a - b);
  let standing: Standing[] = [];
  if (members.length === 0) {
    const first = stored[0];
    standing = [{ id: first?.id ?? WALL_ZONE_ID, member: null, panels: undefined, order: first?.order ?? wallOrder, position: 0 }];
  } else if (stored.length === 1) {
    const only = stored[0] as Zone;
    const member = actingFor(only.member, members)[0] ?? null;
    standing = [{ id: only.id, member, panels: only.panels, order: only.order ?? wallOrder, position: 0 }];
  } else {
    const ids = new Set<string>();
    const zoned = new Set<string>();
    stored.forEach((zone, position) => {
      const member = zone.member;
      if (member === null || !members.some((m) => m.id === member)) return;
      if (zoned.has(member) || ids.has(zone.id)) return;
      zoned.add(member);
      ids.add(zone.id);
      standing.push({ id: zone.id, member, panels: zone.panels, order: zone.order ?? wallOrder, position });
    });
  }
  if (standing.length === 0) {
    const member = actingFor(null, members)[0] ?? null;
    standing = [{ id: WALL_ZONE_ID, member, panels: undefined, order: wallOrder, position: 0 }];
  }

  const onWall = new Set(wall);
  const owner = new Map<number, number>();
  standing.forEach((zone, z) => {
    for (const id of zone.panels ?? []) if (onWall.has(id) && !owner.has(id)) owner.set(id, z);
  });
  return standing.map((zone, z) => ({
    id: zone.id,
    member: zone.member,
    following: zone.member === null ? [] : [zone.member],
    panels: wall.filter((id) => (owner.get(id) ?? 0) === z),
    order: zone.order,
    position: zone.position,
  }));
}

/** The zone a panel belongs to, or null for an id that is in none (not a light panel on this wall). */
export function zoneOfPanel<Z extends Pick<ResolvedZone, "panels">>(zones: readonly Z[], panelId: number): Z | null {
  return zones.find((zone) => zone.panels.includes(panelId)) ?? null;
}

/**
 * Whether the wall is split for touches: two or more zones have panels (a zone with none yet doesn't split it), so a
 * touch nothing places acts nowhere. The screens decide whether to show the zone cards by the number of zones
 * `resolveZones` gives (more than one), not by this.
 */
export function isSplit(zones: readonly Pick<ResolvedZone, "panels">[]): boolean {
  let drawn = 0;
  for (const zone of zones) if (zone.panels.length > 0 && ++drawn > 1) return true;
  return false;
}

/**
 * The zones the wall as a whole is about: those with panels, or every zone while none has any (before the layout is
 * known). A zone with no panels yet shows nothing, so it never decides what the published `output` speaks for, the
 * yield key, the wall's brightness or whether the wall is wanted. Main and the screens both take the wall-level answers
 * from these; the zone cards still list every zone.
 */
export function drawnZones<Z extends Pick<ResolvedZone, "panels">>(zones: readonly Z[]): readonly Z[] {
  const drawn = zones.filter((zone) => zone.panels.length > 0);
  return drawn.length > 0 ? drawn : zones;
}

/* ---- How each zone fills, and the wall's order ---- */

/** A zone as the engine draws it: its fill order and line spans over its own panels, and where it sits on the wall. */
export interface ZoneFill {
  readonly id: string;
  /** `resolveOrder` of its order over only its placed panels. Empty for a zone with none (not drawn). */
  readonly order: readonly number[];
  /** `fillSpans` the same way: a line's share of the goal per position, over the zone's own extent; null otherwise. */
  readonly spans: readonly FillSpan[] | null;
  /** Where its order starts in the wall's combined order (`combinedOrder`), which another plugin's effect runs along. */
  readonly offset: number;
}

/**
 * Each zone's fill, in the zones' order. `placed` is `placeLayout(layout, viewRotation).panels`; each zone resolves
 * its order over those of its panels, in the order `placed` has them, so a one-zone wall resolves exactly as the wall
 * did before zones. Work this out when the zones, the layout or an order change, not per frame.
 */
export function zoneFills(zones: readonly ResolvedZone[], placed: readonly PlacedPanel[]): ZoneFill[] {
  let offset = 0;
  return zones.map((zone) => {
    const mine = new Set(zone.panels);
    const panels = placed.filter((panel) => mine.has(panel.id));
    const order = resolveOrder(zone.order, panels);
    const fill = { id: zone.id, order, spans: fillSpans(zone.order, panels, order), offset };
    offset += order.length;
    return fill;
  });
}

/** The wall's one order, for another plugin's effect (`takeControl`): each zone's order, one zone after another. */
export function combinedOrder(fills: readonly ZoneFill[]): number[] {
  return fills.flatMap((fill) => fill.order);
}

/* ---- Tag colours: the plugin's screens and the zone-editing preview only ---- */

/** Distinct colours for zones, picked by position; past the last, they repeat. */
export const ZONE_TAGS: readonly Rgb[] = Object.freeze([
  Object.freeze([244, 114, 182] as const), // pink
  Object.freeze([45, 212, 191] as const), // teal
  Object.freeze([250, 204, 21] as const), // yellow
  Object.freeze([129, 140, 248] as const), // indigo
  Object.freeze([251, 146, 60] as const), // orange
  Object.freeze([163, 230, 53] as const), // lime
  Object.freeze([232, 121, 249] as const), // fuchsia
  Object.freeze([56, 189, 248] as const), // sky
]);

/** A zone's tag colour: its position among the stored zones, in `ZONE_TAGS`. */
export function zoneTag(position: number): Rgb {
  const n = ZONE_TAGS.length;
  const i = Number.isInteger(position) ? ((position % n) + n) % n : 0;
  return ZONE_TAGS[i] as Rgb;
}

/** The level a zone's panels show at in the zone-editing preview. */
export const ZONE_TAG_LEVEL = 1;

/** The zone-editing preview: every panel in its zone's tag colour, so someone at the wall sees the split. */
export function zoneTagLights(zones: readonly ResolvedZone[]): Map<number, PanelLight> {
  const lights = new Map<number, PanelLight>();
  for (const zone of zones) {
    const light: PanelLight = { rgb: zoneTag(zone.position), level: ZONE_TAG_LEVEL };
    for (const id of zone.panels) lights.set(id, light);
  }
  return lights;
}
