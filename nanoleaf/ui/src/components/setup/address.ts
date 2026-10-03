import {
  addressKind,
  LINK_LOCAL_IPV6,
  lanProblem,
  parseIPv4,
  parseIPv6,
  zonedAddress,
  zoneProblem,
} from "../../../../shared/lan.ts";

/** Where a controller answers when nobody says otherwise. */
export const DEFAULT_PORT = 16021;

/** A controller's address as typed, parsed: a host and a port, or why it can't be one. */
export type ParsedAddress =
  | { readonly ok: true; readonly host: string; readonly port: number }
  | { readonly ok: false; readonly error: string };

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;

/** A host name: labels of letters, digits and hyphens. Only digits and dots is a mistyped IP address, not a name. */
function validName(host: string): boolean {
  if (/^[\d.]+$/.test(host)) return false;
  if (host.length > 253) return false;
  return host.split(".").every((label) => LABEL.test(label));
}

/**
 * Why main would refuse to pair with this address, when the page can already tell: it only pairs with a private
 * address on the local network (shared/lan.ts). Loopback is left to main, which accepts it in a development build
 * (the emulator), and so is a host name, which only the server can resolve.
 */
function refusal(host: string): string | null {
  const kind = addressKind(host);
  return kind === "outside" || kind === "link-local" ? lanProblem(host, kind) : null;
}

/**
 * Parse `host[:port]` the way people type it: surrounding spaces, a pasted `http://…/` and bracketed IPv6
 * (`[fd00::40]:16021`) are fine; the port defaults to 16021. Refused, with what to enter instead: link-local
 * addresses (IPv6 with a zone, `%en0`, or without: the server can't reach them), any other address with a zone, and
 * addresses outside the local network (main pairs only with private ones).
 */
export function parseAddress(input: string): ParsedAddress {
  let text = input.trim();
  if (!text) return { ok: false, error: "Enter the controller's IP address or host name." };
  text = text.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");

  let host = text;
  let portText: string | null = null;
  // A zone (`fe80::1%en0`, `%25en0` in a pasted URL) follows an IPv6 address, and the server can't use one: refused
  // as the address itself would be (nearly always link-local), else for its zone. Another `%` isn't a host, below.
  const zoned = zonedAddress(text.replace(/^\[/, ""));
  if (zoned) return { ok: false, error: refusal(zoned.address) ?? zoneProblem(zoned.address) };
  const v6 = /^\[([^\]]*)\](?::(\d*))?$/.exec(text);
  if (v6) {
    host = v6[1];
    portText = v6[2] ?? null;
    if (!host.includes(":") || !parseIPv6(host)) {
      return { ok: false, error: "That doesn't look like an IPv6 address." };
    }
  } else {
    const colon = text.lastIndexOf(":");
    if (colon !== -1) {
      if (text.indexOf(":") !== colon) {
        if (addressKind(text) === "link-local") return { ok: false, error: LINK_LOCAL_IPV6 };
        return { ok: false, error: "Put an IPv6 address in brackets, like [fd00::40]:16021." };
      }
      host = text.slice(0, colon);
      portText = text.slice(colon + 1);
    }
    const v4 = parseIPv4(host);
    // As typed, without leading zeros: main reads the address the way `fetch` does, where `010` is octal.
    if (v4) host = v4.join(".");
    else if (!validName(host)) {
      return {
        ok: false,
        error: /^[\d.]+$/.test(host)
          ? "That IP address isn't complete: it has four numbers from 0 to 255, like 192.168.1.40."
          : "That isn't an IP address or host name.",
      };
    }
  }
  const refused = refusal(host);
  if (refused) return { ok: false, error: refused };

  if (portText === null) return { ok: true, host, port: DEFAULT_PORT };
  if (!/^\d{1,5}$/.test(portText)) return { ok: false, error: "The port is a number, like 16021." };
  const port = Number(portText);
  if (port < 1 || port > 65535) return { ok: false, error: "The port is a number from 1 to 65535." };
  return { ok: true, host, port };
}
