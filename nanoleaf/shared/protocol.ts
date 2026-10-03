/**
 * Nanoleaf wire formats (nanoleaf-api.md §4 and §5): the extControl v2 UDP packet and the `animData` string of static
 * and custom effects. Pure (Uint8Array and DataView, no Buffer), so main, the emulator and the tests share one copy.
 */
import type { Rgb } from "./types.ts";

/** The controller's REST port (OpenAPI), unless discovery says otherwise. */
export const API_PORT = 16021;
/** The UDP port Shapes controllers take extControl v2 frames on (the address is the controller's). */
export const EXT_CONTROL_PORT = 60222;

/** The `write` body that switches the controller to extControl v2 streaming (`PUT /effects {write}`). */
export const EXT_CONTROL_V2_COMMAND = { command: "display", animType: "extControl", extControlVersion: "v2" } as const;

/** One panel's colour: panel id, colour and, optionally, its own transition (100 ms units) overriding the default. */
export type PanelRgb = readonly [id: number, rgb: Rgb, transitionDs?: number];

/** One panel of a decoded extControl v2 packet. */
export interface ExtControlPanel {
  readonly id: number;
  readonly rgb: Rgb;
  /** Transition to this colour, in 100 ms units. */
  readonly transitionDs: number;
}

/** One frame of an `animData` panel: a colour (W is ignored by the device) and its transition `t` in 100 ms units. */
export interface AnimFrame {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly w: number;
  /** 100 ms units; -1 marks an instant start frame. */
  readonly t: number;
}

/** A `write` body for a static display: what `PUT /effects {write}` takes to show `animData` without saving it. */
export interface StaticDisplayCommand {
  readonly command: "display";
  readonly animType: "static";
  readonly animData: string;
  readonly loop: false;
  readonly palette: readonly [];
  readonly colorType: "HSB";
}

const U16_MAX = 0xffff;
const HEADER_BYTES = 2;
const PANEL_BYTES = 8;

/**
 * Encodes one extControl v2 frame, big-endian: u16 panel count, then per panel u16 id, u8 R, G, B, u8 W (always 0)
 * and u16 transition. Channels are rounded and clamped to 0–255; an id outside 0–65535 throws a RangeError rather
 * than wrapping onto another panel.
 */
export function encodeExtControlV2(lights: Iterable<PanelRgb>, transitionDs = 1): Uint8Array {
  const entries = Array.from(lights);
  if (entries.length > U16_MAX) throw new RangeError(`An extControl v2 frame holds at most ${U16_MAX} panels`);
  const bytes = new Uint8Array(HEADER_BYTES + PANEL_BYTES * entries.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, entries.length);
  let offset = HEADER_BYTES;
  for (const [id, rgb, transition] of entries) {
    view.setUint16(offset, panelId(id));
    bytes[offset + 2] = channel(rgb[0]);
    bytes[offset + 3] = channel(rgb[1]);
    bytes[offset + 4] = channel(rgb[2]);
    bytes[offset + 5] = 0;
    view.setUint16(offset + 6, clampInt(transition ?? transitionDs, 0, U16_MAX));
    offset += PANEL_BYTES;
  }
  return bytes;
}

/** Decodes an extControl v2 frame (the emulator and tests). Throws when the length doesn't match the panel count. */
export function decodeExtControlV2(bytes: Uint8Array): ExtControlPanel[] {
  if (bytes.length < HEADER_BYTES) {
    throw new RangeError(`An extControl v2 frame is at least 2 bytes, not ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(0);
  const expected = HEADER_BYTES + PANEL_BYTES * count;
  if (bytes.length !== expected) {
    throw new RangeError(`An extControl v2 frame for ${count} panels is ${expected} bytes, not ${bytes.length}`);
  }
  const panels: ExtControlPanel[] = [];
  for (let offset = HEADER_BYTES; offset < expected; offset += PANEL_BYTES) {
    panels.push({
      id: view.getUint16(offset),
      rgb: [view.getUint8(offset + 2), view.getUint8(offset + 3), view.getUint8(offset + 4)],
      transitionDs: view.getUint16(offset + 6),
    });
  }
  return panels;
}

/**
 * The `animData` of a static effect: `"<n> <id> 1 R G B 0 T …"`, ids in decimal. Pass every light panel: a static
 * write that leaves a panel out turns it off.
 */
export function staticAnimData(lights: Iterable<PanelRgb>, transitionDs = 5): string {
  const parts: string[] = [];
  let count = 0;
  for (const [id, rgb, transition] of lights) {
    const t = clampInt(transition ?? transitionDs, -1, U16_MAX);
    parts.push(`${panelId(id)} 1 ${channel(rgb[0])} ${channel(rgb[1])} ${channel(rgb[2])} 0 ${t}`);
    count++;
  }
  return count === 0 ? "0" : `${count} ${parts.join(" ")}`;
}

/** The `write` body that shows `animData` as a temporary static display (the official example's fields). */
export function staticDisplay(animData: string): StaticDisplayCommand {
  return { command: "display", animType: "static", animData, loop: false, palette: [], colorType: "HSB" };
}

/**
 * Parses static or custom `animData` into frames per panel id (the emulator, tests and hand-back of a `*Static*`
 * scene). Whitespace of any kind separates numbers. Throws on anything malformed; a repeated id keeps its last entry.
 */
export function parseAnimData(s: string): Map<number, AnimFrame[]> {
  const tokens = s.trim().split(/\s+/);
  let index = 0;
  const next = (what: string): number => {
    const token = tokens[index++];
    if (token === undefined || !/^-?\d+$/.test(token)) {
      throw new SyntaxError(`animData: expected ${what} at token ${index}, found ${token ?? "the end"}`);
    }
    return Number(token);
  };
  const panels = new Map<number, AnimFrame[]>();
  const count = next("the panel count");
  if (count < 0) throw new SyntaxError("animData: the panel count is negative");
  for (let panel = 0; panel < count; panel++) {
    const id = next("a panel id");
    const frameCount = next("a frame count");
    if (id < 0 || id > U16_MAX) throw new SyntaxError(`animData: panel id ${id} is out of range`);
    if (frameCount < 1) throw new SyntaxError(`animData: panel ${id} has ${frameCount} frames`);
    const frames: AnimFrame[] = [];
    for (let frame = 0; frame < frameCount; frame++) {
      frames.push({ r: next("R"), g: next("G"), b: next("B"), w: next("W"), t: next("T") });
    }
    panels.set(id, frames);
  }
  if (index < tokens.length) throw new SyntaxError(`animData: ${tokens.length - index} unexpected trailing values`);
  return panels;
}

function panelId(id: number): number {
  if (!Number.isInteger(id) || id < 0 || id > U16_MAX) throw new RangeError(`Panel id ${id} is not in 0–65535`);
  return id;
}

function channel(value: number): number {
  return clampInt(value, 0, 255);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min < 0 ? 0 : min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
