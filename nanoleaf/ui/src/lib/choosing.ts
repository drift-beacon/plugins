import type { ResolvedZone } from "../../../shared/types.ts";
import type { WallRequest } from "./lease.ts";

/** A zone just added may reach the model a moment after choosing starts: it has this long to appear. */
export const CHOOSING_GRACE_MS = 1500;

/** What choosing panels does outside itself. */
export interface ChoosingDeps {
  /** The wall's preview: `{ mode: "zones" }` while choosing and the wall can be driven, null when it ends. */
  showWall(request: WallRequest | null): void;
  /** Holds main's `numbering` while choosing, so a touch on the wall moves a panel rather than acting. */
  hold(on: boolean): void;
  /** Choosing started (a zone's id), ended (null), or a drag's panels changed: re-render. */
  changed(state: ChoosingState): void;
  /** Writes the move (model.actions.movePanels). */
  movePanels(zoneId: string, panelIds: readonly number[]): Promise<void>;
  /** A move the rules or the app refused. */
  refused(error: unknown): void;
  /** A panel was pressed or touched: flash it on the drawing. */
  pulse(panelId: number): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Where choosing stands. */
export interface ChoosingState {
  /** The zone whose panels are being chosen, or null. */
  readonly zoneId: string | null;
  /** Panels a drag in progress has crossed, shown at once and saved when it lets go. */
  readonly painting: readonly number[];
}

/** Choosing panels for a zone: started, ended, fed the zones and the wall, and pressed. */
export interface Choosing {
  readonly state: ChoosingState;
  start(zoneId: string): void;
  end(): void;
  /** The zones as they stand now. Choosing ends when its zone goes, or when only one zone stands. */
  setZones(zones: readonly ResolvedZone[]): void;
  /** Whether main can drive the wall (the `zones` preview needs it). */
  setCanWall(can: boolean): void;
  /** Whether the drawing is on screen: once it isn't, choosing ends. */
  setShown(shown: boolean): void;
  /** A tap (or Enter or Space) on a panel: brings it into the zone, or gives one of its own back to the first other. */
  tap(panelId: number): void;
  /** A touch on the wall: that panel comes into the zone. */
  touch(panelId: number): void;
  down(panelId: number): void;
  drag(panelId: number): void;
  /** `tap`: released where it was pressed without crossing to another panel. */
  up(tap: boolean): void;
}

const IDLE: ChoosingState = Object.freeze({ zoneId: null, painting: Object.freeze([]) as readonly number[] });

/**
 * Choosing panels, apart from React so its rules can be tested: it holds the wall's `zones` preview and main's
 * `numbering` from start to end, and ends whenever there is nothing left to choose for.
 */
export function createChoosing(deps: ChoosingDeps): Choosing {
  let state: ChoosingState = IDLE;
  let zones: readonly ResolvedZone[] = [];
  let canWall = false;
  let seen = false;
  let grace: unknown = null;
  let paint: { start: number; dragged: boolean; ids: number[] } | null = null;

  const set = (next: ChoosingState) => {
    state = next;
    deps.changed(next);
  };
  const zone = () => zones.find((z) => z.id === state.zoneId) ?? null;
  const own = (panelId: number) => zone()?.panels.includes(panelId) ?? false;
  const onWall = (panelId: number) => zones.some((z) => z.panels.includes(panelId));
  const stopGrace = () => {
    if (grace !== null) deps.clearTimeout(grace);
    grace = null;
  };
  const move = (zoneId: string, ids: readonly number[]) => deps.movePanels(zoneId, ids).catch(deps.refused);

  const choosing: Choosing = {
    get state() {
      return state;
    },
    start(zoneId) {
      if (state.zoneId === zoneId) return;
      const was = state.zoneId !== null;
      paint = null;
      stopGrace();
      seen = zones.some((z) => z.id === zoneId);
      if (!seen) grace = deps.setTimeout(() => choosing.end(), CHOOSING_GRACE_MS);
      set({ zoneId, painting: [] });
      deps.showWall(canWall ? { mode: "zones" } : null);
      if (!was) deps.hold(true);
    },
    end() {
      if (state.zoneId === null) return;
      paint = null;
      stopGrace();
      set(IDLE);
      deps.showWall(null);
      deps.hold(false);
    },
    setZones(next) {
      zones = next;
      if (state.zoneId === null) return;
      const present = zones.some((z) => z.id === state.zoneId);
      if (present && !seen) {
        seen = true;
        stopGrace();
      }
      if (seen && (!present || zones.length < 2)) choosing.end();
    },
    setCanWall(can) {
      if (can === canWall) return;
      canWall = can;
      if (state.zoneId !== null) deps.showWall(can ? { mode: "zones" } : null);
    },
    setShown(shown) {
      if (!shown) choosing.end();
    },
    tap(panelId) {
      const mine = zone();
      if (!mine || !onWall(panelId)) return;
      deps.pulse(panelId);
      const to = mine.panels.includes(panelId) ? zones.find((z) => z.id !== mine.id) : mine;
      if (to) void move(to.id, [panelId]);
    },
    touch(panelId) {
      const mine = zone();
      if (!mine || !onWall(panelId)) return;
      deps.pulse(panelId);
      if (!mine.panels.includes(panelId)) void move(mine.id, [panelId]);
    },
    down(panelId) {
      if (state.zoneId !== null) paint = { start: panelId, dragged: false, ids: [] };
    },
    drag(panelId) {
      if (!paint || state.zoneId === null) return;
      if (!paint.dragged) {
        paint.dragged = true;
        if (!own(paint.start) && onWall(paint.start)) paint.ids.push(paint.start);
      }
      if (!own(panelId) && onWall(panelId) && !paint.ids.includes(panelId)) paint.ids.push(panelId);
      set({ zoneId: state.zoneId, painting: [...paint.ids] });
    },
    up(tap) {
      const done = paint;
      paint = null;
      if (!done || state.zoneId === null) return;
      if (!done.dragged) {
        if (tap) choosing.tap(done.start);
        return;
      }
      const zoneId = state.zoneId;
      if (done.ids.length === 0) return;
      void move(zoneId, done.ids).finally(() => {
        if (state.zoneId === zoneId) set({ zoneId, painting: [] });
      });
    },
  };
  return choosing;
}
