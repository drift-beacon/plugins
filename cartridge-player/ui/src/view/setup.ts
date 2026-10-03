/**
 * The setup guide's fields and the code it builds. The plugin can't see its own address from the player's side of
 * the network, so the guide prefills the best guess: the Host header a player already used to reach the hub
 * (`hubHost`), else the address this page was loaded from, and lets the user correct it. A page opened on the hub's
 * own machine (`localhost`) has no guess to offer: the field starts empty rather than with an address a player can
 * never reach.
 */
import { encodeSetupCode, setupFieldError } from "../../../shared/setup-code.ts";
import type { PresenceState } from "../../../shared/state.ts";
import { activeDevice, type PlayerRecord } from "../../../shared/storage.ts";

/** The hub's HTTP listener for the Home Assistant add-on, and the usual one. */
export const DEFAULT_PORT = 9001;

/**
 * Where the player serves its setup page while its own network is up (player/src/hal/wifi_link.cpp). Not the
 * ESP32's usual address: some home routers hand out that range.
 */
export const PLAYER_SETUP_URL = "http://10.123.45.1/";

/**
 * The network a player opens while it isn't set up: the firmware's prefix (player/src/core/device.h) and four
 * characters of its own, so the guide can only give the pattern.
 */
export const PLAYER_NETWORK = "Cartridge-XXXX";

/** How long BOOT is held to open setup again (player/src/core/inputs.h). */
export const BOOT_HOLD_S = 3;

export interface HubAddress {
  readonly host: string;
  readonly port: number;
}

/** A Host header as host and port: "192.168.1.12:9001", "hub.local" (port 80). IPv6 literals aren't supported. */
export function splitHost(hostHeader: string): HubAddress | null {
  const match = /^([A-Za-z0-9._-]{1,253})(?::(\d{1,5}))?$/.exec(hostHeader.trim());
  if (!match) return null;
  const port = match[2] === undefined ? 80 : Number(match[2]);
  return port >= 1 && port <= 65535 ? { host: match[1], port } : null;
}

/** An address only this computer can reach: a player on the network can't use it. */
export function isLoopback(host: string): boolean {
  return /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0)$/i.test(host.trim());
}

/**
 * Where the guide starts: the address a player reached the hub at, else this page's host on DEFAULT_PORT. A loopback
 * page host is left blank for the user to fill in.
 */
export function hubDefaults(record: PlayerRecord, pageHost: string): HubAddress {
  const devices = [activeDevice(record), ...Object.values(record.devices)];
  for (const device of devices) {
    const known = device?.hubHost ? splitHost(device.hubHost) : null;
    if (known) return known;
  }
  return { host: isLoopback(pageHost) ? "" : pageHost, port: DEFAULT_PORT };
}

export interface SetupFields {
  readonly host: string;
  /** As typed. */
  readonly port: string;
  readonly base: string;
  /** As pasted; empty means the player's setup page asks for the key itself. */
  readonly key: string;
}

export type SetupProblems = Partial<Record<"host" | "port" | "base" | "key", string>>;

/** The setup code for the fields, or what's wrong with them (the same rules the player applies). */
export function setupCodeFor(fields: SetupFields): { readonly code: string | null; readonly problems: SetupProblems } {
  const host = fields.host.trim();
  const port = /^\d+$/.test(fields.port.trim()) ? Number(fields.port.trim()) : Number.NaN;
  const key = fields.key.trim() || null;
  const problems: SetupProblems = {};
  const hostProblem = setupFieldError("host", host);
  const portProblem = setupFieldError("port", port);
  const baseProblem = setupFieldError("base", fields.base);
  const keyProblem = key === null ? null : setupFieldError("key", key);
  if (hostProblem) problems.host = hostProblem;
  else if (isLoopback(host)) problems.host = "That only works on this computer: enter the hub's address on your network instead.";
  if (portProblem) problems.port = portProblem;
  if (baseProblem) problems.base = baseProblem;
  if (keyProblem) problems.key = keyProblem;
  if (Object.keys(problems).length) return { code: null, problems };
  return { code: encodeSetupCode({ host, port, base: fields.base, key }), problems };
}

/** The guide's steps, one screen each. */
export type GuideStep = "hub" | "key" | "code" | "phone";

/** The hub's address is a step only when the page couldn't work it out: a default that is right is never asked. */
export function guideSteps(hubKnown: boolean): readonly GuideStep[] {
  return hubKnown ? ["key", "code", "phone"] : ["hub", "key", "code", "phone"];
}

/** Who had been heard, and when, at the moment a guide opened. */
export interface HeardMark {
  readonly at: Readonly<Record<string, string | null>>;
  readonly online: boolean;
}

export function heardMark(record: PlayerRecord, presence: PresenceState | null): HeardMark {
  const at: Record<string, string | null> = {};
  for (const device of Object.values(record.devices)) at[device.id] = device.lastHeardAt;
  return { at, online: presence?.online === true };
}

/**
 * The player that has reported since the guide opened, which is how the guide knows the setup worked: one it hadn't
 * heard of, one whose last report is newer, or the shown one coming online (main doesn't write every heartbeat, so a
 * player set up again shows as that). Null while there is none.
 */
export function heardSince(mark: HeardMark, record: PlayerRecord, presence: PresenceState | null): { readonly name: string | null } | null {
  for (const device of Object.values(record.devices)) {
    const before = mark.at[device.id];
    const fresh = before === undefined ? device.lastHeardAt !== null || device.slot !== null : (device.lastHeardAt ?? "") > (before ?? "");
    if (fresh) return { name: device.name };
  }
  if (presence?.online === true && !mark.online) return { name: presence.name };
  return null;
}
