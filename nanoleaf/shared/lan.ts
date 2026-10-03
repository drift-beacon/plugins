/**
 * Which addresses count as "on your network" for pairing: private IPv4 (RFC 1918) and IPv6 unique local addresses
 * (fc00::/7). Main refuses to pair with anything else (main/src/lan.ts), and the address field refuses what it can
 * already tell (ui setup/address.ts) in the same words. This catches a mistyped or public address, where no
 * controller can be; it is not a defence against anyone (a host name is looked up again at each connection).
 */

/**
 * - `lan`: 10/8, 172.16/12, 192.168/16, fc00::/7.
 * - `loopback`: 127/8 and ::1, the Drift Beacon server itself.
 * - `link-local`: 169.254/16 and fe80::/10.
 * - `outside`: everything else, the unspecified addresses (0.0.0.0/8, ::) included.
 */
export type AddressKind = "lan" | "loopback" | "link-local" | "outside";

/** Four octets of a dotted IPv4 address (`192.168.1.40`; leading zeros read as decimal), or null. */
export function parseIPv4(text: string): readonly number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/**
 * The eight 16-bit groups of an IPv6 address without brackets or zone: eight hex groups, or fewer around one `::`,
 * the last two optionally a dotted IPv4 address (`::ffff:192.168.1.40`). Null for anything else.
 */
export function parseIPv6(text: string): readonly number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const read = (half: string, last: boolean): number[] | null => {
    if (half === "") return [];
    const parts = half.split(":");
    const groups: number[] = [];
    for (const [index, part] of parts.entries()) {
      if (last && index === parts.length - 1 && part.includes(".")) {
        const v4 = parseIPv4(part);
        if (!v4) return null;
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) groups.push(Number.parseInt(part, 16));
      else return null;
    }
    return groups;
  };
  const head = read(halves[0], halves.length === 1);
  const tail = halves.length === 2 ? read(halves[1], true) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - tail.length;
  return gap >= 1 ? [...head, ...new Array<number>(gap).fill(0), ...tail] : null;
}

const HOST_NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

/**
 * Whether `host` is a host and nothing more: a name or dotted IPv4 address (letters, digits, dots and hyphens), or an
 * IPv6 address without brackets or zone. Anything else would mean something in the URL main builds from it
 * (`http://<host>:<port>/…`): `/`, `?` and `#` start a path, `@` ends a login, a `:` outside an IPv6 address starts a
 * port. It says nothing about where the host is (`addressKind`).
 */
export function isHostOnly(host: string): boolean {
  return host.includes(":") ? parseIPv6(host) !== null : HOST_NAME.test(host);
}

function kindOfIPv4([a, b]: readonly number[]): AddressKind {
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  return "outside";
}

/**
 * What kind of address `host` is, or null when it isn't an IP address (a host name). IPv6 comes without brackets; an
 * IPv4-mapped one (`::ffff:10.0.0.2`) is the kind of its IPv4 address.
 */
export function addressKind(host: string): AddressKind | null {
  const v4 = parseIPv4(host);
  if (v4) return kindOfIPv4(v4);
  const v6 = host.includes(":") ? parseIPv6(host) : null;
  if (!v6) return null;
  if (v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff) {
    return kindOfIPv4([v6[6] >> 8, v6[6] & 0xff, v6[7] >> 8, v6[7] & 0xff]);
  }
  if (v6.slice(0, 7).every((group) => group === 0) && v6[7] === 1) return "loopback";
  if ((v6[0] & 0xfe00) === 0xfc00) return "lan";
  if ((v6[0] & 0xffc0) === 0xfe80) return "link-local";
  return "outside";
}

/**
 * An address written with a zone (`fe80::1%en0`): the address before the `%`, and its kind. null when `host` has no
 * `%`, or what comes before it isn't an IPv6 address: only those have zones, so anything else with a `%` isn't a host.
 */
export function zonedAddress(host: string): { readonly address: string; readonly kind: AddressKind } | null {
  const at = host.indexOf("%");
  const address = at === -1 ? "" : host.slice(0, at);
  const kind = address.includes(":") ? addressKind(address) : null;
  return kind === null ? null : { address, kind };
}

/** Why an address the plugin could use can't come with a zone: the URL the server fetches can't carry one. */
export function zoneProblem(address: string): string {
  return `Enter ${address} without its zone (the part from the % on): the server can't use one.`;
}

/**
 * fe80::/10 needs a zone (which interface), and the URL the server fetches can't carry one (nanoleaf-api.md §1), so
 * the plugin can't use such an address with or without one.
 */
export const LINK_LOCAL_IPV6 =
  "Link-local IPv6 addresses (fe80::…) don't work from the server. Enter the controller's IPv4 address, like " +
  "192.168.1.40, or its host name.";

/** Why the plugin won't pair with `host`, an address of that kind (or a name that leads to one). */
export function lanProblem(host: string, kind: Exclude<AddressKind, "lan">): string {
  if (kind === "loopback") {
    return `${host} is the Drift Beacon server itself. Enter the controller's address on your network, like 192.168.1.40.`;
  }
  if (kind === "link-local") {
    return host.includes(":")
      ? LINK_LOCAL_IPV6
      : `${host} is a self-assigned address: the controller isn't on your network yet. Once it has joined your ` +
          "Wi-Fi, enter the address your router gives it, like 192.168.1.40.";
  }
  return `${host} isn't on your network. Enter the controller's local address, like 192.168.1.40.`;
}
