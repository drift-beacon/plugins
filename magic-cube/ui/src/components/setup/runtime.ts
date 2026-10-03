import { useRef,useState } from "react";
import { saveStorage,useDriftBeacon } from "../../drift-beacon";
import { useCubeViewState,type ViewState } from "../../hooks/useCubeViewState";
import type { CubeSettings,CubeStatusState,LastRollState } from "../../storage";
import { activityById,categoryById,type CatalogActivity } from "./catalog";
import { drawPool,FACES,faceSlots,type Face,type FaceSlot,type Workspace } from "./model";

export type LiveView = ViewState;
export interface Roll {
  id: number;
  face: Face;
  slot: FaceSlot;
  activity: CatalogActivity | null;
  fromCategory: string | null;
  poolIds: string[];
  at: number;
  tracked: { kind: "span" | "point"; at: number } | null;
  auto: boolean;
  discarded: boolean;
  canDiscard: boolean;
}

/** Present only rolls received from the real runtime; all tracking actions go through the SDK. */
export function useCubeRuntime(ws: Workspace) {
  const ctx = useDriftBeacon();
  const lastRoll = ctx.storage.get<LastRollState>("lastRoll") ?? null;
  const status = ctx.storage.get<CubeStatusState>("cubeStatus") ?? null;
  const { viewState, transientRoll, dismiss } = useCubeViewState(status, lastRoll);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [discarded, setDiscarded] = useState<string | null>(null);
  const raw = transientRoll;
  let roll: Roll | null = null;
  if (raw && FACES.includes(String(raw.side) as Face)) {
    const face = String(raw.side) as Face;
    const preset = (ctx.storage.get<CubeSettings>("settings")?.presets ?? []).find(p => p.id === raw.presetId);
    const setup = preset ? preset.setup : ws.setup;
    const slot = { ...faceSlots(setup)[face], mapping: raw.mapping };
    const activity = raw.activityId ? activityById(raw.activityId) : null;
    const category = slot.mapping?.type === "category" ? slot.mapping.id : null;
    const session = raw.sessionId ? ctx.sessions.get(raw.sessionId) : undefined;
    roll = {
      id: Date.parse(raw.timestamp), face, slot, activity,
      fromCategory: category ? categoryById(category)?.name ?? null : null,
      poolIds: category ? drawPool(setup, category).map(a => a.id) : [],
      at: Date.parse(raw.timestamp), auto: raw.startMode === "auto",
      tracked: activity && raw.startMode ? { kind: activity.trackingType, at: session?.startedAt.getTime() ?? Date.parse(raw.timestamp) } : null,
      discarded: discarded === raw.timestamp,
      canDiscard: !!session?.isMine && (session.isLive || session.isPoint),
    };
  }
  async function action(fn: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : "The action failed. Please try again."); }
    finally { pending.current = false; setBusy(false); }
  }
  function track() {
    if (!raw?.activityId || raw.startMode) return;
    const target = raw;
    void action(async () => {
      const activity = ctx.activities.get(target.activityId!);
      if (!activity || activity.archived) throw new Error("This activity is no longer available.");
      const session = await activity.track();
      if (ctx.storage.get<LastRollState>("lastRoll")?.timestamp === target.timestamp) {
        await saveStorage({ lastRoll: { ...target, startMode: "manual", sessionId: session.id } });
      }
    });
  }
  function discard() {
    if (!raw?.sessionId) return;
    const target = raw;
    void action(async () => {
      const session = ctx.sessions.get(target.sessionId!);
      if (!session?.isMine) throw new Error("This session is no longer available.");
      await session.discard();
      setDiscarded(target.timestamp);
    });
  }
  return { view: viewState, roll, track, discard, dismiss: () => { setError(null); dismiss(); }, busy, error };
}
export type CubeRuntime = ReturnType<typeof useCubeRuntime>;
