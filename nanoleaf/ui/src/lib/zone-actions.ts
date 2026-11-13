import {
  addZone,
  giveZone,
  movePanels,
  readZones,
  removeZone,
  setZoneOrder,
  type ZoneEdit,
  type ZoneRefusal,
  zonesFollowing,
} from "../../../shared/storage.ts";
import type { MemberLike, PanelOrder, Zone } from "../../../shared/types.ts";

/** An edit the zone rules refuse (shared/storage.ts): its message is the refusal in `ZONE_REFUSALS`' words. */
export class ZoneRefused extends Error {
  readonly code = "refused";
  readonly refusal: ZoneRefusal;
  constructor(refusal: ZoneRefusal, reason: string) {
    super(reason);
    this.name = "ZoneRefused";
    this.refusal = refusal;
  }
}

/** What a zone edit says when it fails: a refusal in its own words, a write the app turned down as the settings do. */
export function zoneErrorText(error: unknown): string {
  if (error instanceof ZoneRefused) return error.message;
  return `Couldn't save that: ${error instanceof Error ? error.message : String(error)}`;
}

/** Where the zone edits read and write: storage `zones` as it is now, and the roster to judge against. */
export interface ZoneStore {
  /** Storage `zones` now, raw: read at call time, so edits faster than renders (a drag) each see the one before. */
  read(): unknown;
  /** Writes storage `zones`; applies locally at once and rejects (rolled back) when the app refuses. */
  write(zones: Zone[]): Promise<void>;
  members(): readonly MemberLike[];
}

/** The edits the zone screens make, each through its shared helper. */
export interface ZoneActions {
  /** The unsplit wall's picker: the one zone, given to `member`. */
  saveZoneMember(member: string): Promise<void>;
  /** A new zone for `member`, with no panels yet; resolves with its id. */
  addZone(member: string): Promise<string>;
  /** Removes a zone; its panels go to the first zone that remains. */
  removeZone(id: string): Promise<void>;
  /** Gives a zone to `member`, who has none. */
  giveZone(id: string, member: string): Promise<void>;
  /** Brings panels into a zone, off every other. */
  movePanels(id: string, panelIds: readonly number[]): Promise<void>;
  /** How a zone fills; null fills it by the wall's order. */
  setZoneOrder(id: string, order: PanelOrder | null): Promise<void>;
}

/**
 * The zone edits over a store: each reads storage at call time, asks its shared helper for the next list and writes
 * it. A refusal rejects with `ZoneRefused` and writes nothing; "nothing would change" (a panel crossed twice, a person
 * picked again) is no refusal to show, so it resolves without writing. A write the app refuses rejects with its error
 * (the SDK has rolled storage back).
 */
export function createZoneActions(store: ZoneStore): ZoneActions {
  const apply = (edit: (stored: Zone[], members: readonly MemberLike[]) => ZoneEdit): Promise<Zone[] | null> => {
    let result: ZoneEdit;
    try {
      result = edit(readZones(store.read()), store.members());
    } catch (error) {
      return Promise.reject(error);
    }
    if (!result.ok) {
      return result.refusal === "no-change"
        ? Promise.resolve(null)
        : Promise.reject(new ZoneRefused(result.refusal, result.reason));
    }
    const zones = result.zones;
    return store.write(zones).then(() => zones);
  };
  const done = () => undefined;
  return {
    saveZoneMember: (member) => apply((_stored, members) => zonesFollowing(store.read(), member, members)).then(done),
    addZone(member) {
      // The new zone is the last of the edit's list (`addZone` puts it after the zones that stand).
      let id = "";
      return apply((stored, members) => {
        const edit = addZone(stored, member, members);
        if (edit.ok) id = edit.zones[edit.zones.length - 1]?.id ?? "";
        return edit;
      }).then(() => id);
    },
    removeZone: (id) => apply((stored, members) => removeZone(stored, id, members)).then(done),
    giveZone: (id, member) => apply((stored, members) => giveZone(stored, id, member, members)).then(done),
    movePanels: (id, panelIds) => apply((stored, members) => movePanels(stored, id, panelIds, members)).then(done),
    setZoneOrder: (id, order) => apply((stored, members) => setZoneOrder(stored, id, order, members)).then(done),
  };
}
