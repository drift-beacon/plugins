/**
 * Who drives which controller. Every instance of this plugin (one per user and workspace) runs in the same host
 * process and shares this module, so module-level maps arbitrate between them: the first to claim a controller drives
 * it and the others report `busy`; and a yield to someone outside the plugin belongs to the controller, so no other
 * instance takes the wall straight back. This is the one piece of state deliberately kept at module scope.
 */

/** An instance that can hold claims: a unique token, and a label for logs ("user@workspace"). */
export interface ClaimOwner {
  readonly token: symbol;
  readonly label: string;
}

const claims = new Map<string, ClaimOwner>();

/** A new owner for one instance; two owners never match, even with the same label. */
export function createOwner(label: string): ClaimOwner {
  return Object.freeze({ token: Symbol(label), label });
}

/** Claims `controllerId` for `owner`. True when it was free or `owner` already held it. */
export function acquire(controllerId: string, owner: ClaimOwner): boolean {
  const current = claims.get(controllerId);
  if (current && current.token !== owner.token) return false;
  claims.set(controllerId, owner);
  return true;
}

/** Gives the claim up. Does nothing unless `owner` holds it, so a late release can't free someone else's claim. */
export function release(controllerId: string, owner: ClaimOwner): void {
  if (claims.get(controllerId)?.token === owner.token) claims.delete(controllerId);
}

/** Who holds `controllerId` now, or null when it is free. */
export function holder(controllerId: string): ClaimOwner | null {
  return claims.get(controllerId) ?? null;
}

/** A yield of one controller to someone outside the plugin (the Nanoleaf app, HomeKit…). `id` is unique. */
export interface YieldMark {
  readonly id: number;
  readonly reason: string;
}

const yields = new Map<string, YieldMark>();
let yieldSeq = 0;

/** An instance yielded `controllerId`: every instance treats it as yielded until one of them takes it again. */
export function markYielded(controllerId: string, reason: string): YieldMark {
  const mark = Object.freeze({ id: ++yieldSeq, reason });
  yields.set(controllerId, mark);
  return mark;
}

/** An instance took `controllerId` again (a takeover): the yield is over for everyone. */
export function clearYielded(controllerId: string): void {
  yields.delete(controllerId);
}

/** The yield `controllerId` is under, or null. */
export function yieldedMark(controllerId: string): YieldMark | null {
  return yields.get(controllerId) ?? null;
}
