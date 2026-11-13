/**
 * Tells main this copy is numbering panels (tap to order) or choosing them for a zone, while either holds: gestures on
 * the wall leave the workspace alone meanwhile. Each holder sets its own key; main hears `true` when the first takes
 * hold and `false` when the last lets go, and `true` again on `resend` (the model's `onResync`: main may have lost it).
 */
export interface NumberingHold {
  set(key: string, on: boolean): void;
  /** Says `true` again if anything holds. */
  resend(): void;
  /** Lets go of everything (unmount). */
  release(): void;
  readonly held: boolean;
}

export function createNumberingHold(send: (on: boolean) => void): NumberingHold {
  const holders = new Set<string>();
  return {
    set(key, on) {
      const before = holders.size > 0;
      if (on) holders.add(key);
      else holders.delete(key);
      const after = holders.size > 0;
      if (before !== after) send(after);
    },
    resend() {
      if (holders.size > 0) send(true);
    },
    release() {
      const before = holders.size > 0;
      holders.clear();
      if (before) send(false);
    },
    get held() {
      return holders.size > 0;
    },
  };
}
