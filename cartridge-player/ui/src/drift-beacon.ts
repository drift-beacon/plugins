import { connect, type UiContext } from "@drift-beacon/plugin/ui";
import { useSyncExternalStore } from "react";

let context: UiContext | null = null;
let revision = 0;
const listeners = new Set<() => void>();

function invalidate(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/** Connect to Drift Beacon once at startup; components re-render after every update from the app. */
export async function connectUi(): Promise<UiContext> {
  const ctx = await connect();
  if (context !== ctx) {
    context = ctx;
    ctx.onDataChange(invalidate);
  }
  return ctx;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getRevision(): number {
  return revision;
}

/** The connected UI context; the calling component re-renders after every update, including local writes. */
export function useDriftBeacon(): UiContext {
  useSyncExternalStore(subscribe, getRevision);
  if (!context) throw new Error("useDriftBeacon() needs connectUi() to resolve first");
  return context;
}

