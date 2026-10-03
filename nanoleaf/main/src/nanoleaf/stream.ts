/**
 * Streams extControl v2 frames to a controller over UDP (nanoleaf-api.md §5). The socket is unconnected, so an ICMP
 * "port unreachable" from before the controller opened port 60222 can't turn into ECONNREFUSED on every later send.
 * A host name is resolved once, not per frame: a `dgram` send to a name runs getaddrinfo on libuv's small shared
 * pool, where a slow resolver would stall every DNS lookup in the plugin host. It is resolved again only after a
 * failure, at most once per `resolveRetryMs`.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { createSocket as createDgramSocket, type Socket } from "node:dgram";
import { isIP } from "node:net";
import { encodeExtControlV2, EXT_CONTROL_PORT, type PanelRgb } from "../../../shared/protocol.ts";

/** One address a host name resolved to (what `dns.lookup(host, { all: true })` gives). */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** The UDP port (60222 unless an emulator says otherwise), test seams, a logger and a failure callback. */
export interface ExtControlStreamOptions {
  readonly port?: number;
  /** Makes the socket for the address's family (tests inject one). Default: a `dgram` socket, ephemeral port. */
  readonly createSocket?: (type: "udp4" | "udp6") => Socket;
  /** Resolves a host name. Default: `dns.lookup(host, { all: true })`. IP addresses are never looked up. */
  readonly lookup?: (host: string) => Promise<readonly ResolvedAddress[]>;
  /** The least time between two lookups of a name, after a failed lookup or a failed send. Default: 5 s. */
  readonly resolveRetryMs?: number;
  readonly now?: () => number;
  /** Told about the first send error and every 100th after it: a dead controller at 10 Hz would flood the log. */
  readonly log?: (message: string, error: unknown) => void;
  /** Told when frames start failing (the first error since creation or since a frame last went out). */
  readonly onError?: (error: unknown) => void;
}

const LOG_EVERY = 100;
const DEFAULT_RESOLVE_RETRY_MS = 5000;

/**
 * One controller's frame sink. `send` never throws; `close` releases the socket (the host never closes it for us).
 * `host` is an IPv4 address, an IPv6 address (bare or in brackets; it streams over udp6) or a host name.
 */
export class ExtControlStream {
  readonly host: string;
  readonly port: number;
  readonly #options: ExtControlStreamOptions;
  readonly #name: string | null;
  #target: ResolvedAddress | null = null;
  #socket: Socket | null = null;
  #socketType: "udp4" | "udp6" | null = null;
  #closed = false;
  #resolving = false;
  #lastLookup = -Infinity;
  /** A send to a resolved name failed: look it up again (the controller may have a new address). */
  #stale = false;
  #failing = false;
  #sent = 0;
  #errors = 0;

  constructor(host: string, options: ExtControlStreamOptions = {}) {
    this.host = host;
    this.port = options.port ?? EXT_CONTROL_PORT;
    this.#options = options;
    const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    const family = isIP(bare);
    this.#name = family === 0 ? bare : null;
    if (family !== 0) this.#aim({ address: bare, family });
    else this.#resolve();
  }

  /** Frames handed to the socket. */
  get sent(): number {
    return this.#sent;
  }

  /** Frames that failed to encode or send, failed lookups, plus socket errors. */
  get errors(): number {
    return this.#errors;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The address frames go to: the host itself when it is an IP address, else what it resolved to (null: not yet). */
  get address(): string | null {
    return this.#target?.address ?? null;
  }

  /**
   * Sends one frame: each panel's colour with `transitionDs` (100 ms units) unless the entry carries its own. Only
   * send ids from the current layout: the controller drops a whole frame that names an unknown panel. Returns whether
   * the frame reached the socket; it doesn't while a host name has no address yet (frames are dropped, never queued).
   * Failures are counted and logged instead of thrown.
   */
  send(lights: Iterable<PanelRgb>, transitionDs = 1): boolean {
    if (this.#closed) return false;
    let packet: Uint8Array;
    try {
      packet = encodeExtControlV2(lights, transitionDs);
    } catch (error) {
      this.#fail(error);
      return false;
    }
    if (this.#stale) this.#resolve();
    const target = this.#target;
    const socket = this.#socket;
    if (!target || !socket) {
      this.#resolve();
      return false;
    }
    try {
      socket.send(packet, this.port, target.address, (error) => {
        if (error) this.#sendFailed(error);
        else this.#failing = false;
      });
    } catch (error) {
      this.#sendFailed(error);
      return false;
    }
    this.#sent++;
    return true;
  }

  /** Closes the socket. Safe to call twice; later sends return false. It doesn't take the wall out of extControl. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeSocket();
  }

  /** Looks the name up unless a lookup is in flight or the last one was too recent. IP hosts never resolve. */
  #resolve(): void {
    const name = this.#name;
    if (name === null || this.#resolving || this.#closed) return;
    const now = (this.#options.now ?? Date.now)();
    if (now - this.#lastLookup < (this.#options.resolveRetryMs ?? DEFAULT_RESOLVE_RETRY_MS)) return;
    this.#lastLookup = now;
    this.#resolving = true;
    const lookup = this.#options.lookup ?? ((host: string) => dnsLookup(host, { all: true }));
    let pending: Promise<readonly ResolvedAddress[]>;
    try {
      pending = lookup(name);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (addresses) => {
        this.#resolving = false;
        if (this.#closed) return;
        // Prefer IPv4, like discovery: controllers also advertise link-local IPv6 addresses (§1.1).
        const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0];
        if (!chosen) {
          this.#fail(new Error(`${name} has no address`));
          return;
        }
        this.#stale = false;
        this.#aim(chosen);
      },
      (error: unknown) => {
        this.#resolving = false;
        if (!this.#closed) this.#fail(error);
      },
    );
  }

  /** Sends to `target` from now on, over a socket of its family (made, or swapped, here). */
  #aim(target: ResolvedAddress): void {
    this.#target = target;
    const type = target.family === 6 ? "udp6" : "udp4";
    if (this.#socket && this.#socketType === type) return;
    this.#closeSocket();
    const create = this.#options.createSocket ?? createSocket;
    let socket: Socket;
    try {
      socket = create(type);
    } catch (error) {
      this.#fail(error);
      return;
    }
    this.#socket = socket;
    this.#socketType = type;
    socket.on("error", (error) => this.#fail(error));
    try {
      socket.bind(0);
      socket.unref();
    } catch (error) {
      this.#fail(error);
    }
  }

  #closeSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#socketType = null;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }

  #sendFailed(error: unknown): void {
    if (this.#name !== null) this.#stale = true;
    this.#fail(error);
  }

  #fail(error: unknown): void {
    this.#errors++;
    if (this.#errors === 1 || this.#errors % LOG_EVERY === 0) {
      this.#options.log?.(`extControl frames to ${this.host}:${this.port} are failing (${this.#errors} so far)`, error);
    }
    if (this.#failing) return;
    this.#failing = true;
    try {
      this.#options.onError?.(error);
    } catch (failure) {
      this.#options.log?.("The extControl error handler failed", failure);
    }
  }
}

/**
 * A real socket. Frames only ever go to IP addresses, so its lookup hands the address straight back: dgram's default
 * (`dns.lookup`) would queue behind slow lookups elsewhere in the process.
 */
function createSocket(type: "udp4" | "udp6"): Socket {
  return createDgramSocket({
    type,
    lookup: (address, _options, callback) => callback(null, address, isIP(address) || (type === "udp6" ? 6 : 4)),
  });
}
