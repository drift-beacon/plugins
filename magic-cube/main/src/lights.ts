/**
 * The cube's hold on the Nanoleaf wall (the Nanoleaf plugin's `takeControl` and `releaseControl`): a slow pulse of the
 * faces' colours while the cube is held, a shuffle while it is shaken, a reveal of the winner when it lands. One
 * request is out at a time and only the latest wish waits behind it, so a quick hold, shake and land arrive in order.
 * Nothing here throws: the lights are a nicety, and a Nanoleaf plugin that isn't there is not an error.
 */

/** What the wall should show: `pulse` and `shuffle` hold it until let go, `reveal` plays once and lets go by itself. */
export interface LightEffect {
  readonly type: 'pulse' | 'shuffle' | 'reveal';
  /** CSS colours, at least one. */
  readonly colors: readonly string[];
  /** `reveal`: the colour it ends on. */
  readonly color?: string;
}

/** What `takeControl` answers, as far as the cube reads it. */
interface TakeAnswer {
  readonly granted?: boolean;
  readonly leaseId?: string | null;
}

export interface LightsOptions {
  /** Runs one of the Nanoleaf plugin's commands. */
  readonly command: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  readonly log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  readonly now?: () => number;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (id: unknown) => void;
}

/** A hold lasts this long unless renewed: longer than the cube's own minute of inactivity. */
export const LEASE_MS = 75_000;
/** While the cube is in hand, its messages renew the hold at most this often. */
export const RENEW_EVERY_MS = 15_000;
/** With no message from the cube for this long, the lights are let go: a missed inactivity report can't keep them. */
export const SILENCE_MS = 70_000;

/** Codes that mean the Nanoleaf plugin isn't there to ask: nothing ran, and nothing is held. */
const ABSENT = new Set(['not-installed', 'disabled', 'incompatible', 'unavailable']);

const codeOf = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;
const sameEffect = (a: LightEffect, b: LightEffect) =>
  a.type === b.type && a.color === b.color && a.colors.length === b.colors.length && a.colors.every((c, i) => c === b.colors[i]);

export interface Lights {
  /** Show this on the wall, in place of whatever the cube showed before. */
  show(effect: LightEffect): void;
  /** Let the wall go. */
  release(): void;
  /** The cube said something while in hand: keep the hold alive. */
  touch(): void;
  /** Lets go and waits for it, as far as that is still possible. */
  stop(): Promise<void>;
}

export function createLights(options: LightsOptions): Lights {
  const now = options.now ?? Date.now;
  const later = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.clearTimeout ?? (id => clearTimeout(id as ReturnType<typeof setTimeout>));

  /** The latest wish: an effect to show, or null to hold nothing. `sent` is what the wall was last asked for. */
  let wanted: LightEffect | null = null;
  let sent: LightEffect | null = null;
  let sentAt = 0;
  /** A looping effect should be sent again to renew its lease. */
  let renew = false;
  /** The cube may hold the wall: a grant, or a request whose answer never came. */
  let mayHold = false;
  let leaseId: string | null = null;
  /** A request is out; `done` settles when nothing is left to ask. */
  let busy = false;
  let done: Promise<void> = Promise.resolve();
  let silence: unknown = null;
  let absentLogged = false;
  let requests = 0;

  const watchSilence = (on: boolean) => {
    if (silence !== null) cancel(silence);
    silence = on ? later(() => { silence = null; options.log.info('No word from the cube: letting the lights go'); release(); }, SILENCE_MS) : null;
  };

  const failed = (what: string, error: unknown): boolean => {
    const code = codeOf(error);
    if (code && ABSENT.has(code)) {
      if (!absentLogged) options.log.info(`Nanoleaf isn't available (${code}): the cube won't light it`);
      absentLogged = true;
      return false;
    }
    options.log.warn(`Could not ${what} the Nanoleaf`, error);
    return true;
  };

  async function take(effect: LightEffect): Promise<void> {
    // One id per wish, so asking again after a lost answer can't play a reveal twice or renew twice.
    const requestId = `${now().toString(36)}-${++requests}`;
    const input = { effect: { type: effect.type, colors: [...effect.colors], ...(effect.color ? { color: effect.color } : {}) }, ttlMs: LEASE_MS, requestId };
    let answer: TakeAnswer | undefined;
    try {
      try { answer = (await options.command('takeControl', input)) as TakeAnswer; }
      catch (error) {
        if (codeOf(error) !== 'timeout') throw error;
        answer = (await options.command('takeControl', input)) as TakeAnswer;
      }
    } catch (error) {
      // Unanswered: it may have run, so there may be something to let go of.
      mayHold = failed('light', error) || mayHold;
      return;
    }
    absentLogged = false;
    // A reveal lets go by itself when it has played; someone else holding the wall leaves the cube with nothing.
    mayHold = answer?.granted === true && effect.type !== 'reveal';
    leaseId = mayHold ? (answer?.leaseId ?? null) : null;
  }

  async function letGo(): Promise<void> {
    const held = leaseId;
    mayHold = false;
    leaseId = null;
    try { await options.command('releaseControl', held ? { leaseId: held } : {}); }
    catch (error) { failed('release', error); }
  }

  /** Asks for the latest wish until the wall has been asked for it. Ends in the same turn it finds nothing to ask. */
  async function pump(): Promise<void> {
    for (;;) {
      const next = wanted;
      if (next && (renew || !sent || !sameEffect(sent, next))) {
        renew = false;
        sent = next;
        sentAt = now();
        await take(next);
        // A reveal is one wish, played once: nothing more is wanted after it.
        if (next.type === 'reveal' && wanted === next) { wanted = null; sent = null; }
      } else if (!next && (mayHold || sent)) {
        sent = null;
        if (mayHold) await letGo();
      } else {
        busy = false;
        return;
      }
    }
  }

  const run = () => {
    if (busy) return;
    busy = true;
    done = pump();
  };

  function release(): void {
    wanted = null;
    watchSilence(false);
    run();
  }

  return {
    show(effect) {
      wanted = effect;
      watchSilence(effect.type !== 'reveal');
      run();
    },
    release,
    touch() {
      if (!wanted || wanted.type === 'reveal') return;
      watchSilence(true);
      if (now() - sentAt >= RENEW_EVERY_MS) { renew = true; run(); }
    },
    async stop() {
      release();
      await done;
    },
  };
}
