/**
 * REST client for a controller's local OpenAPI (nanoleaf-api.md §2 and §3). Requests to one controller run one at a
 * time, GETs and idempotent PUTs retry briefly, and every failure is a `NanoleafError` whose `kind` says what the
 * caller can do about it.
 */
import { isHostOnly } from "../../../shared/lan.ts";
import { API_PORT, EXT_CONTROL_V2_COMMAND } from "../../../shared/protocol.ts";
import type { RawPanel } from "../../../shared/types.ts";

/**
 * What went wrong. `unreachable`: no answer (refused, reset or unresolvable), or a host nothing could be sent to
 * (`refuseUnusable`). `unauthorized`: a bad token (401). `rejected`: any other 4xx, a refusal a retry won't change;
 * also a redirect, which is never followed (`attempt`). `server`: a 5xx, the controller failing on its side (busy or
 * rebooting), so a retry may work. `timeout`: no answer in time. See `isTransient`.
 */
export type NanoleafErrorKind = "unreachable" | "unauthorized" | "rejected" | "server" | "timeout";

/** A failed controller request. `status` is the HTTP status when the controller answered. */
export class NanoleafError extends Error {
  readonly kind: NanoleafErrorKind;
  readonly status: number | null;

  constructor(kind: NanoleafErrorKind, message: string, status: number | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = "NanoleafError";
    this.kind = kind;
    this.status = status;
  }
}

/** Whether a later attempt may succeed: the request may never have arrived (`unreachable`, `timeout`) or hit a 5xx. */
export function isTransient(error: unknown): boolean {
  if (!(error instanceof NanoleafError)) return false;
  return error.kind === "unreachable" || error.kind === "timeout" || error.kind === "server";
}

/** `GET /state`, normalised. Missing values fall back to on, 100% and null so a hand-back never turns a wall off. */
export interface NanoleafState {
  readonly on: boolean;
  /** 0–100. */
  readonly brightness: number;
  readonly hue: number | null;
  readonly sat: number | null;
  readonly ct: number | null;
  readonly colorMode: "effect" | "hs" | "ct" | null;
}

/** `GET /panelLayout`, normalised: every `positionData` entry (controller included) with `panelId` renamed `id`. */
export interface PanelLayoutData {
  /** Degrees, as reported. */
  readonly globalOrientation: number;
  readonly positionData: readonly RawPanel[];
}

/** `GET /` (everything the controller reports), normalised to what the plugin reads. */
export interface NanoleafInfo {
  readonly name: string | null;
  readonly serialNo: string | null;
  readonly manufacturer: string | null;
  readonly model: string | null;
  readonly firmwareVersion: string | null;
  readonly state: NanoleafState;
  readonly effects: { readonly select: string | null; readonly effectsList: readonly string[] };
  readonly panelLayout: PanelLayoutData;
}

type Adjust = { readonly value: number } | { readonly increment: number };

/** A `PUT /state` body. `duration` is in seconds. Numbers are rounded; `on` is always sent last. */
export interface StatePatch {
  readonly on?: { readonly value: boolean };
  readonly brightness?: { readonly value: number; readonly duration?: number } | { readonly increment: number };
  readonly hue?: Adjust;
  readonly sat?: Adjust;
  readonly ct?: Adjust;
}

/** Where the controller is, its token, and how patient to be. */
export interface NanoleafClientOptions {
  readonly host: string;
  readonly port?: number;
  /** The access token from pairing; methods other than the static ones throw `unauthorized` without it. */
  readonly token?: string | null;
  /** Per attempt, from when the request leaves the queue. */
  readonly timeoutMs?: number;
  /**
   * Waits before each retry of a GET or an idempotent PUT after a transient failure (`isTransient`). Default: twice,
   * after 250 ms and 750 ms. The retries keep the request's turn in the controller's queue.
   */
  readonly retryDelaysMs?: readonly number[];
}

/** Per-call options: a caller signal (its reason is rethrown on abort) and a timeout override. */
export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [250, 750];
const NO_RETRIES: readonly number[] = [];
/** `write` commands that set or read something, so sending one twice does no harm (not `delete` or `rename`). */
const IDEMPOTENT_WRITES: ReadonlySet<unknown> = new Set(["display", "displayTemp", "add", "request", "requestAll"]);

/**
 * A controller's REST API. Requests to one `host:port` are serialised across every client in the process (the
 * controller is a small device that drops requests under load); a request's timeout starts when its turn comes.
 */
export class NanoleafClient {
  readonly host: string;
  readonly port: number;
  readonly token: string | null;
  readonly timeoutMs: number;
  readonly #retryDelaysMs: readonly number[];

  constructor(options: NanoleafClientOptions) {
    this.host = options.host;
    this.port = options.port ?? API_PORT;
    this.token = options.token ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  /** `GET /api/v1/<token>/`: name, serial, model, firmware, state, effects and layout in one answer. */
  async info(options?: RequestOptions): Promise<NanoleafInfo> {
    return parseInfo(await this.#getJson("/", options));
  }

  /** `GET /panelLayout`: global orientation and every `positionData` entry. */
  async layout(options?: RequestOptions): Promise<PanelLayoutData> {
    return parsePanelLayout(await this.#getJson("/panelLayout", options));
  }

  /** `GET /state`: power, brightness and colour. */
  async state(options?: RequestOptions): Promise<NanoleafState> {
    return parseState(await this.#getJson("/state", options));
  }

  /** `GET /effects/select`: the current effect, for example "Northern Lights", "*Static*" or "*ExtControl*". */
  async select(options?: RequestOptions): Promise<string | null> {
    return parseEffectName((await this.#get("/effects/select", options)).text);
  }

  /**
   * `PUT /state`, with `on` last in the JSON (aionanoleaf: "on" must be the last key). Retried like a GET unless the
   * patch has an `increment`, which a second attempt would apply twice.
   */
  async setState(patch: StatePatch, options?: RequestOptions): Promise<void> {
    await this.#put("/state", stateBody(patch), !hasIncrement(patch), options);
  }

  /** `PUT /effects {select}`: switches to a saved effect, which also ends a static display or extControl. Retried. */
  async selectEffect(name: string, options?: RequestOptions): Promise<void> {
    await this.#put("/effects", JSON.stringify({ select: name }), true, options);
  }

  /**
   * `PUT /effects {write}`: the answer's JSON when there is one (a `request` returns the effect), its text when it
   * isn't JSON, else null. Any 2xx is success. Retried for `display`, `displayTemp`, `add`, `request`, `requestAll`.
   */
  async write(body: object, options?: RequestOptions): Promise<unknown> {
    const retry = IDEMPOTENT_WRITES.has((body as { command?: unknown }).command);
    const { text } = await this.#put("/effects", JSON.stringify({ write: body }), retry, options);
    if (text.trim() === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Switches to extControl v2 (UDP frames to port 60222). Throws `rejected` with the status when it isn't 2xx. */
  async enterExtControl(options?: RequestOptions): Promise<void> {
    await this.write(EXT_CONTROL_V2_COMMAND, options);
  }

  /**
   * Reads back the `*Static*` scene's animData so it can be redrawn later; null when the controller has none (a 4xx:
   * 404 without a static scene, 400 while a dynamic effect runs, §4). A 5xx or no answer throws instead, so a
   * transient failure never loses the user's static scene.
   */
  async requestStatic(options?: RequestOptions): Promise<string | null> {
    try {
      const answer = await this.write({ command: "request", animName: "*Static*" }, options);
      const animData = isRecord(answer) ? answer.animData : null;
      return typeof animData === "string" && animData.trim() !== "" ? animData : null;
    } catch (error) {
      if (error instanceof NanoleafError && error.kind === "rejected") return null;
      throw error;
    }
  }

  /** `PUT /identify`: flashes the whole wall (there is no per-panel identify). Never retried: one flash was asked. */
  async identify(options?: RequestOptions): Promise<void> {
    await this.#put("/identify", undefined, false, options);
  }

  /** `DELETE /api/v1/<token>`: revokes this client's token. Never retried. */
  async revoke(options?: RequestOptions): Promise<void> {
    const path = `/api/v1/${encodeURIComponent(this.#requireToken())}`;
    const to = this.#target();
    const request = { to, method: "DELETE", path, body: undefined, timeoutMs: this.#timeout(options) };
    check(await send({ ...request, signal: options?.signal }), to.where);
  }

  /** Whether anything answers HTTP at `host:port` (any status counts, except a redirect). Never retries. */
  static async probe(host: string, port = API_PORT, options?: RequestOptions): Promise<boolean> {
    try {
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const to = target(host, port);
      await send({ to, method: "GET", path: "/", body: undefined, timeoutMs, signal: options?.signal });
      return true;
    } catch (error) {
      if (error instanceof NanoleafError) return false;
      throw error;
    }
  }

  /**
   * `POST /api/v1/new`: the new token on 2xx, null on 401/403 (the pairing window isn't open). Throws `unreachable`,
   * `timeout`, `server` or `rejected` otherwise, and the signal's reason when the caller aborts. One attempt: the
   * caller polls.
   */
  static async requestToken(
    host: string,
    port = API_PORT,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<string | null> {
    const to = target(host, port);
    const path = "/api/v1/new";
    const { status, text } = await send({ to, method: "POST", path, body: undefined, timeoutMs, signal });
    if (status === 401 || status === 403) return null;
    check({ status, text }, to.where);
    const answer = parseJson(text, to.where, status);
    const token = isRecord(answer) ? answer.auth_token : null;
    if (typeof token !== "string" || token === "") {
      throw new NanoleafError("rejected", `${capitalise(to.where)} answered pairing without a token`, status);
    }
    return token;
  }

  #target(): Target {
    return target(this.host, this.port);
  }

  #where(): string {
    return this.#target().where;
  }

  #timeout(options?: RequestOptions): number {
    return options?.timeoutMs ?? this.timeoutMs;
  }

  #requireToken(): string {
    if (!this.token) throw new NanoleafError("unauthorized", "No access token: pair with the controller first");
    return this.token;
  }

  #path(path: string): string {
    return `/api/v1/${encodeURIComponent(this.#requireToken())}${path}`;
  }

  #get(path: string, options?: RequestOptions): Promise<Exchange> {
    return this.#checked("GET", path, undefined, true, options);
  }

  async #getJson(path: string, options?: RequestOptions): Promise<unknown> {
    const { status, text } = await this.#get(path, options);
    return parseJson(text, this.#where(), status);
  }

  /** A PUT; `retry` only when sending it twice is harmless (it sets absolute values, or reads). */
  #put(path: string, body: string | undefined, retry: boolean, options?: RequestOptions): Promise<Exchange> {
    return this.#checked("PUT", path, body, retry, options);
  }

  async #checked(
    method: string,
    path: string,
    body: string | undefined,
    retry: boolean,
    options?: RequestOptions,
  ): Promise<Exchange> {
    const request = { to: this.#target(), method, path: this.#path(path), body, timeoutMs: this.#timeout(options) };
    return sendChecked({ ...request, signal: options?.signal }, retry ? this.#retryDelaysMs : NO_RETRIES);
  }
}

/** Whether a patch changes something relative to its current value, so that sending it twice would apply it twice. */
function hasIncrement(patch: StatePatch): boolean {
  const fields = [patch.brightness, patch.hue, patch.sat, patch.ct];
  return fields.some((field) => field !== undefined && "increment" in field);
}

/** The `PUT /state` JSON for a patch: brightness, hue, sat, ct, then `on`; numbers rounded to integers. */
export function stateBody(patch: StatePatch): string {
  const body: Record<string, unknown> = {};
  for (const key of ["brightness", "hue", "sat", "ct"] as const) {
    const value = patch[key];
    if (value !== undefined) body[key] = roundFields(value);
  }
  if (patch.on !== undefined) body.on = { value: patch.on.value };
  return JSON.stringify(body);
}

/** Normalises `GET /` (or a fixture). Throws `rejected` when it isn't an object. */
export function parseInfo(raw: unknown): NanoleafInfo {
  if (!isRecord(raw)) throw new NanoleafError("rejected", "The controller's info isn't an object");
  const effects = isRecord(raw.effects) ? raw.effects : {};
  return {
    name: str(raw.name),
    serialNo: str(raw.serialNo),
    manufacturer: str(raw.manufacturer),
    model: str(raw.model),
    firmwareVersion: str(raw.firmwareVersion),
    state: parseState(raw.state),
    effects: {
      select: str(effects.select),
      effectsList: Array.isArray(effects.effectsList)
        ? effects.effectsList.filter((name): name is string => typeof name === "string")
        : [],
    },
    panelLayout: parsePanelLayout(raw.panelLayout),
  };
}

/** Normalises `GET /state` or `info().state`. */
export function parseState(raw: unknown): NanoleafState {
  const state = isRecord(raw) ? raw : {};
  const on = valueOf(state.on);
  const mode = valueOf(state.colorMode);
  return {
    on: typeof on === "boolean" ? on : true,
    brightness: numberOr(valueOf(state.brightness), 100),
    hue: numberOr(valueOf(state.hue), null),
    sat: numberOr(valueOf(state.sat), null),
    ct: numberOr(valueOf(state.ct), null),
    colorMode: mode === "effect" || mode === "hs" || mode === "ct" ? mode : null,
  };
}

/** Normalises `GET /panelLayout` (`{layout, globalOrientation}`). */
export function parsePanelLayout(raw: unknown): PanelLayoutData {
  const layout = isRecord(raw) ? raw : {};
  return {
    globalOrientation: numberOr(valueOf(layout.globalOrientation), 0),
    positionData: parsePositionData(isRecord(layout.layout) ? layout.layout.positionData : null),
  };
}

/** `positionData` entries as `RawPanel`s; entries without a numeric id, x and y are dropped, a missing type is -1. */
export function parsePositionData(raw: unknown): RawPanel[] {
  if (!Array.isArray(raw)) return [];
  const panels: RawPanel[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = entry.panelId;
    if (typeof id !== "number" || !Number.isInteger(id) || !finite(entry.x) || !finite(entry.y)) continue;
    panels.push({
      id,
      x: entry.x,
      y: entry.y,
      o: numberOr(entry.o, 0),
      shapeType: numberOr(entry.shapeType, -1),
    });
  }
  return panels;
}

/** An effect name from `GET /effects/select`: a JSON string, or bare text from older firmware. */
export function parseEffectName(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed === "") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return trimmed;
  }
}

/* ---- Transport ---- */

interface Target {
  readonly host: string;
  readonly port: number;
  readonly key: string;
  /** For messages: "the controller at 192.168.1.40:16021". */
  readonly where: string;
}

interface Exchange {
  readonly status: number;
  readonly text: string;
}

/** One HTTP request to a controller; the timeout is per attempt and covers the answer and its body. */
interface Outgoing {
  readonly to: Target;
  readonly method: string;
  readonly path: string;
  readonly body: string | undefined;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
}

function target(host: string, port: number): Target {
  return { host, port, key: `${host.toLowerCase()}:${port}`, where: `the controller at ${host}:${port}` };
}

/** One attempt in the controller's queue, its status unchecked. */
async function send(request: Outgoing): Promise<Exchange> {
  refuseUnusable(request.to);
  const release = await acquireLane(request.to.key, request.signal);
  try {
    return await attempt(request);
  } finally {
    release();
  }
}

/**
 * A checked request, tried again after each of `delaysMs` while it fails transiently. The retries keep the request's
 * turn in the queue, so a retried PUT can never land after a request made later.
 */
async function sendChecked(request: Outgoing, delaysMs: readonly number[]): Promise<Exchange> {
  refuseUnusable(request.to);
  const release = await acquireLane(request.to.key, request.signal);
  try {
    for (let n = 0; ; n++) {
      try {
        return check(await attempt(request), request.to.where);
      } catch (error) {
        const delay = delaysMs[n];
        if (delay === undefined || !isTransient(error)) throw error;
        await sleep(delay, request.signal);
      }
    }
  } finally {
    release();
  }
}

/**
 * Throws before a request queues or retries, for a host no attempt could reach, or could reach somewhere else:
 * - one with an IPv6 zone: WHATWG URLs (so fetch) can't carry one, and a link-local address is useless without it;
 * - one that is more than a host (`10.0.0.2/setup?`, `10.0.0.2:80`, `user@10.0.0.2`): in `http://<host>:<port>/…` it
 *   would choose the path, the port or a login. The Controller's host check refuses these before anything connects
 *   (lan.ts); this is for a host that gets here some other way.
 */
function refuseUnusable(to: Target): void {
  if (to.host.includes("%")) {
    throw new NanoleafError("unreachable", `Can't reach ${to.where}: link-local IPv6 addresses aren't supported`);
  }
  // An IPv6 address may come in brackets, as `attempt` puts it in the URL.
  const host = /^\[(.*:.*)\]$/.exec(to.host)?.[1] ?? to.host;
  if (!isHostOnly(host)) {
    throw new NanoleafError("unreachable", `Can't reach ${to.where}: that isn't an IP address or host name`);
  }
}

/** The statuses `fetch` would follow to the answer's `Location`. */
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * One HTTP exchange (the caller holds the controller's turn). A redirect is never followed, and fails as `rejected`:
 * a controller doesn't send one, and following it would take the request (a 307 or 308 keeps its method and body)
 * from the host the plugin was given to wherever that host says, past the host check (lan.ts). The host is only a
 * host by now (`refuseUnusable`), so the URL goes to it, at `to.port`.
 */
async function attempt({ to, method, path, body, timeoutMs, signal }: Outgoing): Promise<Exchange> {
  const timer = new AbortController();
  const handle = setTimeout(() => timer.abort(), timeoutMs);
  const host = to.host.includes(":") && !to.host.startsWith("[") ? `[${to.host}]` : to.host;
  try {
    const response = await fetch(`http://${host}:${to.port}${path}`, {
      method,
      body,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      redirect: "manual",
      signal: signal ? AbortSignal.any([timer.signal, signal]) : timer.signal,
    });
    // Node hands back the 3xx answer itself; a runtime that follows the standard gives an opaque one, status 0.
    if (response.type === "opaqueredirect" || REDIRECTS.has(response.status)) {
      void response.body?.cancel().catch(() => undefined);
      throw new NanoleafError(
        "rejected",
        `${capitalise(to.where)} answered with a redirect, which a Nanoleaf controller never does`,
        response.status || null,
      );
    }
    return { status: response.status, text: await response.text() };
  } catch (error) {
    if (error instanceof NanoleafError) throw error;
    if (signal?.aborted) throw signal.reason;
    if (timer.signal.aborted) throw new NanoleafError("timeout", `No answer from ${to.where} within ${timeoutMs} ms`);
    throw new NanoleafError("unreachable", `Can't reach ${to.where} (${describe(error)})`, null, { cause: error });
  } finally {
    clearTimeout(handle);
  }
}

/** 2xx passes; 401 is `unauthorized`, 5xx `server` (transient), any other status `rejected`. */
function check(result: Exchange, where: string): Exchange {
  if (result.status >= 200 && result.status < 300) return result;
  if (result.status === 401) {
    throw new NanoleafError("unauthorized", `${capitalise(where)} refused the access token`, 401);
  }
  const kind = result.status >= 500 ? "server" : "rejected";
  throw new NanoleafError(kind, `${capitalise(where)} answered ${result.status}`, result.status);
}

interface Lane {
  busy: boolean;
  readonly waiters: (() => void)[];
}

/** One queue per controller, shared by every client and instance in the process (like claims.ts). */
const lanes = new Map<string, Lane>();

/** Waits for the controller's turn; resolves with the release function, or rejects with the signal's reason. */
function acquireLane(key: string, signal: AbortSignal | undefined): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let lane = lanes.get(key);
    if (!lane) {
      lane = { busy: false, waiters: [] };
      lanes.set(key, lane);
    }
    const current = lane;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = current.waiters.shift();
      if (next) next();
      else {
        current.busy = false;
        if (lanes.get(key) === current) lanes.delete(key);
      }
    };
    if (!current.busy) {
      current.busy = true;
      resolve(release);
      return;
    }
    const onAbort = () => {
      const index = current.waiters.indexOf(wake);
      if (index >= 0) current.waiters.splice(index, 1);
      reject(signal?.reason);
    };
    const wake = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve(release);
    };
    current.waiters.push(wake);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(handle);
      reject(signal?.reason);
    };
    const handle = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/* ---- Small readers ---- */

function parseJson(body: string, where: string, status: number): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new NanoleafError("rejected", `${capitalise(where)} sent an answer that isn't JSON`, status);
  }
}

function roundFields(value: object): Record<string, number> {
  const rounded: Record<string, number> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "number" && Number.isFinite(field)) rounded[key] = Math.round(field);
  }
  return rounded;
}

function describe(error: unknown): string {
  const cause = error instanceof Error ? error.cause : null;
  if (isRecord(cause) && typeof cause.code === "string") return cause.code;
  if (cause instanceof Error) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{value}` objects (state, globalOrientation) or a bare value. */
function valueOf(field: unknown): unknown {
  return isRecord(field) ? field.value : field;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOr<T extends number | null>(value: unknown, fallback: T): number | T {
  return finite(value) ? value : fallback;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
