/**
 * The connection to the paired controller: pairing, the cached layout, the event stream and the published
 * `connection` state. It starts from storage `controller`, keeps retrying with backoff while the controller can't be
 * reached, looks for it at a new address when that goes on (`#searchFor`), and tells the Director (through callbacks
 * index.ts wires) about the link, layout and device events.
 */
import { PluginError } from "@drift-beacon/plugin";
import { SHAPES } from "../../shared/geometry.ts";
import { readController, readLayout, sameLayout } from "../../shared/storage.ts";
import {
  type ConnectionInfo,
  type ConnectionStatus,
  type ControllerConfig,
  type FoundController,
  type Layout,
  STORAGE_KEYS,
} from "../../shared/types.ts";
import type { PairingStep, PairResult } from "../../shared/ui-channel.ts";
import {
  EFFECTS_EVENT,
  effectName,
  type EventStreamOptions,
  LAYOUT_EVENT,
  type NanoleafEvent,
  STATE_EVENT,
  stateAttrs,
  TOUCH_EVENT,
  type Touch,
  touches,
} from "./nanoleaf/events.ts";
import { NanoleafError, type NanoleafInfo, type PanelLayoutData, type RequestOptions } from "./nanoleaf/http.ts";
import { type DeviceEvent, GLOBAL_TIMERS, type Link, type Log, type StoragePort, type Timers } from "./ports.ts";

/** How the Controller paces reconnects, health checks and pairing. */
export interface ControllerTimings {
  /** Waits before each reconnect while unreachable; the last repeats. */
  readonly retryMs: readonly number[];
  /** While connected but without the event stream, check the controller this often. */
  readonly healthMs: number;
  /** Ask for a token this often while pairing. */
  readonly pairPollMs: number;
  /** Stop asking this long before the request's deadline, to leave time to answer. */
  readonly pairMarginMs: number;
  /** Search the network for the controller once this many reconnects in a row have failed. */
  readonly searchAfterFailures: number;
  /** Leave at least this long between the searches the Controller starts by itself. */
  readonly searchEveryMs: number;
}

/** The pacing DESIGN.md specifies. */
export const DEFAULT_CONTROLLER_TIMINGS: ControllerTimings = Object.freeze({
  retryMs: Object.freeze([2000, 5000, 10_000, 20_000, 30_000, 60_000]),
  healthMs: 30_000,
  pairPollMs: 1000,
  pairMarginMs: 1500,
  searchAfterFailures: 2,
  searchEveryMs: 60_000,
});

/** A search tries at most this many of the addresses discovery found. */
const SEARCH_CANDIDATES = 8;

/** The part of `NanoleafClient` the Controller uses. */
export interface ControllerClient {
  info(options?: RequestOptions): Promise<NanoleafInfo>;
  layout(options?: RequestOptions): Promise<PanelLayoutData>;
  revoke(options?: RequestOptions): Promise<void>;
}

/** An open event stream (`EventStream`). */
export interface EventsHandle {
  close(): void;
}

/** Everything a Controller needs. */
export interface ControllerOptions {
  readonly storage: StoragePort;
  readonly log: Log;
  readonly createClient: (config: { host: string; port: number; token: string }) => ControllerClient;
  /**
   * Rejects with a `PluginError` when `host` isn't one the server should connect to (index.ts: the local network
   * only, lan.ts). It catches mistakes (a mistyped or public address), it isn't a security boundary: a host name is
   * looked up again by each connection. Asked before every (re)connection: for the host `pair` is given, for the
   * stored controller (storage can hold anything: an older version's value, one written by hand) and for an address
   * a search found. Rejects with the signal's reason when it aborts.
   */
  readonly checkHost?: (host: string, signal: AbortSignal) => Promise<void>;
  /** Whether anything answers HTTP there. */
  readonly probe: (host: string, port: number, signal?: AbortSignal) => Promise<boolean>;
  /** `POST /api/v1/new`: a token, or null while the pairing window is closed. */
  readonly requestToken: (host: string, port: number, signal?: AbortSignal) => Promise<string | null>;
  readonly openEvents: (options: EventStreamOptions) => EventsHandle;
  /**
   * Looks for controllers on the server's network (index.ts: discovery.ts), for finding the paired one again after
   * its address changed. Resolves with what it found so far when `signal` aborts. Without it nothing is searched.
   */
  readonly discover?: (signal: AbortSignal) => Promise<readonly FoundController[]>;
  readonly publish: (info: ConnectionInfo) => void;
  /** The link (status, controller, event stream) changed. */
  readonly onLink: (link: Link) => void;
  /** The stored layout was (re)checked after a connect or a layout event. */
  readonly onLayout: () => void;
  readonly onDeviceEvent: (event: DeviceEvent) => void;
  readonly onTouch: (touch: Touch) => void;
  /** Hands the wall back before the controller is forgotten or replaced (the Director's `handBack`). */
  readonly handBack: () => Promise<void>;
  readonly now?: () => number;
  readonly timers?: Timers;
  readonly timings?: Partial<ControllerTimings>;
}

export type { PairResult } from "../../shared/ui-channel.ts";

/** Why pairing gave up when the controller never handed out a token. */
export const PAIR_WINDOW_MESSAGE =
  "The controller didn't open its pairing window. Hold its power button for 5–7 seconds until the lights flash, " +
  "then try again.";
/** The connection error while the token is refused. */
export const UNAUTHORIZED_MESSAGE =
  "The controller no longer accepts the plugin's access token; it may have been reset";
/** Why a request that needs a controller can't run. */
export const NOT_PAIRED_MESSAGE = "No controller is paired yet";
/** Why a request still running when the instance stopped gave up. */
export const STOPPED_MESSAGE = "The plugin stopped";

type ConnectionCore = Omit<ConnectionInfo, "since">;

/** The id claims, layout and hand-back use: the serial number, else `host:port`. */
export function controllerIdOf(config: ControllerConfig, info?: NanoleafInfo | null): string {
  return info?.serialNo ?? config.id ?? `${config.host}:${config.port}`;
}

/** Light panels (types 7, 8, 9) in a layout. */
export function countLightPanels(layout: Layout | null): number {
  return layout ? layout.panels.filter((panel) => SHAPES[panel.shapeType]?.light === true).length : 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Owns the connection. `start()` once; `stop()` when the instance stops. */
export class Controller {
  readonly #o: ControllerOptions;
  readonly #t: ControllerTimings;
  readonly #now: () => number;
  readonly #timers: Timers;
  /**
   * The stored controller. While the status is `connected` its host is one `checkHost` passed (when it was asked: a
   * name is looked up again by each connection, see lan.ts): `#set` shows this
   * config to the Director and in `connection`, and the Director sends to a connected link's address. So whoever
   * points it at another address leaves `connected` in that same step (`#connect`) or has checked the host itself
   * (`pair`).
   */
  #config: ControllerConfig | null = null;
  #client: { readonly key: string; readonly client: ControllerClient } | null = null;
  #controllerId: string | null = null;
  #core: ConnectionCore = {
    status: "unconfigured",
    host: null,
    port: null,
    name: null,
    model: null,
    firmware: null,
    error: null,
    retryAt: null,
    events: false,
  };
  #since = "";
  #published = false;
  #link: Link | null = null;
  #events: EventsHandle | null = null;
  #retryTimer: unknown = null;
  #healthTimer: unknown = null;
  #failures = 0;
  /** Bumped by every (re)connect, forget and stop: answers to older requests are ignored. */
  #generation = 0;
  #checking = false;
  #stopped = false;
  /**
   * Aborted by `stop()`: pairing's requests and waits end with it. A request's own signal aborts at a stop too, but
   * also at its deadline and when the interface gives up, and once a token was issued only a stop may cancel: from
   * then on pairing uses this signal alone.
   */
  readonly #stop = new AbortController();
  /** `forget()` is handing back and revoking: nothing reconnects, re-reads, refreshes or searches meanwhile. */
  #forgetting = false;
  /** `pair()` calls under way: no search starts or adopts anything meanwhile. */
  #pairing = 0;
  /** The search under way: its cancel switch and its outcome (whether the controller was found elsewhere). */
  #search: { readonly abort: AbortController; readonly moved: Promise<boolean> } | null = null;
  /** When the last search started, for `searchEveryMs`. */
  #searchedAt: number | null = null;

  constructor(options: ControllerOptions) {
    this.#o = options;
    this.#t = { ...DEFAULT_CONTROLLER_TIMINGS, ...options.timings };
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? GLOBAL_TIMERS;
  }

  /** The connection as last published. */
  get connection(): ConnectionInfo {
    return { ...this.#core, since: this.#since };
  }

  get status(): ConnectionStatus {
    return this.#core.status;
  }

  /** Reads storage `controller`, publishes the first `connection` and starts connecting (without waiting). */
  start(): void {
    this.#config = readController(this.#o.storage.get(STORAGE_KEYS.controller));
    if (!this.#config) this.#set({ status: "unconfigured" });
    else void this.#connect();
  }

  /** Stops for good: timers, the event stream, pending answers, and any pairing under way. */
  stop(): void {
    this.#stopped = true;
    this.#generation++;
    this.#clearTimers();
    this.#closeEvents();
    this.#cancelSearch();
    this.#stop.abort(new PluginError("stopped", STOPPED_MESSAGE));
  }

  /** Storage `controller` changed elsewhere: follow it. */
  reload(): void {
    if (this.#stopped || this.#forgetting) return;
    const config = readController(this.#o.storage.get(STORAGE_KEYS.controller));
    const current = this.#config;
    const same =
      config === current ||
      (config !== null &&
        current !== null &&
        config.host === current.host &&
        config.port === current.port &&
        config.token === current.token);
    if (same) return;
    // Whatever a search was looking for, it isn't the stored controller any more.
    this.#cancelSearch();
    this.#config = config;
    if (config) void this.#connect();
    else {
      this.#generation++;
      this.#clearTimers();
      this.#dropEvents();
      this.#controllerId = null;
      this.#set({ status: "unconfigured", name: null, model: null, firmware: null, error: null, retryAt: null });
    }
  }

  /**
   * The Director hit an error while driving: check the controller now, so a revoked token shows as unauthorized and
   * a vanished controller as unreachable.
   */
  reportError(error: unknown): void {
    if (this.#stopped || this.#forgetting || this.#core.status !== "connected") return;
    if (error instanceof NanoleafError && error.kind === "rejected") return;
    void this.#check();
  }

  /**
   * Pairs with the controller at `host:port`: checks the host (`checkHost`), probes it, asks for a token every second
   * until shortly before `deadline`, then stores it with the layout and connects. `onStep` hears how far it got:
   * `waiting` once the controller answered, `connecting` once it handed out a token. Throws `PluginError` `invalid`
   * (a host the server may not connect to), `unavailable`, `failed` or, when the instance stops meanwhile, `stopped`
   * (then nothing is stored, adopted or opened). When `signal` aborts before a token was issued (the deadline, or the
   * interface gave up), it throws the signal's reason and nothing changed; after that `signal` is no longer read.
   */
  async pair(
    host: string,
    port: number,
    signal: AbortSignal,
    deadline: number,
    onStep?: (step: PairingStep) => void,
  ): Promise<PairResult> {
    // The user is choosing the controller: a search must not move the stored one under the pairing.
    this.#pairing++;
    this.#cancelSearch();
    try {
      return await this.#pair(host, port, signal, deadline, onStep);
    } finally {
      this.#pairing--;
    }
  }

  async #pair(
    host: string,
    port: number,
    signal: AbortSignal,
    deadline: number,
    onStep?: (step: PairingStep) => void,
  ): Promise<PairResult> {
    const abort = AbortSignal.any([signal, this.#stop.signal]);
    this.#live(abort);
    await this.#o.checkHost?.(host, abort);
    this.#live(abort);
    const reachable = await this.#o.probe(host, port, abort);
    this.#live(abort);
    if (!reachable) throw new PluginError("unavailable", `Can't reach a controller at ${host}:${port}`);
    onStep?.("waiting");
    const until = deadline - this.#t.pairMarginMs;
    let token: string | null = null;
    for (;;) {
      try {
        token = await this.#o.requestToken(host, port, abort);
      } catch (error) {
        this.#live(abort);
        if (!(error instanceof NanoleafError)) throw error;
        this.#o.log.warn("Asking the controller for a token failed", error);
      }
      this.#live(abort);
      if (token) break;
      const wait = Math.min(this.#t.pairPollMs, until - this.#now());
      if (wait <= 0) break;
      await this.#sleep(wait, abort);
    }
    if (!token) throw new PluginError("failed", PAIR_WINDOW_MESSAGE);
    onStep?.("connecting");

    // From here only a stop cancels, not the caller's deadline or its giving up: the controller issued a token, which
    // would stay on it unused, and the hand-back below holds the Director until the link changes, so stopping halfway
    // would strand it on the old controller.
    const stop = this.#stop.signal;
    const client = this.#o.createClient({ host, port, token });
    let info: NanoleafInfo;
    try {
      info = await client.info({ signal: stop });
    } catch (error) {
      // Nothing was stored, so nothing would ever use the token: give it back (best effort; a stop ends that too).
      if (!this.#stopped) {
        await client
          .revoke({ signal: stop })
          .catch((failure: unknown) => this.#o.log.warn("Couldn't revoke the token of a pairing that failed", failure));
      }
      throw error;
    }
    this.#live();
    const config: ControllerConfig = {
      host,
      port,
      token,
      id: info.serialNo,
      name: info.name,
      model: info.model,
    };
    const previous = this.#config;
    if (previous && (previous.host !== host || previous.port !== port)) {
      await this.#o.handBack();
      this.#live();
    }
    // The old link goes quiet first; `#adopt` then publishes the new config and controller id together, so the
    // Director never sees one controller's address with another's id.
    this.#generation++;
    this.#clearTimers();
    this.#dropEvents();
    this.#config = config;
    this.#write(STORAGE_KEYS.controller, config);
    this.#adopt(config, info);
    return {
      name: info.name,
      model: info.model,
      panels: countLightPanels(this.#layoutFor(controllerIdOf(config, info))),
    };
  }

  /**
   * Hands the wall back, revokes the token (best effort) and forgets the controller and its layout. Nothing
   * reconnects while it runs, and whatever connected meanwhile (a pair) is closed with it.
   */
  async forget(): Promise<void> {
    this.#live();
    const config = this.#config;
    this.#forgetting = true;
    this.#generation++;
    this.#clearTimers();
    this.#closeEvents();
    this.#cancelSearch();
    try {
      await this.#o.handBack();
      if (config && !this.#stopped) {
        try {
          await this.#o.checkHost?.(config.host, this.#stop.signal);
          await this.#clientFor(config).revoke({ signal: this.#stop.signal });
        } catch (error) {
          this.#o.log.warn("Couldn't revoke the access token", error);
        }
      }
    } finally {
      this.#forgetting = false;
    }
    this.#live();
    this.#generation++;
    this.#clearTimers();
    this.#dropEvents();
    this.#config = null;
    this.#controllerId = null;
    this.#write(STORAGE_KEYS.controller, null);
    this.#write(STORAGE_KEYS.layout, null);
    this.#set({ status: "unconfigured", name: null, model: null, firmware: null, error: null, retryAt: null });
  }

  /**
   * Reconnects and re-reads the layout. Asked while the controller can't be reached (the notice's "Search again"),
   * it also searches for it at another address at once, whatever the pacing of the Controller's own searches.
   * Throws `PluginError` when there is no controller or it can't be reached.
   */
  async refresh(): Promise<{ panels: number }> {
    const config = this.#config;
    if (!config || this.#forgetting) throw new PluginError("invalid", NOT_PAIRED_MESSAGE);
    const lost = this.#core.status === "unreachable";
    const connecting = this.#connect();
    // Found elsewhere: the attempt at the old address is over (its answer is ignored), so there is nothing to wait for.
    if (!lost || !(await this.#startSearch())) await connecting;
    this.#live();
    // Forgotten meanwhile: there is nothing to report on.
    if (!this.#config || this.#forgetting) throw new PluginError("invalid", NOT_PAIRED_MESSAGE);
    const status = this.#core.status;
    if (status === "connected") return { panels: countLightPanels(this.#layoutFor(this.#controllerId)) };
    if (status === "unauthorized") throw new PluginError("failed", this.#core.error ?? UNAUTHORIZED_MESSAGE);
    throw new PluginError("unavailable", this.#core.error ?? `Can't reach the controller at ${config.host}`);
  }

  /* ---- Connecting ---- */

  /**
   * One connection attempt: the host check, then `info()`. It ends connected (layout, events), unauthorized, or
   * unreachable: with backoff, or without when the stored host isn't one the server may connect to.
   */
  async #connect(): Promise<void> {
    const config = this.#config;
    if (!config || this.#stopped || this.#forgetting) return;
    const generation = ++this.#generation;
    this.#clearTimers();
    // A refresh while connected keeps the status: the Director shouldn't see the wall drop for a moment. Another
    // address is another connection: checks and re-reads run while connected, and so does the Director, and none may
    // go there before its host has passed the check. So the new address first shows as `connecting`, in one step:
    // `#config` already holds it, and anything published before that (the event stream closing, say) would show it
    // as connected.
    const moved = this.#core.host !== config.host || this.#core.port !== config.port;
    if (this.#core.status !== "connected" || moved) {
      this.#dropEvents();
      this.#set({
        status: "connecting",
        host: config.host,
        port: config.port,
        error: null,
        retryAt: null,
        events: false,
      });
    }
    try {
      await this.#o.checkHost?.(config.host, this.#stop.signal);
      if (generation !== this.#generation || this.#stopped) return;
      const info = await this.#clientFor(config).info({ signal: this.#stop.signal });
      if (generation !== this.#generation || this.#stopped) return;
      this.#dropEvents();
      this.#adopt(config, info);
    } catch (error) {
      if (generation !== this.#generation || this.#stopped) return;
      // Straight to what `#failed` makes of it: a refresh was still `connected`, and its host may be the one that
      // just failed the check (a name that leads somewhere else now).
      this.#dropEvents();
      this.#failed(error);
    }
  }

  /** Connected: remember what the controller said, store its layout, open the event stream. */
  #adopt(config: ControllerConfig, info: NanoleafInfo): void {
    const controllerId = controllerIdOf(config, info);
    this.#controllerId = controllerId;
    this.#failures = 0;
    // It answers: nothing is lost (a search that just found it is over already).
    this.#cancelSearch();
    this.#storeLayout(controllerId, info.panelLayout);
    const updated: ControllerConfig = {
      ...config,
      id: info.serialNo ?? config.id,
      name: info.name ?? config.name,
      model: info.model ?? config.model,
    };
    const current = updated.id === config.id && updated.name === config.name && updated.model === config.model;
    this.#config = current ? config : updated;
    if (!current) this.#write(STORAGE_KEYS.controller, updated);
    this.#set({
      status: "connected",
      host: config.host,
      port: config.port,
      name: updated.name,
      model: updated.model,
      firmware: info.firmwareVersion,
      error: null,
      retryAt: null,
      events: false,
    });
    this.#openEvents(this.#config);
    this.#o.onLayout();
  }

  #failed(error: unknown): void {
    if (error instanceof NanoleafError && error.kind === "unauthorized") {
      this.#set({ status: "unauthorized", error: UNAUTHORIZED_MESSAGE, retryAt: null, events: false });
      return;
    }
    // `checkHost` refused the stored host, and nothing was sent. Trying again changes nothing until the address does,
    // so there is no retry: `error` says what to enter instead.
    if (error instanceof PluginError && error.code === "invalid") {
      this.#set({ status: "unreachable", error: error.message, retryAt: null, events: false });
      return;
    }
    const delays = this.#t.retryMs;
    const delay = delays[Math.min(this.#failures, delays.length - 1)] ?? 60_000;
    this.#failures++;
    this.#set({
      status: "unreachable",
      error: describe(error),
      retryAt: new Date(this.#now() + delay).toISOString(),
      events: false,
    });
    this.#retryTimer = this.#timers.setTimeout(() => {
      this.#retryTimer = null;
      void this.#connect();
    }, delay);
    // Still nothing after a couple of tries: its address may have changed (a new DHCP lease). The retries go on.
    const searched = this.#searchedAt;
    const due = searched === null || this.#now() - searched >= this.#t.searchEveryMs;
    if (this.#failures >= this.#t.searchAfterFailures && due) void this.#startSearch();
  }

  /* ---- Finding the controller again ---- */

  /**
   * Starts a search for the stored controller at another address, or joins the one under way. Resolves with whether
   * it was found and adopted. Nothing is searched without a stored serial number (there would be nothing to tell
   * the controller by), while pairing or forgetting, or once stopped.
   */
  #startSearch(): Promise<boolean> {
    if (this.#search) return this.#search.moved;
    const config = this.#config;
    const discover = this.#o.discover;
    if (!config || config.id === null || !discover || this.#stopped || this.#forgetting || this.#pairing > 0) {
      return Promise.resolve(false);
    }
    this.#searchedAt = this.#now();
    const abort = new AbortController();
    const signal = AbortSignal.any([this.#stop.signal, abort.signal]);
    const moved = this.#searchFor(config, config.id, discover, signal)
      .catch((error: unknown) => {
        if (!signal.aborted) this.#o.log.warn("Searching for the controller failed", error);
        return false;
      })
      .finally(() => {
        if (this.#search?.abort === abort) this.#search = null;
      });
    this.#search = { abort, moved };
    return moved;
  }

  /** Ends the search under way, if any: its requests abort and it adopts nothing. */
  #cancelSearch(): void {
    const search = this.#search;
    this.#search = null;
    search?.abort.abort();
  }

  /**
   * Looks for the stored controller at another address: runs discovery, then asks each address it found (other than
   * the stored one) for `info()` with the stored token. Only an address that passes the host check, accepts the
   * token and reports the stored serial number is adopted: storage `controller` gets its host and port and the
   * connection carries on there. Discovery's own `id` is a device id, not the serial number, so it decides nothing.
   * A controller with another serial is never adopted, even if it took the token. Adopts nothing once `signal`
   * aborted, the stored controller changed, or it answered at its old address after all.
   */
  async #searchFor(
    config: ControllerConfig,
    serial: string,
    discover: (signal: AbortSignal) => Promise<readonly FoundController[]>,
    signal: AbortSignal,
  ): Promise<boolean> {
    const over = () =>
      signal.aborted ||
      this.#stopped ||
      this.#forgetting ||
      this.#pairing > 0 ||
      this.#config !== config ||
      (this.#core.status !== "unreachable" && this.#core.status !== "connecting");
    const found = await discover(signal);
    const tried = new Set<string>([`${config.host}\n${config.port}`]);
    for (const { host, port } of found) {
      if (over()) return false;
      const key = `${host}\n${port}`;
      if (tried.has(key)) continue;
      if (tried.size > SEARCH_CANDIDATES) break;
      tried.add(key);
      let info: NanoleafInfo;
      try {
        await this.#o.checkHost?.(host, signal);
        info = await this.#o.createClient({ host, port, token: config.token }).info({ signal });
      } catch (error) {
        if (signal.aborted) return false;
        // Another controller (it refuses the token), or nothing the server should or can talk to.
        this.#o.log.info(`${host}:${port} isn't the paired controller`, error);
        continue;
      }
      if (over()) return false;
      if (info.serialNo !== serial) {
        this.#o.log.info(`${host}:${port} is another controller (${info.serialNo ?? "no serial number"})`);
        continue;
      }
      const moved: ControllerConfig = { ...config, host, port };
      this.#o.log.info(
        `Found ${config.name ?? serial} at ${host}:${port} (it was at ${config.host}:${config.port}); reconnecting`,
      );
      // As when pairing: the old link goes quiet first, then the new address and the connection show together.
      this.#generation++;
      this.#clearTimers();
      this.#dropEvents();
      this.#config = moved;
      this.#write(STORAGE_KEYS.controller, moved);
      this.#adopt(moved, info);
      return true;
    }
    return false;
  }

  /**
   * Checks the controller while connected (event stream down, or the Director saw an error). What the wall shows goes
   * to the Director too, since no event may have reported a change made meanwhile.
   */
  async #check(): Promise<void> {
    const config = this.#config;
    if (!config || this.#checking || this.#forgetting || this.#core.status !== "connected") return;
    const generation = this.#generation;
    this.#checking = true;
    try {
      const info = await this.#clientFor(config).info({ signal: this.#stop.signal });
      if (generation !== this.#generation || this.#stopped) return;
      this.#storeLayout(controllerIdOf(config, info), info.panelLayout);
      this.#o.onLayout();
      this.#o.onDeviceEvent({ effect: info.effects.select, on: info.state.on });
    } catch (error) {
      if (generation !== this.#generation || this.#stopped) return;
      this.#generation++;
      this.#clearTimers();
      this.#dropEvents();
      this.#failed(error);
    } finally {
      this.#checking = false;
    }
  }

  /* ---- Layout ---- */

  #layoutFor(controllerId: string | null): Layout | null {
    const layout = readLayout(this.#o.storage.get(STORAGE_KEYS.layout));
    return layout && layout.controllerId === controllerId ? layout : null;
  }

  /** Writes storage `layout` when the controller reports a different one. */
  #storeLayout(controllerId: string, data: PanelLayoutData): void {
    const layout = readLayout({
      controllerId,
      globalOrientation: data.globalOrientation,
      panels: data.positionData,
      fetchedAt: new Date(this.#now()).toISOString(),
    });
    if (!layout || sameLayout(readLayout(this.#o.storage.get(STORAGE_KEYS.layout)), layout)) return;
    this.#write(STORAGE_KEYS.layout, layout);
    this.#o.log.info(`Layout of ${controllerId}: ${countLightPanels(layout)} panels`);
  }

  async #rereadLayout(): Promise<void> {
    const config = this.#config;
    const controllerId = this.#controllerId;
    if (!config || controllerId === null || this.#forgetting) return;
    const generation = this.#generation;
    try {
      const data = await this.#clientFor(config).layout({ signal: this.#stop.signal });
      if (generation !== this.#generation || this.#stopped) return;
      this.#storeLayout(controllerId, data);
      this.#o.onLayout();
    } catch (error) {
      if (generation === this.#generation && !this.#stopped) this.#o.log.warn("Couldn't re-read the layout", error);
    }
  }

  /* ---- Events ---- */

  /** Opens the event stream, never once stopped: nothing would close it again. */
  #openEvents(config: ControllerConfig): void {
    this.#closeEvents();
    if (this.#stopped) return;
    const generation = this.#generation;
    const current = () => generation === this.#generation && !this.#stopped;
    this.#events = this.#o.openEvents({
      host: config.host,
      port: config.port,
      token: config.token,
      onEvent: (event) => {
        if (current()) this.#onEvent(event);
      },
      onStatus: (open) => {
        if (current()) this.#onEventsStatus(open);
      },
      log: (message, error) => (error === undefined ? this.#o.log.info(message) : this.#o.log.info(message, error)),
      now: this.#now,
    });
    this.#scheduleHealth();
  }

  /**
   * Closes the event stream and says nothing: for a caller whose next `#set` changes the status and says
   * `events: false` with it. Publishing the closing by itself would show the old status once more, with whatever
   * `#config` is by then.
   */
  #dropEvents(): void {
    const events = this.#events;
    this.#events = null;
    events?.close();
  }

  /** Closes the event stream and publishes that, for a caller that leaves the status as it is. */
  #closeEvents(): void {
    this.#dropEvents();
    if (this.#core.events) this.#set({ events: false });
  }

  #onEventsStatus(open: boolean): void {
    this.#set({ events: open });
    if (open) {
      if (this.#healthTimer !== null) this.#timers.clearTimeout(this.#healthTimer);
      this.#healthTimer = null;
      return;
    }
    void this.#check();
    this.#scheduleHealth();
  }

  /** Every `healthMs` while the event stream is down, check the controller. */
  #scheduleHealth(): void {
    if (this.#healthTimer !== null) this.#timers.clearTimeout(this.#healthTimer);
    this.#healthTimer = this.#timers.setTimeout(() => {
      this.#healthTimer = null;
      if (this.#stopped || this.#core.events || this.#core.status !== "connected") return;
      void this.#check();
      this.#scheduleHealth();
    }, this.#t.healthMs);
  }

  #onEvent(event: NanoleafEvent): void {
    if (event.id === STATE_EVENT) {
      const { on } = stateAttrs(event);
      if (on !== undefined) this.#o.onDeviceEvent({ on });
    } else if (event.id === EFFECTS_EVENT) {
      const effect = effectName(event);
      if (effect !== null) this.#o.onDeviceEvent({ effect });
    } else if (event.id === LAYOUT_EVENT) {
      void this.#rereadLayout();
    } else if (event.id === TOUCH_EVENT) {
      for (const touch of touches(event)) this.#o.onTouch(touch);
    }
  }

  /* ---- Plumbing ---- */

  #clientFor(config: ControllerConfig): ControllerClient {
    const key = `${config.host}\n${config.port}\n${config.token}`;
    if (this.#client?.key !== key) {
      this.#client = {
        key,
        client: this.#o.createClient({ host: config.host, port: config.port, token: config.token }),
      };
    }
    return this.#client.client;
  }

  #clearTimers(): void {
    if (this.#retryTimer !== null) this.#timers.clearTimeout(this.#retryTimer);
    if (this.#healthTimer !== null) this.#timers.clearTimeout(this.#healthTimer);
    this.#retryTimer = null;
    this.#healthTimer = null;
  }

  /** Throws once the instance stopped (nothing may be stored, adopted or opened after), or when `signal` aborted. */
  #live(signal?: AbortSignal): void {
    if (this.#stopped) throw new PluginError("stopped", STOPPED_MESSAGE);
    if (signal?.aborted) throw signal.reason;
  }

  #write(key: string, value: unknown): void {
    this.#o.storage.set(key, value).catch((error: unknown) => this.#o.log.warn(`Couldn't save ${key}`, error));
  }

  #sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        this.#timers.clearTimeout(handle);
        reject(signal.reason);
      };
      const handle = this.#timers.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Applies a change, publishes `connection` when it differs, and tells the Director when the link changed. */
  #set(patch: Partial<ConnectionCore>): void {
    const merged: ConnectionCore = { ...this.#core, ...patch };
    const config = this.#config;
    const next: ConnectionCore =
      merged.status === "unconfigured"
        ? { ...merged, host: null, port: null, events: false }
        : config
          ? { ...merged, host: config.host, port: config.port }
          : merged;
    const core = this.#core;
    const changed = (Object.keys(next) as (keyof ConnectionCore)[]).some((key) => next[key] !== core[key]);
    if (changed || !this.#published) {
      if (next.status !== core.status || !this.#published) this.#since = new Date(this.#now()).toISOString();
      this.#core = next;
      this.#published = true;
      try {
        this.#o.publish({ ...next, since: this.#since });
      } catch (error) {
        this.#o.log.error("Couldn't publish the connection state", error);
      }
    }
    const link: Link = {
      status: next.status,
      config: next.status === "unconfigured" ? null : this.#config,
      controllerId: next.status === "unconfigured" ? null : this.#controllerId,
      events: next.events,
    };
    const last = this.#link;
    if (
      !last ||
      last.status !== link.status ||
      last.config !== link.config ||
      last.controllerId !== link.controllerId ||
      last.events !== link.events
    ) {
      this.#link = link;
      this.#o.onLink(link);
    }
  }
}
