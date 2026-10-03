import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Preview } from "../../../shared/types.ts";
import { createWallLease, type WallRequest } from "../lib/lease.ts";
import { useModel } from "../model.ts";

export type { WallRequest } from "../lib/lease.ts";

/** The editor's two preview channels: the drawing (instant, local) and the wall (leased requests to main). */
export interface WallPreview {
  /** What the drawing shows over the scene; null shows the scene. */
  readonly local: Preview | null;
  /** Shows `preview` on the drawing until it is replaced or cleared (null), or for `ms`. */
  showLocal(preview: Preview | null, ms?: number): void;
  /** Shows `request` on the wall until it is replaced or cleared (null), or for `ms`, renewing its lease meanwhile. */
  showWall(request: WallRequest | null, ms?: number): void;
}

/**
 * Local preview state plus leased `preview` requests (lib/lease.ts). A standing wall request is renewed every 1.5 s
 * while the editor wants it, and at once when main may have lost it (it restarted, or the connection to it was made
 * again); clearing it sends `mode: "none"`; requests are throttled to one per 120 ms with the latest one always
 * landing; unmounting clears anything still showing on the wall.
 */
export function useWallPreview(): WallPreview {
  const { actions, onResync } = useModel();
  const sendRef = useRef(actions.preview);
  useLayoutEffect(() => {
    sendRef.current = actions.preview;
  }, [actions.preview]);

  const [local, setLocal] = useState<Preview | null>(null);
  const localTimer = useRef(0);
  const [lease] = useState(() => createWallLease((request) => sendRef.current(request)));

  useEffect(() => {
    return () => {
      window.clearTimeout(localTimer.current);
      lease.release();
    };
  }, [lease]);
  useEffect(() => onResync(lease.resend), [onResync, lease]);

  const showLocal = useCallback((preview: Preview | null, ms?: number) => {
    window.clearTimeout(localTimer.current);
    setLocal(preview);
    if (preview && ms !== undefined) localTimer.current = window.setTimeout(() => setLocal(null), ms);
  }, []);

  return useMemo<WallPreview>(() => ({ local, showLocal, showWall: lease.show }), [local, showLocal, lease]);
}
