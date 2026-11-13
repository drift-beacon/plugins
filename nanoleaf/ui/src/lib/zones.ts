import { placeLayout } from "../../../shared/geometry.ts";
import { DRAFT_BRIGHTNESS, samePreview, withPreview } from "../../../shared/render.ts";
import { decideZoneScenes, outputScene, type ZoneScene } from "../../../shared/scene.ts";
import type {
  ActivityLike,
  ControlLease,
  Layout,
  MemberLike,
  PanelOrder,
  Preview,
  ResolvedZone,
  Scene,
  SessionLike,
  Settings,
  Zone,
} from "../../../shared/types.ts";
import { advanceZones, updateZones, type ZoneStates, zoneScales, zonesBrightness } from "../../../shared/zone-render.ts";
import { drawnZones, resolveZones } from "../../../shared/zones.ts";
import { drawnLevel } from "./brightness.ts";

/*
 * The zones as the interface works them out: the same shared rules main runs (shared/zones.ts, zone-render.ts,
 * scene.ts), fed from the model. Pure, so the tests can hold the screens to them without rendering anything.
 */

const NO_IDS: readonly number[] = Object.freeze([]);

/** The wall's light panel ids (what `resolveZones` takes), or none before a layout is known. */
export function lightPanelIds(layout: Layout | null): readonly number[] {
  return layout ? placeLayout(layout, 0).panels.map((panel) => panel.id) : NO_IDS;
}

/** What the zones are worked out from: storage `zones` and `order`, the roster and the layout. */
export interface ZoneInput {
  readonly zones: readonly Zone[];
  readonly members: readonly MemberLike[];
  readonly order: PanelOrder;
  readonly layout: Layout | null;
}

/** The zones as they stand on this wall now, as main resolves them. */
export function wallZones(model: ZoneInput, panelIds: Iterable<number> = lightPanelIds(model.layout)): ResolvedZone[] {
  return resolveZones(model.zones, panelIds, model.members, model.order);
}

/**
 * Whether the screens show the zone cards: more than one zone stands (not `isSplit`, which is for touches: a zone
 * with no panels yet still has a card).
 */
export function showsZones(zones: readonly unknown[]): boolean {
  return zones.length > 1;
}

/** Whether anything about zones shows at all: a workspace of two or more members. */
export function zonesOffered(members: readonly MemberLike[]): boolean {
  return members.length >= 2;
}

/** Everything `decideZoneScenes` reads besides the zones. */
export interface SceneSource {
  readonly activities: readonly ActivityLike[];
  readonly sessions: readonly SessionLike[];
  readonly settings: Settings;
  readonly control: ControlLease | null;
}

/** Each zone's scene at `now`, as main decides them. */
export function zoneScenes(model: SceneSource, zones: readonly ResolvedZone[], now: number): ZoneScene[] {
  const { activities, sessions, settings, control } = model;
  return decideZoneScenes({ activities, sessions, settings, now, control }, zones);
}

/** A preview the drawing shows, and the zone it shows in (null: every zone, as identify and a slider's fill do). */
export interface ZonePreview {
  readonly preview: Preview | null;
  readonly zoneId: string | null;
}

/**
 * One step of every zone's render state: each zone's latest scene (`advanceZones`), then the preview over the zone it
 * is for (the others let go of theirs). `fresh` says the preview is a new request: a fresh order sweep equal to the
 * running one restarts from panel 1, as `stepRenderState` does for the unsplit wall (lib/renderState.ts).
 */
export function stepZoneStates(
  states: ZoneStates | null,
  scenes: readonly ZoneScene[],
  { preview, zoneId }: ZonePreview,
  fresh: boolean,
  now: number,
): ZoneStates {
  return updateZones(advanceZones(states, scenes, now), (state, id) => {
    const mine = zoneId === null || zoneId === id ? preview : null;
    let next = state;
    if (fresh && mine?.mode === "order" && samePreview(next.preview, mine)) next = withPreview(next, null, now);
    return withPreview(next, mine, now);
  });
}

/** How strongly the drawing lights the wall, and each zone's share of that. */
export interface ZoneLevels {
  /** The wall's brightness, drawn (`drawnLevel`). */
  readonly level: number;
  /** Each zone's level scale against it (`zoneScales`); null draws every zone at 1. */
  readonly scales: ReadonlyMap<string, number> | null;
  /** The brightness the wall is driven at, %. */
  readonly brightness: number;
}

/**
 * The scenes of the zones the wall as a whole is about (zones.ts `drawnZones`: those with panels, every zone while none
 * has any), as main takes them for its output, yield key and brightness. A zone with no panels yet shows nothing.
 */
export function drawnScenes(
  zones: readonly Pick<ResolvedZone, "id" | "panels">[],
  scenes: readonly ZoneScene[],
): ZoneScene[] {
  const drawn = new Set(drawnZones(zones).map((zone) => zone.id));
  return scenes.filter((zone) => drawn.has(zone.id));
}

/** What the wall as a whole shows, as main's published `output` speaks for it: `outputScene` of the drawn zones. */
export function wallScene(
  zones: readonly Pick<ResolvedZone, "id" | "panels">[],
  scenes: readonly ZoneScene[],
  sessions: readonly SessionLike[],
): Scene {
  return outputScene(drawnScenes(zones, scenes), sessions);
}

/**
 * The wall's brightness as main drives it, drawn: tap to order's own while it holds the wall, else a slider being
 * dragged, else the highest any drawn zone needs (`zonesBrightness` over `drawnScenes`), with each zone that needs
 * less scaled down. With one zone this is `wallBrightness` exactly.
 */
export function zoneLevels(
  settings: Settings,
  zones: readonly Pick<ResolvedZone, "id" | "panels">[],
  scenes: readonly ZoneScene[],
  { preview, zoneId }: ZonePreview,
  dragged: number | null,
): ZoneLevels {
  if (preview?.mode === "draft") return { level: drawnLevel(DRAFT_BRIGHTNESS), scales: null, brightness: DRAFT_BRIGHTNESS };
  if (dragged !== null) return { level: drawnLevel(dragged), scales: null, brightness: dragged };
  const { brightness, needs } = zonesBrightness(
    settings,
    drawnScenes(zones, scenes).map(({ id, scene }) => ({
      id,
      scene,
      preview: preview !== null && (zoneId === null || zoneId === id),
    })),
  );
  return { level: drawnLevel(brightness), scales: zoneScales(needs, brightness), brightness };
}

/**
 * Where the fill order editor writes for zone `zoneId`: null for the wall's own order (storage `order`, `saveOrder`),
 * as before zones, while the wall is one zone that has no order of its own; else that zone's id (`setZoneOrder`). A
 * lone zone keeps an order it was given while the wall was split, and the drawing shows that order, so the editor
 * writes it there, whatever the roster: with none, `setZoneOrder` refuses and the editor says so, rather than saving
 * the wall's order that nothing would show.
 */
export function orderTarget(
  stored: readonly Zone[],
  zones: readonly Pick<ResolvedZone, "id">[],
  zoneId: string,
): string | null {
  if (zones.length > 1) return zoneId;
  return stored.find((zone) => zone.id === zoneId)?.order ? zoneId : null;
}

/** Saves the editor's order where `orderTarget` says: the wall's, or the zone's. */
export function saveEditorOrder(
  actions: {
    saveOrder(order: PanelOrder): Promise<void>;
    setZoneOrder(id: string, order: PanelOrder | null): Promise<void>;
  },
  target: string | null,
  order: PanelOrder,
): Promise<void> {
  return target === null ? actions.saveOrder(order) : actions.setZoneOrder(target, order);
}

/**
 * The wall's request for the editor's zone: a fill, an order sweep or tap to order carries `zoneId` on a split wall
 * (`zoneId` the selected zone), and nothing more on an unsplit one (null), exactly as before zones.
 */
export function zonedRequest<R extends { readonly mode: string }>(request: R, zoneId: string | null): R {
  if (zoneId === null || (request.mode !== "fill" && request.mode !== "order" && request.mode !== "draft")) {
    return request;
  }
  return { ...request, zoneId };
}

/**
 * The order the wall fills by, for readers outside the editor (the Now card's line or panels): the first zone's, which
 * on an unsplit wall is its own order if it kept one, else the wall's.
 */
export function wallFillOrder(model: ZoneInput): PanelOrder {
  return resolveZones(model.zones, [], model.members, model.order)[0]?.order ?? model.order;
}
