/**
 * The check main makes before the server connects anywhere: the host must be on the local network (shared/lan.ts).
 * It is there to catch mistakes, not attackers: a mistyped address, a public one pasted in, a name that leads off
 * the network. A Nanoleaf controller is always on the LAN, so anything else is an error worth explaining before the
 * server probes it. The people who can reach this are the workspace's own members, who are trusted, and a host name
 * is looked up again at every connection, so this is not a security boundary and must not be relied on as one.
 * The address is judged as the server will use it: in the form `fetch` gives it (`0x7f.1` is 127.0.0.1), and for a
 * host name, by every address it resolves to at that moment.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { PluginError } from "@drift-beacon/plugin";
import { type AddressKind, addressKind, isHostOnly, lanProblem, zonedAddress, zoneProblem } from "../../shared/lan.ts";

/** Resolves a host name to its addresses (`dns.lookup`, all of them); injectable for tests. */
export type Lookup = (host: string) => Promise<readonly string[]>;

export interface LanHostOptions {
  /** Also accept the server's own loopback addresses: development builds only, for the emulator. */
  readonly allowLoopback?: boolean;
  readonly lookup?: Lookup;
  /** Ends a lookup early; the check then rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

const NOT_A_HOST = "That isn't an IP address or host name";

const systemLookup: Lookup = async (host) => (await dnsLookup(host, { all: true })).map((entry) => entry.address);

/**
 * The host as `fetch` will read it (`http.ts` builds `http://<host>:<port>/…`), without brackets. Null when it can't,
 * or when `host` is more than a host: something a URL would read as a port, a path or a login (`isHostOnly`).
 */
function fetchedHost(host: string): string | null {
  if (!isHostOnly(host)) return null;
  try {
    const url = new URL(`http://${host.includes(":") ? `[${host}]` : host}/`);
    return url.hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/**
 * Resolves when `host` is a private address on the local network, or a name that leads only to such addresses.
 * Rejects with a `PluginError` the interface shows: `invalid` for a public, loopback or link-local address (or a
 * name leading to one) and for anything that isn't a host, `unavailable` for a name nothing answers to.
 *
 * A name is looked up here and then again by each connection (REST, the event stream, the frame stream), and nothing
 * ties those lookups to this one: if the name leads somewhere else by then, that is where the connection goes. So
 * the check says where a host led when it was asked, which is enough to catch a wrong entry and not a guarantee
 * about where the server connects.
 */
export async function assertLanHost(host: string, options: LanHostOptions = {}): Promise<void> {
  /** Throws unless the server may connect to an address of this kind. */
  const check = (kind: AddressKind): void => {
    if (kind === "lan" || (kind === "loopback" && options.allowLoopback === true)) return;
    throw new PluginError("invalid", lanProblem(host, kind));
  };
  if (host.includes("%")) {
    // A zone (`fe80::1%en0`) follows an IPv6 address, and a URL can't carry one: refused as the address itself would
    // be, else for its zone. Any other `%` (an escape, `10.0.0.1%2f`) isn't part of a host.
    const zoned = zonedAddress(host);
    if (!zoned) throw new PluginError("invalid", NOT_A_HOST);
    check(zoned.kind);
    throw new PluginError("invalid", zoneProblem(zoned.address));
  }
  const fetched = fetchedHost(host);
  if (fetched === null) throw new PluginError("invalid", NOT_A_HOST);

  const literal = addressKind(fetched);
  if (literal !== null) return check(literal);

  let addresses: readonly string[];
  try {
    addresses = await aborting((options.lookup ?? systemLookup)(fetched), options.signal);
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
    throw new PluginError(
      "unavailable",
      `Can't find ${host} on the network. Check the name, or enter the controller's IP address, like 192.168.1.40.`,
    );
  }
  let usable = false;
  for (const address of addresses) {
    // `dns.lookup` reports a link-local IPv6 address with its zone. Controllers advertise one beside their IPv4
    // address (nanoleaf-api.md §1.1); it can't leave the link, so it is skipped rather than refused.
    const zone = address.indexOf("%");
    const kind = addressKind(zone === -1 ? address : address.slice(0, zone)) ?? "outside";
    if (kind === "link-local" && address.includes(":")) continue;
    check(kind);
    usable = true;
  }
  if (!usable) {
    throw new PluginError(
      "unavailable",
      `${host} has no address the server can use. Enter the controller's IPv4 address, like 192.168.1.40.`,
    );
  }
}

/** `promise`, or a rejection with the signal's reason as soon as it aborts. */
function aborting<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    // Settling after an abort is a no-op, and the lookup's own rejection is always handled here.
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
