/**
 * Giving the wall back: what it was showing before the plugin took it (`Handback`, kept in storage so a restart while
 * streaming can still restore it), and the requests that put it back as `settings.idle` says. Capture and planning are
 * pure; `runHandback` performs a plan against a client.
 */
import { staticDisplay } from "../../shared/protocol.ts";
import type { Handback, IdleBehaviour } from "../../shared/types.ts";
import { NanoleafError, type NanoleafInfo, type RequestOptions, type StatePatch } from "./nanoleaf/http.ts";

/** What `effects.select` reads while a client streams extControl frames. */
export const EXT_CONTROL_EFFECT = "*ExtControl*";
/** What `effects.select` reads while a static display shows (the plugin's static fallback, or someone's scene). */
export const STATIC_EFFECT = "*Static*";
/** What `effects.select` reads for a plain hue/saturation or colour temperature. */
export const SOLID_EFFECT = "*Solid*";

/** One request of a hand-back. `first-effect` selects the first saved effect, looked up when it runs. */
export type HandbackStep =
  | { readonly kind: "state"; readonly patch: StatePatch }
  | { readonly kind: "select"; readonly effect: string }
  | { readonly kind: "write"; readonly body: object }
  | { readonly kind: "first-effect" };

/** The part of `NanoleafClient` a hand-back uses (tests pass a fake). */
export interface HandbackClient {
  info(options?: RequestOptions): Promise<NanoleafInfo>;
  setState(patch: StatePatch, options?: RequestOptions): Promise<void>;
  selectEffect(name: string, options?: RequestOptions): Promise<void>;
  write(body: object, options?: RequestOptions): Promise<unknown>;
}

/** Reserved names such as `*Solid*`: selecting one doesn't restore anything, so they are never selected. */
export function isReservedEffect(name: string): boolean {
  return name.length >= 2 && name.startsWith("*") && name.endsWith("*");
}

function clampInt(value: number | null, min: number, max: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Whether the wall still shows the plugin's own output from a run that stopped without handing back (a crash, a
 * restart, the controller dropping off), so `stored` is still what to restore: it streams (`*ExtControl*`), or it
 * shows a static display while the stored scene wasn't one, which is the static fallback's frozen frame.
 */
export function stillOurs(stored: Handback | null, controllerId: string, effect: string | null): stored is Handback {
  if (!stored || stored.controllerId !== controllerId) return false;
  return effect === EXT_CONTROL_EFFECT || (effect === STATIC_EFFECT && stored.effect !== STATIC_EFFECT);
}

/**
 * The hand-back to store at takeover. A stored one for the same controller wins while the wall still shows the
 * plugin's output (`stillOurs`): the plugin restarted mid-drive and the controller no longer knows what came before.
 * Otherwise it is read from `info` (plus the static scene's animData when the effect is `*Static*`).
 */
export function captureHandback(
  controllerId: string,
  info: NanoleafInfo,
  staticAnimData: string | null,
  stored: Handback | null,
  takenAt: string,
): Handback {
  const effect = info.effects.select;
  if (stillOurs(stored, controllerId, effect)) return stored;
  const { state } = info;
  return {
    controllerId,
    on: state.on,
    brightness: clampInt(state.brightness, 0, 100) ?? 100,
    effect,
    colorMode: state.colorMode,
    hue: clampInt(state.hue, 0, 360),
    sat: clampInt(state.sat, 0, 100),
    ct: clampInt(state.ct, 1200, 6500),
    staticAnimData: effect === STATIC_EFFECT ? staticAnimData : null,
    takenAt,
  };
}

/** How to put back a `*Solid*` colour: ct when that was the mode, else hue and saturation, else ct if known. */
function solidPatch(handback: Handback): StatePatch | null {
  const { hue, sat, ct, colorMode } = handback;
  if (colorMode === "ct" && ct !== null) return { ct: { value: ct } };
  if (hue !== null && sat !== null) return { hue: { value: hue }, sat: { value: sat } };
  if (ct !== null) return { ct: { value: ct } };
  return null;
}

/**
 * The request that puts the scene back: a named effect is selected, `*Solid*` gets its colour back, `*Static*` its
 * animData, anything else (or no hand-back) the first saved effect.
 */
function sceneStep(handback: Handback | null): HandbackStep {
  if (!handback) return { kind: "first-effect" };
  const effect = handback.effect;
  if (effect !== null && !isReservedEffect(effect)) return { kind: "select", effect };
  const solid = effect === SOLID_EFFECT ? solidPatch(handback) : null;
  if (solid) return { kind: "state", patch: solid };
  if (effect === STATIC_EFFECT && handback.staticAnimData) {
    return { kind: "write", body: staticDisplay(handback.staticAnimData) };
  }
  return { kind: "first-effect" };
}

/**
 * The requests that hand the wall back: the scene first (`sceneStep`), then its brightness, and `off` last when idle
 * is `off` or the wall was off before. Turning off without the scene would leave the controller in `*ExtControl*` on
 * the grace's black frame, which is what the next power-on (button, app, HomeKit) would show. Without a hand-back,
 * `restore` can only pick the first saved effect.
 */
export function handbackPlan(handback: Handback | null, idle: IdleBehaviour): HandbackStep[] {
  const scene = sceneStep(handback);
  const brightness: StatePatch = handback ? { brightness: { value: handback.brightness } } : {};
  if (idle === "off" || (handback && !handback.on)) {
    return [scene, { kind: "state", patch: { ...brightness, on: { value: false } } }];
  }
  return handback ? [scene, { kind: "state", patch: brightness }] : [scene];
}

/**
 * Performs a plan in order. A refused request (`rejected`, for example an effect deleted since) doesn't stop the rest,
 * and a refused `select` falls back to the first saved effect; the refusals are returned for the log. Anything else
 * (unreachable, timeout, abort) stops at once and is thrown, so the caller keeps the stored hand-back for later.
 */
export async function runHandback(
  client: HandbackClient,
  steps: readonly HandbackStep[],
  options?: RequestOptions,
): Promise<NanoleafError[]> {
  const refused: NanoleafError[] = [];
  const attempt = async (step: HandbackStep): Promise<boolean> => {
    try {
      await runStep(client, step, options);
      return true;
    } catch (error) {
      if (!(error instanceof NanoleafError) || error.kind !== "rejected") throw error;
      refused.push(error);
      return false;
    }
  };
  for (const step of steps) {
    if (!(await attempt(step)) && step.kind === "select") await attempt({ kind: "first-effect" });
  }
  return refused;
}

async function runStep(client: HandbackClient, step: HandbackStep, options?: RequestOptions): Promise<void> {
  switch (step.kind) {
    case "state":
      await client.setState(step.patch, options);
      return;
    case "select":
      await client.selectEffect(step.effect, options);
      return;
    case "write":
      await client.write(step.body, options);
      return;
    case "first-effect": {
      const first = (await client.info(options)).effects.effectsList.find((name) => !isReservedEffect(name));
      if (first !== undefined) await client.selectEffect(first, options);
      return;
    }
  }
}
