import type { PluginPeer, PluginStatus, UiContext } from "@drift-beacon/plugin/ui";
import { useEffect, useMemo, useState } from "react";
import type { PresenceState } from "../../shared/state.ts";
import { readMappings, readPlayerRecord, STORAGE_KEYS } from "../../shared/storage.ts";
import { useDriftBeacon } from "./drift-beacon.ts";
import { stableReader, stableRows } from "./lib/stable.ts";
import { createMainChannel } from "./main-channel.ts";
import type { PlayerModel } from "./model.ts";
import { mainStatusOf, STATUS_WAIT_MS } from "./view/main-status.ts";
import type { ReadingBeat } from "./view/phase.ts";
import { readPresence } from "./view/presence.ts";
import { type ActivityView, byId, type CategoryView, type LiveSession } from "./view/types.ts";

/** Its own peer, or null when this Drift Beacon doesn't share plugin status with UIs. */
function selfOf(ctx: UiContext): PluginPeer | null {
  try {
    return ctx.plugins.self;
  } catch {
    return null;
  }
}

/** A status as a comparable string: value is what counts, not identity. */
const statusKey = (status: PluginStatus | undefined) => (status ? `${status.state}\n${status.reason ?? ""}` : "");

/**
 * The live model: storage through the shared readers, workspace data mapped onto plain rows that keep their identity
 * while their value does, main's status and published `player` state through `ctx.plugins.self`, and the private
 * channel (`createMainChannel`) for the reading beat and every change. It re-renders on `onDataChange`
 * (useDriftBeacon), which also fires for main's status and state.
 */
export function useLiveModel(): PlayerModel {
  const ctx = useDriftBeacon();
  const self = selfOf(ctx);

  // One reader per value for the page's life: each keeps its object (or row) until the value really changes.
  const [read] = useState(() => ({
    mappings: stableReader(readMappings),
    record: stableReader(readPlayerRecord),
    presence: stableReader((raw) => (raw === undefined ? null : readPresence(raw))),
    activities: stableRows<ActivityView>(),
    categories: stableRows<CategoryView>(),
    live: stableRows<LiveSession>(),
  }));

  // The SDK's lists keep their identity until any workspace collection changes; the rows are rebuilt then, and
  // `stableRows` hands back the ones (and the list) that came out the same.
  const activityList = ctx.activities.list({ includeArchived: true });
  const categoryList = ctx.categories.list();
  const liveList = ctx.sessions.live({ mine: true });
  const activities = useMemo(
    () =>
      read.activities(
        activityList.map(
          (activity): ActivityView => ({
            id: activity.id,
            name: activity.name,
            color: activity.color,
            iconPath: activity.iconPath,
            categoryId: activity.categoryId,
            categoryName: activity.category?.name ?? null,
            archived: activity.archived,
            point: activity.trackingType === "point",
          }),
        ),
      ),
    [read, activityList],
  );
  const lookup = useMemo(() => byId(activities), [activities]);
  const categories = useMemo(
    () =>
      read.categories(
        categoryList.map(
          (category): CategoryView => ({ id: category.id, name: category.name, color: category.color, iconPath: category.iconPath }),
        ),
      ),
    [read, categoryList],
  );
  const live = useMemo(
    () =>
      read.live(
        liveList
          .filter((session) => session.isSpan)
          .map((session): LiveSession => ({ id: session.id, activityId: session.activityId, startedAt: session.startedAt.getTime() })),
      ),
    [read, liveList],
  );

  const mappings = read.mappings(ctx.storage.get(STORAGE_KEYS.mappings));
  const record = read.record(ctx.storage.get(STORAGE_KEYS.player));
  const presence: PresenceState | null = read.presence(self?.state.get("player"));

  // Main's status: an `unavailable` the page opened with is confirmed by a change, or by waiting STATUS_WAIT_MS.
  const [opened] = useState(() => statusKey(self?.status));
  const [heard, setHeard] = useState(false);
  const [waited, setWaited] = useState(false);
  if (!heard && statusKey(self?.status) !== opened) setHeard(true);
  useEffect(() => {
    const id = window.setTimeout(() => setWaited(true), STATUS_WAIT_MS);
    return () => window.clearTimeout(id);
  }, []);
  const { state: mainStatus, reason: mainStatusReason } = mainStatusOf(self?.status, heard || waited);

  const channel = useMemo(() => createMainChannel(ctx.main, () => readPlayerRecord(ctx.storage.get(STORAGE_KEYS.player))), [ctx]);
  const [reading, setReading] = useState<ReadingBeat | null>(null);
  useEffect(() => channel.onReading(setReading), [channel]);

  return useMemo<PlayerModel>(
    () => ({
      activities,
      lookup,
      categories,
      live,
      mappings,
      record,
      presence,
      mainStatus,
      mainStatusReason,
      reading,
      apiPath: ctx.plugin.apiPath,
      pageHost: window.location.hostname,
      actions: channel.actions,
    }),
    [activities, lookup, categories, live, mappings, record, presence, mainStatus, mainStatusReason, reading, ctx.plugin.apiPath, channel],
  );
}
