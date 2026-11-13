/**
 * Listens for the controller's UDP touch stream (nanoleaf-api.md §6). It binds a socket on an ephemeral port; the
 * events request then carries that port in `TouchEventsPort` (events.ts `touchEventsPort`), and the controller sends
 * touch packets here while that request stays open. Records go into a `TouchBuffer` with their arrival time, so a
 * swipe event (which has no panel) can be placed with `placeSwipe`. Whether a Shapes controller sends the stream
 * at all, and whether packets reach a hub in a container, is unverified (§11): `packets` and `lastPacketAt` tell a
 * caller whether anything was heard.
 *
 * One clock: arrival times come from `now()` (monotonic by default), so a caller must time a swipe event with the
 * stream's own `now()` (the default when it passes no time). A wall-clock step then can't hide or age out records.
 */
import { createSocket as createDgramSocket, type Socket } from "node:dgram";
import { decodeTouchPacket, SWIPE_GRACE_MS, TouchBuffer, type TimedTouch } from "../../../shared/touch.ts";
import { GLOBAL_TIMERS, type Timers } from "../ports.ts";

/** The socket family, the test seams, and the loggers. */
export interface TouchStreamOptions {
  /** "udp6" when the controller is reached over IPv6: it sends to the address the events request came from. */
  readonly type?: "udp4" | "udp6";
  /** Only packets from this address are read (others are counted in `ignored`). Default: any sender. */
  readonly source?: string;
  /** Makes the socket (tests inject one). Default: a `dgram` socket. It is bound to port 0 on every interface. */
  readonly createSocket?: (type: "udp4" | "udp6") => Socket;
  /** The clock for arrival times and swipe events. Default: `performance.now()` (monotonic). */
  readonly now?: () => number;
  /** Timers for `placeSwipe`'s grace (tests inject them). Default: the global timers. */
  readonly timers?: Pick<Timers, "setTimeout" | "clearTimeout">;
  /** Told once, when the first packet is read (from `source`): the stream has been heard. */
  readonly onHeard?: () => void;
  /** Told once the socket is bound, with its port. */
  readonly onListening?: (port: number) => void;
  /** Socket errors and failures; never per packet. */
  readonly log?: (message: string, error?: unknown) => void;
  /** Debug lines: binding, the first packet, malformed packets (the first and every 100th). */
  readonly debug?: (message: string) => void;
}

const LOG_EVERY = 100;

/** One controller's touch stream listener. Nothing it does throws; `close()` releases the socket. */
export class TouchStream {
  readonly #options: TouchStreamOptions;
  readonly #now: () => number;
  readonly #buffer = new TouchBuffer();
  readonly #bound: Promise<number | null>;
  #settle: (port: number | null) => void = () => {};
  #socket: Socket | null = null;
  #port: number | null = null;
  #closed = false;
  #packets = 0;
  #malformed = 0;
  #ignored = 0;
  #lastPacketAt: number | null = null;
  /** `placeSwipe` calls waiting out their grace: each timer handle and how to settle its call. */
  readonly #waiting = new Map<unknown, (panel: number | null) => void>();

  constructor(options: TouchStreamOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
    this.#bound = new Promise((resolve) => {
      this.#settle = resolve;
    });
    this.#open();
  }

  /** The bound port, or null before binding, after a failure, or after `close()`. */
  get port(): number | null {
    return this.#port;
  }

  /** Resolves with the port once bound, or null when binding failed or the stream closed first. */
  get bound(): Promise<number | null> {
    return this.#bound;
  }

  /** Packets read (malformed ones included, packets from another source not). */
  get packets(): number {
    return this.#packets;
  }

  /** Packets whose length didn't match their panel count; their whole records were still read. */
  get malformed(): number {
    return this.#malformed;
  }

  /** Packets from an address other than `source`. */
  get ignored(): number {
    return this.#ignored;
  }

  /** When the last packet was read (on `now()`'s clock), or null when none has been: the stream is silent. */
  get lastPacketAt(): number | null {
    return this.#lastPacketAt;
  }

  /** True after `close()`, or once the socket couldn't be made or bound. */
  get closed(): boolean {
    return this.#closed;
  }

  /** The stream's clock: time a swipe event with it, and compare `lastPacketAt` with it. */
  now(): number {
    return this.#now();
  }

  /** The records still in the placing window at `now`, oldest first. */
  recent(now: number = this.#now()): readonly TimedTouch[] {
    return this.#buffer.recent(now);
  }

  /**
   * Places a swipe event: the panel it started on, or null. Call it once per SSE swipe, as the event arrives.
   *
   * It notes the swipe's time on `now()` (or takes `options.now`, on the same clock) and takes at once. When that
   * finds nothing, the touch data may simply not have been read yet (the controller sends it before the SSE event,
   * but the receiver can be handed the SSE data first), so it waits `graceMs` (default `SWIPE_GRACE_MS`, 120 ms) and
   * takes again, now counting records that arrived up to the end of the grace. Either way, records up to the end of
   * the grace are used up by this swipe: those already there at once, and the rest (a late tail, such as the up)
   * when the grace ends. Two swipes inside one grace never hang or throw: the first to take gets what is there, the
   * other gets what is left (possibly null). A closed stream resolves null at once, and `close()` settles waiting
   * calls with null.
   */
  placeSwipe(
    panelIds: Iterable<number>,
    options: { readonly now?: number; readonly graceMs?: number } = {},
  ): Promise<number | null> {
    if (this.#closed) return Promise.resolve(null);
    const swipeAt = options.now ?? this.#now();
    const graceMs = options.graceMs ?? SWIPE_GRACE_MS;
    const wall = new Set(panelIds);
    const placed = this.#buffer.takeSwipePanel(swipeAt, wall);
    return new Promise((resolve) => {
      if (placed !== null) resolve(placed);
      const timers = this.#options.timers ?? GLOBAL_TIMERS;
      const handle = timers.setTimeout(() => {
        this.#waiting.delete(handle);
        const late = this.#closed ? null : this.#buffer.takeSwipePanel(swipeAt, wall, graceMs);
        resolve(placed ?? late);
      }, graceMs);
      this.#waiting.set(handle, (panel) => {
        timers.clearTimeout(handle);
        resolve(placed ?? panel);
      });
    });
  }

  /**
   * The panel a swipe event that arrived at `now` (default: this moment, on `now()`) started on, by the shared rule
   * (shared/touch.ts `swipePanel`), and uses up every record at or before `now`, so the next swipe can't be placed by
   * this one's touches. Call it once per swipe event.
   */
  takeSwipePanel(panelIds: Iterable<number>, now: number = this.#now()): number | null {
    return this.#buffer.takeSwipePanel(now, panelIds);
  }

  /** Like `takeSwipePanel`, but uses nothing up: a peek, for logs. */
  swipePanel(panelIds: Iterable<number>, now: number = this.#now()): number | null {
    return this.#buffer.swipePanel(now, panelIds);
  }

  /** Closes the socket. Safe to call twice. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#port = null;
    this.#settle(null);
    this.#buffer.clear();
    for (const settle of [...this.#waiting.values()]) settle(null);
    this.#waiting.clear();
    const socket = this.#socket;
    this.#socket = null;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }

  #open(): void {
    const type = this.#options.type ?? "udp4";
    let socket: Socket;
    try {
      socket = (this.#options.createSocket ?? ((kind) => createDgramSocket(kind)))(type);
    } catch (error) {
      this.#fail("Couldn't make a socket for the touch stream", error);
      this.close();
      return;
    }
    this.#socket = socket;
    socket.on("error", (error) => this.#fail("The touch stream's socket failed", error));
    socket.on("message", (message: Uint8Array, rinfo: { address: string }) => this.#message(message, rinfo));
    socket.once("listening", () => {
      if (this.#closed) return;
      let port: number;
      try {
        port = socket.address().port;
      } catch (error) {
        this.#fail("Couldn't read the touch stream's port", error);
        return;
      }
      this.#port = port;
      this.#options.debug?.(`Touch stream listening on UDP ${port}`);
      this.#settle(port);
      try {
        this.#options.onListening?.(port);
      } catch (error) {
        this.#options.log?.("The touch stream's listening handler failed", error);
      }
    });
    try {
      socket.bind(0);
      socket.unref();
    } catch (error) {
      this.#fail("Couldn't bind the touch stream's socket", error);
    }
  }

  #message(message: Uint8Array, rinfo: { address: string }): void {
    if (this.#closed) return;
    const source = this.#options.source;
    if (source !== undefined && unmapped(rinfo.address) !== unmapped(source)) {
      this.#ignored++;
      return;
    }
    const at = this.#now();
    const packet = decodeTouchPacket(message);
    this.#packets++;
    this.#lastPacketAt = at;
    if (this.#packets === 1) {
      this.#options.debug?.(`Touch stream: first packet from ${rinfo.address}`);
      try {
        this.#options.onHeard?.();
      } catch (error) {
        this.#options.log?.("The touch stream's heard handler failed", error);
      }
    }
    if (packet.malformed) {
      this.#malformed++;
      if (this.#malformed === 1 || this.#malformed % LOG_EVERY === 0) {
        const size = `a ${message.length}-byte packet doesn't match its count of ${packet.count}`;
        this.#options.debug?.(`Touch stream: ${size} (${this.#malformed} so far)`);
      }
    }
    this.#buffer.push(packet.records, at);
  }

  /** Logs a failure. Before the socket is bound, it also closes the stream: nothing is left open when `bound` is null. */
  #fail(message: string, error: unknown): void {
    if (this.#closed) return;
    this.#options.log?.(message, error);
    if (this.#port === null) this.close();
  }
}

/** An IPv4-mapped IPv6 address as plain IPv4, so a udp6 socket's senders compare with an IPv4 `source`. */
function unmapped(address: string): string {
  const lower = address.toLowerCase();
  return lower.startsWith("::ffff:") && lower.includes(".") ? lower.slice(7) : lower;
}
