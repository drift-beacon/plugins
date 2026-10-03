/**
 * Finds controllers on the LAN (nanoleaf-api.md §1): an SSDP M-SEARCH and a one-shot legacy-unicast mDNS query, both
 * from ephemeral ports so nothing ever binds 1900 or 5353 (the OS responder owns 5353, and a fixed port left open
 * breaks the next start in the shared host). The parsers are pure and exported for the tests and the emulator.
 */
import { createSocket as createDgramSocket, type Socket } from "node:dgram";
import { API_PORT } from "../../../shared/protocol.ts";
import type { FoundController } from "../../../shared/types.ts";

/** The multicast groups and ports discovery sends to (it never binds them). */
export const SSDP_ADDRESS = "239.255.255.250";
export const SSDP_PORT = 1900;
export const MDNS_ADDRESS = "224.0.0.251";
export const MDNS_PORT = 5353;
/** The DNS-SD service Nanoleaf controllers advertise. */
export const MDNS_SERVICE = "_nanoleafapi._tcp.local";
/** M-SEARCH targets: the doc's two, plus the one Shapes advertise. */
export const SSDP_SEARCH_TARGETS: readonly string[] = ["ssdp:all", "nanoleaf:nl42", "nanoleaf_aurora:light"];

/** DNS record type codes the parser decodes. */
export const DNS_A = 1;
export const DNS_PTR = 12;
export const DNS_TXT = 16;
export const DNS_AAAA = 28;
export const DNS_SRV = 33;

/** How long to listen, and injectable sockets, signal and logger. */
export interface DiscoverOptions {
  /** How long to listen for answers. Default 2500 ms. */
  readonly timeoutMs?: number;
  /** Makes each UDP socket (tests inject sockets that talk to fake responders). Default: udp4. */
  readonly createSocket?: (purpose: "ssdp" | "mdns") => Socket;
  /** Ends the listening early (for example when the plugin stops); what was found so far is returned. */
  readonly signal?: AbortSignal;
  readonly log?: (message: string, error?: unknown) => void;
}

/** A DNS question: `unicastResponse` is the mDNS QU bit (the top bit of the class). */
export interface DnsQuestion {
  readonly name: string;
  readonly type: number;
  readonly unicastResponse: boolean;
}

interface RecordBase {
  /** Dotted, without the trailing dot; dots and backslashes inside a label are escaped with a backslash. */
  readonly name: string;
  readonly ttl: number;
}

/** A resource record from any section of a DNS message. */
export type DnsRecord =
  | (RecordBase & { readonly type: "A" | "AAAA"; readonly address: string })
  | (RecordBase & { readonly type: "PTR"; readonly target: string })
  | (RecordBase & {
      readonly type: "SRV";
      readonly priority: number;
      readonly weight: number;
      readonly port: number;
      readonly target: string;
    })
  | (RecordBase & { readonly type: "TXT"; readonly entries: readonly string[] })
  | (RecordBase & { readonly type: "other"; readonly code: number });

/** A parsed DNS message: its questions and every record of the answer, authority and additional sections. */
export interface DnsMessage {
  readonly id: number;
  readonly response: boolean;
  readonly questions: readonly DnsQuestion[];
  readonly records: readonly DnsRecord[];
}

/**
 * Listens for controllers for `timeoutMs` with SSDP and mDNS together, then merges the answers by host (mDNS data
 * wins, SSDP fills gaps). Never rejects: a network that can't multicast simply finds nothing. Every socket and timer
 * is closed before it resolves, including when `signal` aborts.
 */
export async function discover(options: DiscoverOptions = {}): Promise<FoundController[]> {
  const timeoutMs = options.timeoutMs ?? 2500;
  const make = options.createSocket ?? (() => createDgramSocket("udp4"));
  const log = options.log;
  const sockets: Socket[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const ssdp = new Map<string, FoundController>();
  const mdnsRecords = new Map<string, DnsRecord[]>();
  const asked = new Set<string>();
  const decoder = new TextDecoder();

  const send = (socket: Socket, bytes: Uint8Array, port: number, address: string) => {
    try {
      socket.send(bytes, port, address, (error) => {
        if (error) log?.(`Discovery couldn't send to ${address}:${port}`, error);
      });
    } catch (error) {
      log?.(`Discovery couldn't send to ${address}:${port}`, error);
    }
  };

  const open = (
    purpose: "ssdp" | "mdns",
    onMessage: (socket: Socket, message: Uint8Array, from: string) => void,
    onReady: (socket: Socket) => void,
  ) => {
    let socket: Socket;
    try {
      socket = make(purpose);
    } catch (error) {
      log?.(`Couldn't open a socket for ${purpose} discovery`, error);
      return;
    }
    sockets.push(socket);
    socket.on("error", (error) => log?.(`${purpose} discovery failed`, error));
    socket.on("message", (message, rinfo) => {
      try {
        onMessage(socket, message, rinfo.address);
      } catch (error) {
        log?.(`Ignored a ${purpose} answer from ${rinfo.address}`, error);
      }
    });
    try {
      socket.bind(0, () => {
        try {
          onReady(socket);
        } catch (error) {
          log?.(`${purpose} discovery failed`, error);
        }
      });
    } catch (error) {
      log?.(`Couldn't bind a socket for ${purpose} discovery`, error);
    }
  };

  open(
    "ssdp",
    (_socket, message, from) => {
      const found = parseSsdp(decoder.decode(message), from);
      if (found && !ssdp.has(found.host)) ssdp.set(found.host, found);
    },
    (socket) => {
      setTtl(socket, 2);
      const search = () => {
        for (const target of SSDP_SEARCH_TARGETS) {
          send(socket, new TextEncoder().encode(buildSsdpSearch(target)), SSDP_PORT, SSDP_ADDRESS);
        }
      };
      search();
      timers.push(setTimeout(search, 300));
    },
  );

  open(
    "mdns",
    (socket, message, from) => {
      const parsed = parseDnsMessage(message);
      if (!parsed.response) return;
      const records = mdnsRecords.get(from) ?? [];
      records.push(...parsed.records);
      mdnsRecords.set(from, records);
      // Some responders answer the PTR alone: ask once for each instance's SRV and TXT (its port, model and id).
      for (const instance of instancesWithoutSrv(records)) {
        const key = `${from} ${instance.toLowerCase()}`;
        if (asked.has(key)) continue;
        asked.add(key);
        const questions = [
          { name: instance, type: DNS_SRV },
          { name: instance, type: DNS_TXT },
        ];
        send(socket, buildMdnsQuery(questions), MDNS_PORT, MDNS_ADDRESS);
      }
    },
    (socket) => {
      setTtl(socket, 255);
      send(socket, buildMdnsQuery(), MDNS_PORT, MDNS_ADDRESS);
    },
  );

  const signal = options.signal;
  let stop = () => {};
  await new Promise<void>((resolve) => {
    stop = () => resolve();
    timers.push(setTimeout(stop, timeoutMs));
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });
  signal?.removeEventListener("abort", stop);
  for (const timer of timers) clearTimeout(timer);
  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      // Never bound, or already closed.
    }
  }
  const mdns = [...mdnsRecords].flatMap(([from, records]) => resolveMdns(records, from));
  return mergeFound(mdns, [...ssdp.values()]);
}

/** Merges results by host: mDNS first (its fields win), SSDP fills any null field. Sorted by name, then host. */
export function mergeFound(mdns: readonly FoundController[], ssdp: readonly FoundController[]): FoundController[] {
  const byHost = new Map<string, FoundController>();
  for (const found of [...mdns, ...ssdp]) {
    const key = found.host.toLowerCase();
    const known = byHost.get(key);
    byHost.set(
      key,
      known
        ? { ...known, name: known.name ?? found.name, model: known.model ?? found.model, id: known.id ?? found.id }
        : found,
    );
  }
  return [...byHost.values()].sort((a, b) => {
    if (a.name !== b.name) return a.name === null ? 1 : b.name === null ? -1 : a.name < b.name ? -1 : 1;
    return a.host < b.host ? -1 : a.host > b.host ? 1 : 0;
  });
}

/* ---- SSDP ---- */

/** An SSDP M-SEARCH for one search target; replies are delayed by up to `mx` seconds. */
export function buildSsdpSearch(searchTarget: string, mx = 1): string {
  return [
    "M-SEARCH * HTTP/1.1",
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    `MX: ${mx}`,
    `ST: ${searchTarget}`,
    "",
    "",
  ].join("\r\n");
}

/**
 * Reads an SSDP search response (or NOTIFY alive) from a controller: `ST`/`NT` naming Nanoleaf (or `nl-*` headers),
 * `Location: http://ip:port`, `nl-devicename`, `nl-deviceid`, and the model from the type suffix (`nanoleaf:nl42` →
 * NL42). Headers are case-insensitive. Null for anything else, including byebye.
 */
export function parseSsdp(text: string, from: string): FoundController | null {
  const lines = text.split(/\r\n|\n|\r/);
  const start = (lines[0] ?? "").trim();
  const response = /^HTTP\/1\.[01]\s+200(\s|$)/i.test(start);
  const notify = /^NOTIFY\s+\*\s+HTTP\/1\.[01]$/i.test(start);
  if (!response && !notify) return null;
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line.trim() === "") break;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(key)) headers.set(key, line.slice(colon + 1).trim());
  }
  if (notify && /byebye/i.test(headers.get("nts") ?? "")) return null;
  const type = headers.get("st") ?? headers.get("nt") ?? "";
  if (!/nanoleaf/i.test(type) && !headers.has("nl-deviceid") && !headers.has("nl-devicename")) return null;
  const location = /^https?:\/\/(\[[^\]]+\]|[^/:?#\s]+)(?::(\d+))?/i.exec(headers.get("location") ?? "");
  const host = location ? location[1].replace(/^\[|\]$/g, "") : from;
  const port = location?.[2] ? Number(location[2]) : API_PORT;
  const model = /nanoleaf:(nl\d+)/i.exec(type)?.[1]?.toUpperCase() ?? null;
  return {
    host,
    port: port > 0 && port < 65536 ? port : API_PORT,
    name: headers.get("nl-devicename") || null,
    model,
    id: headers.get("nl-deviceid") || null,
    source: "ssdp",
  };
}

/* ---- mDNS ---- */

/**
 * A one-shot mDNS query (ID `id`, QU bit set on every question). Default: a PTR query for `_nanoleafapi._tcp.local`.
 * Sent from a port other than 5353, responders answer by unicast to that port (legacy unicast, RFC 6762 §6.7).
 */
export function buildMdnsQuery(
  questions: readonly { readonly name: string; readonly type: number }[] = [{ name: MDNS_SERVICE, type: DNS_PTR }],
  id = 0,
): Uint8Array {
  const encoded = questions.map((question) => encodeName(question.name));
  const size = 12 + encoded.reduce((total, name) => total + name.length + 4, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, id);
  view.setUint16(4, questions.length);
  let offset = 12;
  questions.forEach((question, index) => {
    const name = encoded[index];
    bytes.set(name, offset);
    offset += name.length;
    view.setUint16(offset, question.type);
    view.setUint16(offset + 2, 0x8001);
    offset += 4;
  });
  return bytes;
}

/**
 * The controllers one mDNS answer describes: instances from PTR records for the service (or SRV/TXT named under it),
 * port from SRV, `md` and `id` from TXT, host from the SRV target's A record, else the sender (`from`, if IPv4), else a
 * routable AAAA. Malformed packets and queries give [].
 */
export function parseMdns(bytes: Uint8Array, from: string): FoundController[] {
  let message: DnsMessage;
  try {
    message = parseDnsMessage(bytes);
  } catch {
    return [];
  }
  return message.response ? resolveMdns(message.records, from) : [];
}

/** Resolves records gathered from one responder (possibly over several messages) into controllers. */
export function resolveMdns(records: readonly DnsRecord[], from: string | null): FoundController[] {
  const found: FoundController[] = [];
  for (const instance of instancesOf(records)) {
    const key = instance.toLowerCase();
    let srv: Extract<DnsRecord, { type: "SRV" }> | null = null;
    const txt = new Map<string, string>();
    for (const record of records) {
      if (record.name.toLowerCase() !== key) continue;
      if (record.type === "SRV" && !srv) srv = record;
      if (record.type !== "TXT") continue;
      for (const entry of record.entries) {
        const equals = entry.indexOf("=");
        const name = (equals < 0 ? entry : entry.slice(0, equals)).toLowerCase();
        if (name !== "" && !txt.has(name)) txt.set(name, equals < 0 ? "" : entry.slice(equals + 1));
      }
    }
    const target = srv?.target.toLowerCase() ?? null;
    const addresses = (type: "A" | "AAAA") =>
      records.flatMap((record) =>
        record.type === type && target !== null && record.name.toLowerCase() === target ? [record.address] : [],
      );
    const routableV6 = addresses("AAAA").filter((address) => !/^fe[89ab]/i.test(address));
    const host = addresses("A")[0] ?? (from !== null && isIPv4(from) ? from : null) ?? routableV6[0] ?? null;
    if (host === null) continue;
    found.push({
      host,
      port: srv && srv.port > 0 ? srv.port : API_PORT,
      name: unescapeLabel(firstLabel(instance)) || null,
      model: txt.get("md") || null,
      id: txt.get("id") || null,
      source: "mdns",
    });
  }
  return found;
}

/**
 * Parses a DNS message: header, questions, then every record of the answer, authority and additional sections, with
 * name compression. PTR, SRV, TXT, A and AAAA are decoded; others are kept as `other`. Throws on anything malformed
 * (truncation, bad pointers, pointer loops).
 */
export function parseDnsMessage(bytes: Uint8Array): DnsMessage {
  if (bytes.length < 12) throw new SyntaxError("DNS: shorter than a header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => {
    if (offset + 2 > bytes.length) throw new SyntaxError("DNS: truncated");
    return view.getUint16(offset);
  };
  const flags = u16(2);
  const counts = [u16(4), u16(6), u16(8), u16(10)] as const;
  let offset = 12;
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < counts[0]; i++) {
    const { name, next } = readName(bytes, offset);
    questions.push({ name, type: u16(next), unicastResponse: (u16(next + 2) & 0x8000) !== 0 });
    offset = next + 4;
  }
  const records: DnsRecord[] = [];
  const total = counts[1] + counts[2] + counts[3];
  for (let i = 0; i < total; i++) {
    const { name, next } = readName(bytes, offset);
    const type = u16(next);
    if (next + 10 > bytes.length) throw new SyntaxError("DNS: truncated record");
    const ttl = view.getUint32(next + 4);
    const length = u16(next + 8);
    const start = next + 10;
    const end = start + length;
    if (end > bytes.length) throw new SyntaxError("DNS: record data runs past the end");
    records.push(readRecord(bytes, view, name, type, ttl, start, end));
    offset = end;
  }
  return { id: u16(0), response: (flags & 0x8000) !== 0, questions, records };
}

function readRecord(
  bytes: Uint8Array,
  view: DataView,
  name: string,
  type: number,
  ttl: number,
  start: number,
  end: number,
): DnsRecord {
  const length = end - start;
  if (type === DNS_A && length === 4) {
    return { type: "A", name, ttl, address: Array.from(bytes.subarray(start, end)).join(".") };
  }
  if (type === DNS_AAAA && length === 16) return { type: "AAAA", name, ttl, address: formatIPv6(bytes, start) };
  if (type === DNS_PTR) return { type: "PTR", name, ttl, target: readName(bytes, start, end).name };
  if (type === DNS_SRV && length >= 7) {
    return {
      type: "SRV",
      name,
      ttl,
      priority: view.getUint16(start),
      weight: view.getUint16(start + 2),
      port: view.getUint16(start + 4),
      target: readName(bytes, start + 6, end).name,
    };
  }
  if (type === DNS_TXT) {
    const entries: string[] = [];
    for (let at = start; at < end; ) {
      const size = bytes[at];
      if (at + 1 + size > end) throw new SyntaxError("DNS: TXT string runs past its record");
      if (size > 0) entries.push(UTF8.decode(bytes.subarray(at + 1, at + 1 + size)));
      at += 1 + size;
    }
    return { type: "TXT", name, ttl, entries };
  }
  return { type: "other", name, ttl, code: type };
}

const UTF8 = new TextDecoder();
const MAX_JUMPS = 64;

/**
 * Reads a possibly compressed name at `offset`. `next` is where the name ends in the message (after the first
 * pointer, if any). `limit` bounds uncompressed labels inside record data.
 */
function readName(bytes: Uint8Array, offset: number, limit = bytes.length): { name: string; next: number } {
  const labels: string[] = [];
  let position = offset;
  let next = -1;
  let jumps = 0;
  let size = 0;
  for (;;) {
    const bound = next < 0 ? limit : bytes.length;
    if (position >= bound) throw new SyntaxError("DNS: name runs past the end");
    const length = bytes[position];
    if (length === 0) {
      if (next < 0) next = position + 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (position + 1 >= bound) throw new SyntaxError("DNS: truncated pointer");
      const pointer = ((length & 0x3f) << 8) | bytes[position + 1];
      if (next < 0) next = position + 2;
      if (++jumps > MAX_JUMPS || pointer >= bytes.length) throw new SyntaxError("DNS: bad compression pointer");
      position = pointer;
      continue;
    }
    if ((length & 0xc0) !== 0) throw new SyntaxError("DNS: unsupported label type");
    const end = position + 1 + length;
    if (end > bound) throw new SyntaxError("DNS: label runs past the end");
    size += length + 1;
    if (size > 255) throw new SyntaxError("DNS: name longer than 255 bytes");
    labels.push(escapeLabel(UTF8.decode(bytes.subarray(position + 1, end))));
    position = end;
  }
  return { name: labels.join("."), next };
}

function encodeName(name: string): Uint8Array {
  const encoder = new TextEncoder();
  const labels = splitName(name).map((label) => encoder.encode(label));
  const bytes = new Uint8Array(labels.reduce((total, label) => total + label.length + 1, 1));
  let offset = 0;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) throw new RangeError(`DNS: bad label in ${name}`);
    bytes[offset] = label.length;
    bytes.set(label, offset + 1);
    offset += label.length + 1;
  }
  return bytes;
}

/** Splits an escaped dotted name into its raw labels. */
function splitName(name: string): string[] {
  const labels: string[] = [];
  let label = "";
  for (let i = 0; i < name.length; i++) {
    const char = name[i];
    if (char === "\\" && i + 1 < name.length) label += name[++i];
    else if (char === ".") {
      labels.push(label);
      label = "";
    } else label += char;
  }
  if (label !== "") labels.push(label);
  return labels;
}

function escapeLabel(label: string): string {
  return label.replace(/[\\.]/g, (char) => `\\${char}`);
}

function unescapeLabel(label: string): string {
  return label.replace(/\\(.)/g, "$1");
}

/** The first (escaped) label of a dotted name. */
function firstLabel(name: string): string {
  for (let i = 0; i < name.length; i++) {
    if (name[i] === "\\") i++;
    else if (name[i] === ".") return name.slice(0, i);
  }
  return name;
}

/** Service instances the records mention: PTR targets for the service, and SRV/TXT owners under it. */
function instancesOf(records: readonly DnsRecord[]): string[] {
  const service = MDNS_SERVICE.toLowerCase();
  const instances = new Map<string, string>();
  for (const record of records) {
    const owner = record.name.toLowerCase();
    if (record.type === "PTR" && owner === service) {
      if (!instances.has(record.target.toLowerCase())) instances.set(record.target.toLowerCase(), record.target);
    } else if ((record.type === "SRV" || record.type === "TXT") && owner.endsWith(`.${service}`)) {
      if (!instances.has(owner)) instances.set(owner, record.name);
    }
  }
  return [...instances.values()];
}

function instancesWithoutSrv(records: readonly DnsRecord[]): string[] {
  return instancesOf(records).filter(
    (instance) =>
      !records.some((record) => record.type === "SRV" && record.name.toLowerCase() === instance.toLowerCase()),
  );
}

function formatIPv6(bytes: Uint8Array, start: number): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[start + i] << 8) | bytes[start + i + 1]).toString(16));
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  if (bestStart < 0) return groups.join(":");
  return `${groups.slice(0, bestStart).join(":")}::${groups.slice(bestStart + bestLength).join(":")}`;
}

function isIPv4(address: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
}

function setTtl(socket: Socket, ttl: number): void {
  try {
    socket.setMulticastTTL(ttl);
  } catch {
    // Not every socket (or platform) allows it; the default TTL of 1 still reaches the local link.
  }
}
