/**
 * The controller's event stream (nanoleaf-api.md §6): `GET /api/v1/<token>/events?id=…` held open, parsed as SSE and
 * reopened with backoff. It uses node:http, not fetch: undici's body timeout would kill a stream that stays quiet.
 */
import { request, type ClientRequest } from "node:http";
import { API_PORT } from "../../../shared/protocol.ts";
import type { RawPanel, TouchGesture } from "../../../shared/types.ts";
import { NanoleafError, parsePositionData } from "./http.ts";

/** Event types: 1 state, 2 layout, 3 effects, 4 touch (the doc's prose calls touch 3; its table is right). */
export type NanoleafEventId = 1 | 2 | 3 | 4;

/** The event type ids, by name. */
export const STATE_EVENT = 1;
export const LAYOUT_EVENT = 2;
export const EFFECTS_EVENT = 3;
export const TOUCH_EVENT = 4;

/** One SSE message from the controller: its type id and the `events` array of its JSON. */
export interface NanoleafEvent {
  readonly id: NanoleafEventId;
  readonly events: readonly unknown[];
}

/** A raw SSE message: the last `id:` seen (per the SSE spec it persists), the event type and the joined data lines. */
export interface SseMessage {
  readonly id: string | null;
  readonly event: string;
  readonly data: string;
}

/** Where to subscribe, what to deliver where, and how to back off. */
export interface EventStreamOptions {
  readonly host: string;
  readonly port?: number;
  readonly token: string;
  /** Event types to subscribe to. Default: all four. */
  readonly ids?: readonly NanoleafEventId[];
  readonly onEvent: (event: NanoleafEvent) => void;
  /** Called when the stream opens or drops (not on `close()`); a drop carries its error, or null for a clean end. */
  readonly onStatus?: (open: boolean, error: NanoleafError | null) => void;
  readonly log?: (message: string, error?: unknown) => void;
  /** Waits before each reconnect; the last repeats. Default: 1, 2, 5, 10, 20 and 30 s. */
  readonly backoffMs?: readonly number[];
  /** A stream that stayed open this long starts the backoff again from the first step. Default: 60 s. */
  readonly resetAfterMs?: number;
  /** How long to wait for the answer's headers. Default: 5 s. */
  readonly connectTimeoutMs?: number;
  readonly now?: () => number;
}

const DEFAULT_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000, 20_000, 30_000];
const ALL_EVENTS: readonly NanoleafEventId[] = [1, 2, 3, 4];
/** TCP keep-alive: the controller may send nothing for hours, and a dead peer must still be noticed. */
const KEEPALIVE_MS = 15_000;
/** A line longer than this without a line break is garbage; it is dropped rather than buffered forever. */
const MAX_LINE = 1 << 20;

/**
 * A long-lived subscription to a controller's events. It connects as soon as it is made and keeps reconnecting until
 * `close()`. Handler errors are logged, never thrown into the socket.
 */
export class EventStream {
  readonly #options: EventStreamOptions;
  readonly #backoffMs: readonly number[];
  readonly #now: () => number;
  #request: ClientRequest | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #generation = 0;
  #open = false;
  #closed = false;
  #openedAt = 0;
  #failures = 0;

  constructor(options: EventStreamOptions) {
    this.#options = options;
    this.#backoffMs = options.backoffMs?.length ? options.backoffMs : DEFAULT_BACKOFF_MS;
    this.#now = options.now ?? Date.now;
    this.#connect();
  }

  /** Whether the stream is open right now. */
  get isOpen(): boolean {
    return this.#open;
  }

  /** Stops for good: aborts the connection and any pending reconnect. No callbacks run afterwards. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#open = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const pending = this.#request;
    this.#request = null;
    pending?.destroy();
  }

  #connect(): void {
    this.#timer = null;
    if (this.#closed) return;
    const generation = ++this.#generation;
    const { host, port = API_PORT, token, ids = ALL_EVENTS, connectTimeoutMs = 5000 } = this.#options;
    const where = `the controller at ${host}:${port}`;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let req: ClientRequest | null = null;
    let settled = false;
    const finish = (error: NanoleafError | null) => {
      if (settled || generation !== this.#generation) return;
      settled = true;
      clearTimeout(connectTimer);
      if (this.#request === req) this.#request = null;
      req?.destroy();
      this.#dropped(error);
    };
    try {
      req = request({
        hostname: host.startsWith("[") ? host.slice(1, -1) : host,
        port,
        path: `/api/v1/${encodeURIComponent(token)}/events?id=${ids.join(",")}`,
        method: "GET",
        headers: { Accept: "text/event-stream" },
        agent: false,
      });
    } catch (error) {
      finish(new NanoleafError("unreachable", `Can't open events from ${where}`, null, { cause: error }));
      return;
    }
    this.#request = req;
    connectTimer = setTimeout(() => {
      finish(new NanoleafError("timeout", `No answer from ${where} within ${connectTimeoutMs} ms`));
    }, connectTimeoutMs);
    req.on("socket", (socket) => socket.setKeepAlive(true, KEEPALIVE_MS));
    req.on("error", (error: NodeJS.ErrnoException) => {
      const reason = error.code ?? error.message;
      finish(new NanoleafError("unreachable", `Lost events from ${where} (${reason})`, null, { cause: error }));
    });
    req.on("response", (res) => {
      clearTimeout(connectTimer);
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        res.resume();
        const kind = status === 401 ? "unauthorized" : status >= 500 ? "server" : "rejected";
        finish(new NanoleafError(kind, `${capitalise(where)} answered ${status} to the event stream`, status));
        return;
      }
      const parser = new SseParser((message) => {
        if (generation === this.#generation && !this.#closed) this.#message(message);
      });
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => parser.push(chunk));
      res.on("end", () => finish(null));
      res.on("close", () => finish(null));
      res.on("error", (error) => {
        finish(new NanoleafError("unreachable", `Lost events from ${where}`, null, { cause: error }));
      });
      this.#opened();
    });
    req.end();
  }

  #opened(): void {
    this.#open = true;
    this.#openedAt = this.#now();
    this.#status(true, null);
  }

  #dropped(error: NanoleafError | null): void {
    if (this.#closed) return;
    const wasOpen = this.#open;
    this.#open = false;
    if (wasOpen && this.#now() - this.#openedAt >= (this.#options.resetAfterMs ?? 60_000)) this.#failures = 0;
    const delay = this.#backoffMs[Math.min(this.#failures, this.#backoffMs.length - 1)] ?? 1000;
    this.#failures++;
    if (wasOpen) this.#status(false, error);
    this.#options.log?.(`Event stream ${wasOpen ? "closed" : "didn't open"}; retrying in ${delay} ms`, error);
    if (!this.#closed) this.#timer = setTimeout(() => this.#connect(), delay);
  }

  #status(open: boolean, error: NanoleafError | null): void {
    try {
      this.#options.onStatus?.(open, error);
    } catch (failure) {
      this.#options.log?.("The event stream's status handler failed", failure);
    }
  }

  #message(message: SseMessage): void {
    const id = Number(message.id);
    if (id !== 1 && id !== 2 && id !== 3 && id !== 4) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch (error) {
      this.#options.log?.(`Ignored an event ${id} that isn't JSON`, error);
      return;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.events)) {
      this.#options.log?.(`Ignored an event ${id} without an events array`);
      return;
    }
    try {
      this.#options.onEvent({ id, events: parsed.events });
    } catch (error) {
      this.#options.log?.("An event handler failed", error);
    }
  }
}

/**
 * An incremental text/event-stream parser (the WHATWG rules): CRLF, LF or CR line ends, even split across chunks;
 * `:` comments and keep-alives; several `data:` lines joined with "\n"; a blank line dispatches.
 */
export class SseParser {
  readonly #onMessage: (message: SseMessage) => void;
  #buffer = "";
  #data = "";
  #event = "";
  #lastId: string | null = null;
  #skipLf = false;
  #started = false;

  constructor(onMessage: (message: SseMessage) => void) {
    this.#onMessage = onMessage;
  }

  /** Feeds decoded text; complete messages are dispatched before it returns. */
  push(chunk: string): void {
    let text = chunk;
    if (!this.#started && text !== "") {
      this.#started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (this.#skipLf && text !== "") {
      this.#skipLf = false;
      if (text.charCodeAt(0) === 10) text = text.slice(1);
    }
    const buffer = this.#buffer + text;
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const code = buffer.charCodeAt(i);
      if (code !== 10 && code !== 13) continue;
      const line = buffer.slice(start, i);
      if (code === 13) {
        if (i + 1 === buffer.length) this.#skipLf = true;
        else if (buffer.charCodeAt(i + 1) === 10) i++;
      }
      start = i + 1;
      this.#line(line);
    }
    this.#buffer = buffer.slice(start);
    if (this.#buffer.length > MAX_LINE) this.#buffer = "";
  }

  /** The stream ended: an unfinished message is discarded, as the spec says. */
  end(): void {
    this.#buffer = "";
    this.#data = "";
    this.#event = "";
  }

  #line(line: string): void {
    if (line === "") {
      this.#dispatch();
      return;
    }
    if (line.charCodeAt(0) === 58) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === "data") this.#data += `${value}\n`;
    else if (field === "id" && !value.includes("\0")) this.#lastId = value;
    else if (field === "event") this.#event = value;
  }

  #dispatch(): void {
    const data = this.#data;
    const event = this.#event || "message";
    this.#data = "";
    this.#event = "";
    if (data === "") return;
    this.#onMessage({ id: this.#lastId, event, data: data.slice(0, -1) });
  }
}

/* ---- Typed helpers ---- */

/** State event (1) attributes: 1 on, 2 brightness, 3 hue, 4 sat, 5 ct, 6 colorMode. Only those present are set. */
export interface StateAttrs {
  readonly on?: boolean;
  readonly brightness?: number;
  readonly hue?: number;
  readonly sat?: number;
  readonly ct?: number;
  readonly colorMode?: "effect" | "hs" | "ct";
}

/** Layout event (2): the new `positionData` (attr 1) and/or global orientation (attr 2); null when not sent. */
export interface LayoutChange {
  readonly positionData: readonly RawPanel[] | null;
  readonly globalOrientation: number | null;
}

/** A touch (event 4) on a panel; swipes aren't tied to one, so their `panelId` is -1. */
export interface Touch {
  readonly panelId: number;
  readonly gesture: TouchGesture;
}

/** Gesture ids 0–5 in order. */
export const TOUCH_GESTURES: readonly TouchGesture[] = [
  "tap",
  "double-tap",
  "swipe-up",
  "swipe-down",
  "swipe-left",
  "swipe-right",
];

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The state attributes a state event carries (later entries win); empty for other events. */
export function stateAttrs(event: NanoleafEvent): StateAttrs {
  const attrs: Mutable<StateAttrs> = {};
  if (event.id !== STATE_EVENT) return attrs;
  for (const entry of event.events) {
    if (!isRecord(entry)) continue;
    const value = entry.value;
    if (entry.attr === 1 && typeof value === "boolean") attrs.on = value;
    else if (entry.attr === 2 && finite(value)) attrs.brightness = value;
    else if (entry.attr === 3 && finite(value)) attrs.hue = value;
    else if (entry.attr === 4 && finite(value)) attrs.sat = value;
    else if (entry.attr === 5 && finite(value)) attrs.ct = value;
    else if (entry.attr === 6 && (value === "effect" || value === "hs" || value === "ct")) attrs.colorMode = value;
  }
  return attrs;
}

/** What a layout event changed; null for other events. */
export function layoutChange(event: NanoleafEvent): LayoutChange | null {
  if (event.id !== LAYOUT_EVENT) return null;
  let positionData: RawPanel[] | null = null;
  let globalOrientation: number | null = null;
  for (const entry of event.events) {
    if (!isRecord(entry)) continue;
    if (entry.attr === 1 && isRecord(entry.value)) positionData = parsePositionData(entry.value.positionData);
    else if (entry.attr === 2 && finite(entry.value)) globalOrientation = entry.value;
    else if (entry.attr === 2 && isRecord(entry.value) && finite(entry.value.value)) {
      globalOrientation = entry.value.value;
    }
  }
  return { positionData, globalOrientation };
}

/** The effect an effects event (3) switched to, for example "Flames" or "*Static*"; null for other events. */
export function effectName(event: NanoleafEvent): string | null {
  if (event.id !== EFFECTS_EVENT) return null;
  let name: string | null = null;
  for (const entry of event.events) {
    if (isRecord(entry) && entry.attr === 1 && typeof entry.value === "string") name = entry.value;
  }
  return name;
}

/** The touches a touch event (4) reports, in order; unknown gestures are skipped. */
export function touches(event: NanoleafEvent): Touch[] {
  if (event.id !== TOUCH_EVENT) return [];
  const found: Touch[] = [];
  for (const entry of event.events) {
    if (!isRecord(entry) || typeof entry.gesture !== "number") continue;
    const gesture = TOUCH_GESTURES[entry.gesture];
    const panelId = entry.panelId;
    if (gesture === undefined) continue;
    found.push({ panelId: typeof panelId === "number" && Number.isInteger(panelId) ? panelId : -1, gesture });
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
