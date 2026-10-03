#!/usr/bin/env node
/**
 * A Nanoleaf Shapes controller on this machine, close enough to develop and demo the plugin without hardware
 * (DESIGN.md "Emulator", nanoleaf-api.md): the REST API with pairing and token checks, SSE events 1–4, extControl v2
 * frames over UDP, static and custom animData, optional SSDP answers, and a virtual wall page. It has no dependencies:
 * it imports shared/*.ts through Node's type stripping.
 *
 *   node tools/fake-nanoleaf.mjs [--layout mixed|triangles|hexagons|minis|big|<info.json>] [--port 16021]
 *     [--wall 16022|none] [--udp 60222] [--host 127.0.0.1] [--pairing button|open] [--ssdp] [--quiet]
 *     [--serial S123] [--token <token>]…
 *
 * `--serial` and `--token` bring the same controller back somewhere else (another port or `--host`), still knowing
 * the tokens it handed out: what a controller with a new address looks like to the plugin.
 *
 * Tests start it in-process: `const emu = await startEmulator({ port: 0, wallPort: 0, udpPort: 0, quiet: true })`,
 * and inject failures with `emu.faults({ dropNext, hangNext, failNext, delayMs, match, … })` and `emu.closeEvents()`.
 *
 * Where the real device's behaviour is unverified (nanoleaf-api.md §11), the emulator picks one: frames and static
 * displays keep painting while the wall is off (it just shows dark), a brightness `value` turns the wall on, a
 * `display` write does not, selecting an effect does, and a frame naming any unknown panel is dropped whole.
 */
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { layoutFromPanelLayout, placeLayout, shapeLabel } from "../shared/geometry.ts";
import { decodeExtControlV2, parseAnimData } from "../shared/protocol.ts";

/** Layout names and the fixture (a real or synthesised `GET /` answer) each one loads. */
export const LAYOUTS = Object.freeze({
  mixed: "theduck",
  triangles: "wings",
  hexagons: "hexagons",
  minis: "minis",
  big: "big",
});

/** Touch gesture ids 0–5 (SSE event 4), in order. */
export const GESTURES = Object.freeze(["tap", "double-tap", "swipe-up", "swipe-down", "swipe-left", "swipe-right"]);

/** How long "Hold power button" keeps the pairing window open, like the real controller. */
export const PAIRING_MS = 30_000;

const FIXTURES_DIR = new URL("../tests/fixtures/", import.meta.url);
const WALL_PAGE = new URL("./fake-nanoleaf-wall.html", import.meta.url);
const OFF = Object.freeze([0, 0, 0]);
const WHITE = Object.freeze([255, 255, 255]);
/** Crossfade when the wall switches to a generated scene (an effect, a solid colour, a custom animation). */
const MODE_FADE_MS = 600;
const POWER_FADE_MS = 400;
/** A brightness change without `duration` still eases a little, as the device does. */
const BRIGHTNESS_EASE_MS = 250;
/** Panels a static display leaves out fade off this fast. */
const UNLISTED_OFF_MS = 400;
/** One pass of a named effect's palette across the wall. */
const EFFECT_PERIOD_MS = 9000;
const FPS_WINDOW_MS = 2000;
const WALL_TICK_MS = 50;
const UDP_SUMMARY_MS = 5000;
const MAX_BODY = 1 << 20;
const MAX_REQUESTS = 500;
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SSDP_GROUP = "239.255.255.250";
const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" };
const STATE_KEYS = ["on", "brightness", "hue", "sat", "ct"];
/** SSE state event attributes, in id order. */
const STATE_ATTRS = [
  [1, "on"],
  [2, "brightness"],
  [3, "hue"],
  [4, "sat"],
  [5, "ct"],
  [6, "colorMode"],
];
const RANGES = { brightness: [0, 100], hue: [0, 360], sat: [0, 100], ct: [1200, 6500] };
const DEFAULT_EFFECTS = ["Blaze", "Cotton Candy", "Morning Sky", "Northern Lights", "Starlight"];
/** Palettes for named effects, as [hue, saturation] pairs, matched on the name. */
const PALETTES = [
  [/star|night|inner|peace|candle/i, [[35, 30], [45, 12], [220, 30], [28, 45]]],
  [/northern|aurora|forest|jungle|emerald/i, [[135, 100], [165, 100], [195, 100], [275, 80]]],
  [/blaze|flame|fire|hot|sunset|sundown|lava|autumn/i, [[0, 100], [16, 100], [32, 100], [48, 90]]],
  [/cotton|candy|pop|date|romantic|love/i, [[320, 70], [285, 55], [200, 55], [345, 90]]],
  [/beach|water|ocean|sky|snow|nemo|ice|morning/i, [[195, 100], [175, 85], [215, 80], [40, 45]]],
  [/prism|beat|hip|burst|light|rainbow|party/i, [[0, 100], [55, 100], [120, 100], [200, 100], [280, 100]]],
];

/* ---- Programmatic API ---- */

/**
 * @typedef {object} EmulatorOptions
 * @property {string} [host] Address for REST, UDP and the wall page. Default "127.0.0.1".
 * @property {number} [port] REST port; 0 is ephemeral. Default 16021.
 * @property {number | null} [wallPort] Wall page port; 0 is ephemeral, null means no page. Default 16022.
 * @property {number} [udpPort] extControl UDP port; 0 is ephemeral. Default 60222.
 * @property {string | object} [layout] A `LAYOUTS` name, a `GET /` JSON path, or an info object. Default "mixed".
 * @property {"button" | "open"} [pairing] "open" hands out tokens without the pairing window. Default "button".
 * @property {string} [serialNo] The serial number it reports instead of the layout's: the same one makes it the same
 *   controller at another address, another one a different controller.
 * @property {Iterable<string>} [tokens] Tokens it already knows (handed out before it moved). Default none.
 * @property {boolean} [ssdp] Answer SSDP M-SEARCH on `ssdpPort`. Default false.
 * @property {number} [ssdpPort] 0 is ephemeral (tests send M-SEARCH to it directly). Default 1900.
 * @property {boolean} [quiet] No log lines. Default false.
 * @property {(line: string) => void} [log] Where log lines go instead of console.log.
 * @property {number} [keepAliveMs] SSE comment keep-alive period, 0 for none. Default 0: the real controller isn't
 *   known to send any (nanoleaf-api.md §11.6), so clients must cope with a quiet stream.
 * @property {() => number} [now] Clock (ms) for transitions and the pairing window. Default Date.now.
 * @property {() => number} [random] Randomness in [0, 1) for tokens and picks. Default Math.random.
 * @property {boolean} [extControl] false makes the extControl write fail with 400 (old firmware). Default true.
 * @property {boolean} [brightnessTurnsOn] A brightness value without `on` turns the wall on. Default true.
 * @property {boolean} [writesTurnOn] A `display` write turns the wall on. Default false.
 * @property {FaultSpec} [faults] Failures to inject from the start, as `emu.faults(spec)` would.
 */

/**
 * Failures to inject, for testing how clients cope with a busy or flaky controller. Counters add a rule that affects
 * the next n REST requests `match` selects (rules apply in the order they were added, one per request); `delayMs`,
 * `refuseExtControl` and `dropFrames` stay until changed.
 *
 * @typedef {object} FaultSpec
 * @property {number} [dropNext] Reset the connection of the next n matching requests without an answer, like a busy
 *   controller dropping them. They never reach the device.
 * @property {number} [hangNext] Never answer the next n matching requests (the client times out). They never reach the
 *   device; `close()` ends them.
 * @property {number} [failNext] Answer the next n matching requests with `failStatus`, without doing anything.
 * @property {number} [failStatus] The status `failNext` answers. Default 503.
 * @property {number} [delayMs] Hold every matching request this long before handling it (0 clears). A held request
 *   still runs when its time comes, even if the client gave up, as a slow controller's would.
 * @property {FaultMatch | ((request: FaultRequest) => boolean) | null} [match] Which requests the counters and
 *   `delayMs` of this call apply to. Default: every request.
 * @property {boolean} [refuseExtControl] The extControl `display` write answers 400 (`extControl: false`, at run time).
 * @property {boolean} [dropFrames] UDP frames are lost on the way (counted in `lostFrames`, never applied).
 */

/**
 * @typedef {object} FaultMatch
 * @property {string} [method] "GET", "PUT", "POST" or "DELETE".
 * @property {string | RegExp} [path] The path after `/api/v1/<token>`: "/" (info, revoke), "/state", "/effects",
 *   "/effects/select", "/events", …; "/new" for pairing. A string must match exactly.
 * @property {string | RegExp} [body] A substring of (or a pattern for) the request body, for example '"select"'.
 */

/**
 * @typedef {object} FaultRequest
 * @property {string} method
 * @property {string} path As in `FaultMatch.path`.
 * @property {string} body
 */

/**
 * @typedef {object} FaultState
 * @property {{ action: "reset" | "hang" | number, left: number, match: object | null }[]} pending Unused rules.
 * @property {{ ms: number, match: object | null } | null} delay
 * @property {boolean} refuseExtControl
 * @property {boolean} dropFrames
 */

/**
 * @typedef {object} Emulator
 * @property {string} host
 * @property {number} port
 * @property {number} udpPort
 * @property {number | null} wallPort
 * @property {string | null} wallUrl
 * @property {number | null} ssdpPort
 * @property {string} url The REST base, `http://host:port`.
 * @property {Set<string>} tokens Live: add one to skip pairing.
 * @property {() => object} info The current `GET /` answer.
 * @property {(options?: { settled?: boolean, overlays?: boolean }) => Map<number, { rgb: number[], level: number }>}
 *   lights Each light panel's LED colour (before brightness) and level (brightness × power, 0–1), as displayed now.
 * @property {() => string} effect `effects.select`.
 * @property {() => boolean} on
 * @property {() => number} brightness 0–100.
 * @property {number} frames UDP frames applied.
 * @property {number} droppedFrames Frames dropped whole (malformed, or naming an unknown panel).
 * @property {number} ignoredFrames Frames that arrived outside extControl.
 * @property {number} lostFrames Frames lost to the `dropFrames` fault.
 * @property {() => string} layoutName
 * @property {(ms?: number) => number} openPairing Holds the power button; returns when the window closes.
 * @property {() => boolean} pressPower Toggles power; returns the new state.
 * @property {(name?: string) => string} selectEffect Like the Nanoleaf app; no name picks one at random.
 * @property {(next: string | object) => string} setLayout Rearranges the panels (SSE layout event).
 * @property {(panelId?: number, gesture?: number | string) => object} touch SSE touch event.
 * @property {() => void} identify
 * @property {() => object[]} requests The last 500 REST requests: method, path, status, body, reason. A request a fault
 *   dropped or held unanswered shows status 0.
 * @property {(spec?: FaultSpec | null) => FaultState} faults Injects failures (see `FaultSpec`); null clears them
 *   all, no argument just reads them.
 * @property {() => number} closeEvents Cuts every open event stream, like a Wi-Fi hiccup; returns how many. Clients
 *   reconnect (use `faults({ failNext, match: { path: "/events" } })` to make that fail too).
 * @property {(cb: (change: object) => void) => () => void} onChange
 *   Called with `{ kind: "state" | "effect" | "layout" | "touch" | "frame" | "drop" | "pairing" | "token" | … }`.
 * @property {() => Promise<void>} close Releases every port and ends every stream. Safe to call twice.
 */

/**
 * Starts an emulated controller and resolves once every port is bound. Port 0 means ephemeral (read the actual port
 * back from the result); `wallPort: null` skips the virtual wall page. `layout` is a name from `LAYOUTS`, a path to a
 * `GET /` JSON file, or a whole info object. Rejects (after releasing whatever it had bound) when a port is taken.
 *
 * @param {EmulatorOptions} [options]
 * @returns {Promise<Emulator>}
 */
export async function startEmulator(options = {}) {
  const {
    host = "127.0.0.1",
    port = 16021,
    wallPort = 16022,
    udpPort = 60222,
    layout = "mixed",
    pairing = "button",
    ssdp = false,
    ssdpPort = 1900,
    quiet = false,
    keepAliveMs = 0,
    now = Date.now,
    random = Math.random,
    brightnessTurnsOn = true,
    writesTurnOn = false,
    extControl = true,
  } = options;
  if (pairing !== "button" && pairing !== "open") throw new RangeError(`pairing must be "button" or "open"`);
  const say = quiet ? () => {} : (options.log ?? defaultLog);
  const { info, name } = resolveLayout(layout);
  if (options.serialNo !== undefined) info.serialNo = String(options.serialNo);
  const behaviour = { brightnessTurnsOn, writesTurnOn, extControl };
  const faults = new Faults();
  if (options.faults) faults.apply(options.faults);
  const device = new FakeController(info, name, { now, random, say, pairing, faults, ...behaviour });
  for (const token of options.tokens ?? []) device.tokens.add(String(token));

  let rest = null;
  let wall = null;
  let udp = null;
  let ssdpSocket = null;
  const timers = [];
  const release = () =>
    Promise.all([closeServer(rest), closeServer(wall), closeSocket(udp), closeSocket(ssdpSocket)]).then(() => {});
  try {
    rest = await listen(createServer(restHandler(device, say, faults)), port, host);
    udp = await bindUdp(udpPort, host, (message) => device.receiveFrame(message));
    if (wallPort !== null) wall = await listen(createServer(wallHandler(device, say)), wallPort, host);
  } catch (error) {
    await release();
    throw error;
  }
  const urlHost = hostForUrl(host);
  const actualPort = rest.address().port;
  const actualUdp = udp.address().port;
  const actualWall = wall ? wall.address().port : null;
  device.endpoints = { rest: `http://${urlHost}:${actualPort}`, udp: actualUdp };
  if (ssdp) {
    try {
      ssdpSocket = await startSsdp(device, { host, port: ssdpPort, restPort: actualPort, random, say });
    } catch (error) {
      say(`SSDP: couldn't listen on UDP ${ssdpPort} (${error.code ?? error.message}); carrying on without it`);
    }
  }
  if (keepAliveMs > 0) timers.push(setInterval(() => device.keepAlive(), keepAliveMs));
  timers.push(setInterval(() => device.summariseFrames(), UDP_SUMMARY_MS));
  for (const timer of timers) timer.unref();

  let closing = null;
  const close = () => {
    closing ??= (async () => {
      for (const timer of timers) clearInterval(timer);
      faults.dispose();
      device.dispose();
      await release();
    })();
    return closing;
  };

  return {
    host,
    port: actualPort,
    udpPort: actualUdp,
    wallPort: actualWall,
    wallUrl: actualWall === null ? null : `http://${urlHost}:${actualWall}/`,
    ssdpPort: ssdpSocket ? ssdpSocket.address().port : null,
    url: `http://${urlHost}:${actualPort}`,
    tokens: device.tokens,
    info: () => device.infoObject(),
    lights: (opts) => device.display.lights(opts),
    effect: () => device.select,
    on: () => device.on,
    brightness: () => device.brightness,
    get frames() {
      return device.frames;
    },
    get droppedFrames() {
      return device.dropped;
    },
    get ignoredFrames() {
      return device.ignored;
    },
    get lostFrames() {
      return device.lost;
    },
    layoutName: () => device.layoutName,
    openPairing: (ms = PAIRING_MS) => device.openPairing(ms),
    pressPower: () => device.pressPower(),
    selectEffect: (effect) => device.selectEffect(effect),
    setLayout: (next) => device.setLayout(next),
    touch: (panelId, gesture = 0) => device.touch(panelId, gesture),
    identify: () => device.identify(),
    requests: () => device.requests.slice(),
    faults: (spec) => {
      if (spec === null) faults.clear();
      else if (spec !== undefined) faults.apply(spec);
      return faults.snapshot();
    },
    closeEvents: () => device.closeEvents(),
    onChange(cb) {
      device.listeners.add(cb);
      return () => device.listeners.delete(cb);
    },
    close,
  };
}

/* ---- Layouts ---- */

/** A fixture or file's `GET /` object (deep-copied) and a name for it. */
function resolveLayout(layout) {
  if (typeof layout === "string") {
    const fixture = LAYOUTS[layout];
    if (fixture) return { info: readJson(new URL(`${fixture}.json`, FIXTURES_DIR)), name: layout };
    if (layout.endsWith(".json")) return { info: readJson(resolve(layout)), name: layout };
    throw new RangeError(`Unknown layout "${layout}": use ${Object.keys(LAYOUTS).join(", ")} or a .json file`);
  }
  if (isRecord(layout) && isRecord(layout.panelLayout)) return { info: structuredClone(layout), name: "custom" };
  throw new TypeError("layout must be a layout name, a .json path or a GET / info object with panelLayout");
}

function readJson(where) {
  return JSON.parse(readFileSync(where, "utf8"));
}

/* ---- The controller ---- */

/** Everything the controller knows and does, independent of sockets: state, effects, layout, frames, events. */
class FakeController {
  constructor(info, layoutName, options) {
    this.options = options;
    this.now = options.now;
    this.say = options.say;
    this.tokens = new Set();
    /** SSE subscribers: { ids: Set<number>, token, res }. */
    this.streams = new Set();
    /** onChange callbacks. */
    this.listeners = new Set();
    /** Wall page subscribers (see wallHandler). */
    this.viewers = new Set();
    this.requests = [];
    this.display = new Display(this.now);
    this.frames = 0;
    this.dropped = 0;
    this.ignored = 0;
    this.lost = 0;
    this.frameTimes = [];
    this.window = { frames: 0, dropped: 0, ignored: 0, reason: null };
    this.pairingUntil = 0;
    this.saved = new Map();
    this.staticAnimData = null;
    this.tempTimer = null;
    this.layoutVersion = 0;
    this.endpoints = { rest: null, udp: null };
    this.base = info;
    const state = isRecord(info.state) ? info.state : {};
    this.on = typeof valueOf(state.on) === "boolean" ? valueOf(state.on) : true;
    this.brightness = readRange(valueOf(state.brightness), "brightness", 100);
    this.hue = readRange(valueOf(state.hue), "hue", 0);
    this.sat = readRange(valueOf(state.sat), "sat", 0);
    this.ct = readRange(valueOf(state.ct), "ct", 4000);
    const mode = valueOf(state.colorMode);
    this.colorMode = mode === "hs" || mode === "ct" ? mode : "effect";
    const effects = isRecord(info.effects) ? info.effects : {};
    const list = Array.isArray(effects.effectsList) ? effects.effectsList.filter((e) => typeof e === "string") : [];
    this.effectsList = list.length > 0 ? list : [...DEFAULT_EFFECTS];
    this.select = typeof effects.select === "string" ? effects.select : this.effectsList[0];
    this.#applyLayout(info.panelLayout, layoutName);
    this.display.setLevel(this.brightness, this.on);
    this.#showSelect({ instant: true });
  }

  /* -- Reading -- */

  /** The whole `GET /` answer, keeping the fixture's other keys (discovery, schedules, …) in their order. */
  infoObject() {
    const out = {};
    for (const key of Object.keys(this.base)) out[key] = structuredClone(this.base[key]);
    out.effects = { effectsList: [...this.effectsList], select: this.select };
    out.panelLayout = structuredClone(this.panelLayout);
    out.state = this.stateObject();
    return out;
  }

  /** `GET /state`. */
  stateObject() {
    return {
      brightness: { value: this.brightness, max: 100, min: 0 },
      colorMode: this.colorMode,
      ct: { value: this.ct, max: 6500, min: 1200 },
      hue: { value: this.hue, max: 360, min: 0 },
      on: { value: this.on },
      sat: { value: this.sat, max: 100, min: 0 },
    };
  }

  pairingOpen() {
    return this.options.pairing === "open" || this.now() < this.pairingUntil;
  }

  /** extControl frames applied per second over the last two seconds. */
  fps() {
    const since = this.now() - FPS_WINDOW_MS;
    while (this.frameTimes.length > 0 && this.frameTimes[0] < since) this.frameTimes.shift();
    return this.frameTimes.length / (FPS_WINDOW_MS / 1000);
  }

  /** The layout name "Rearrange" moves to next. */
  nextLayoutName() {
    const names = Object.keys(LAYOUTS);
    return names[(names.indexOf(this.layoutName) + 1) % names.length];
  }

  /* -- Physical buttons and the Nanoleaf app -- */

  /** Holding the power button: opens the pairing window and flashes the panels. */
  openPairing(ms = PAIRING_MS) {
    this.pairingUntil = this.now() + ms;
    this.display.flash(3, 1500);
    this.say(`Pairing window open for ${Math.round(ms / 1000)} s`);
    this.#notify({ kind: "pairing", until: this.pairingUntil });
    return this.pairingUntil;
  }

  /** A short press of the power button: toggles the wall. */
  pressPower() {
    this.#commitState({ ...this.#stateFields(), on: !this.on }, {});
    this.say(`Power ${this.on ? "on" : "off"} (button)`);
    return this.on;
  }

  /**
   * Picks a named effect, as the Nanoleaf app does: it ends any stream or display, turns the wall on and sends an
   * effects event. Without a name it picks a different effect at random. Throws for a name not in the list.
   */
  selectEffect(name) {
    let effect = name;
    if (effect === undefined || effect === null) {
      const others = this.effectsList.filter((e) => e !== this.select);
      const pool = others.length > 0 ? others : this.effectsList;
      effect = pool[Math.floor(this.options.random() * pool.length) % pool.length];
    }
    if (!this.effectsList.includes(effect)) throw new RangeError(`No effect named "${effect}"`);
    this.#cancelTemp();
    this.display.generate({ kind: "effect", palette: this.#paletteOf(effect) });
    this.#enterEffect(effect, { turnOn: true, always: true });
    return effect;
  }

  /** Someone rearranged the panels: replaces the layout and sends a layout event. */
  setLayout(next) {
    const { info, name } = resolveLayout(next);
    const before = this.panelLayout.globalOrientation.value;
    this.#applyLayout(info.panelLayout, name);
    const events = [{ attr: 1, value: structuredClone(this.panelLayout.layout) }];
    const after = this.panelLayout.globalOrientation.value;
    if (after !== before) events.push({ attr: 2, value: after });
    this.#emit(2, events);
    this.say(`Layout: ${name} (${this.placed.panels.length} panels)`);
    this.#notify({ kind: "layout", name });
    return name;
  }

  /**
   * A touch on the wall: SSE event 4. Swipes (2–5) aren't tied to a panel, so they report panelId -1; a tap without
   * a panel id lands on a random light panel.
   */
  touch(panelId, gesture = 0) {
    const g = typeof gesture === "string" ? GESTURES.indexOf(gesture) : gesture;
    if (!Number.isInteger(g) || g < 0 || g >= GESTURES.length) throw new RangeError(`Unknown gesture ${gesture}`);
    const panels = this.placed.panels;
    const id = Number.isInteger(panelId)
      ? panelId
      : (panels[Math.floor(this.options.random() * panels.length) % Math.max(panels.length, 1)]?.id ?? -1);
    const entry = { gesture: g, panelId: g >= 2 ? -1 : id };
    this.#emit(4, [entry]);
    this.say(`Touch: ${GESTURES[g]}${entry.panelId >= 0 ? ` on ${entry.panelId}` : ""}`);
    this.#notify({ kind: "touch", ...entry });
    return entry;
  }

  /** `PUT /identify`: flashes the whole wall. */
  identify() {
    this.display.flash(3, 1800);
    this.#notify({ kind: "identify" });
  }

  /* -- REST semantics: each returns { status, body?, reason? } -- */

  /** `POST /api/v1/new`. */
  pair() {
    if (!this.pairingOpen()) return fail(403, "the pairing window is closed: hold the power button first");
    let token = "";
    for (let i = 0; i < 32; i++) token += TOKEN_ALPHABET[Math.floor(this.options.random() * TOKEN_ALPHABET.length)];
    this.tokens.add(token);
    this.#notify({ kind: "token", token, added: true });
    return ok(200, { auth_token: token });
  }

  /** `DELETE /api/v1/<token>`: forgets it and ends its event streams. */
  revoke(token) {
    this.tokens.delete(token);
    for (const stream of this.streams) if (stream.token === token) stream.res.end();
    this.#notify({ kind: "token", token, added: false });
    return ok(204);
  }

  /** `PUT /state`. */
  putState(body) {
    if (!isRecord(body)) return fail(400, "PUT /state takes a JSON object");
    const keys = Object.keys(body).filter((key) => STATE_KEYS.includes(key));
    if (keys.length === 0) return fail(400, "PUT /state needs on, brightness, hue, sat or ct");
    const next = this.#stateFields();
    let durationMs = null;
    let colour = false;
    for (const key of keys) {
      const field = body[key];
      if (!isRecord(field)) return fail(422, `${key} takes {value} or {increment}`);
      if (key === "on") {
        if (typeof field.value !== "boolean") return fail(422, "on.value must be true or false");
        next.on = field.value;
        continue;
      }
      let value;
      if (finite(field.value)) value = field.value;
      else if (finite(field.increment)) value = next[key] + field.increment;
      else return fail(422, `${key} needs a numeric value or increment`);
      next[key] = clampRange(value, key);
      if (key === "brightness") {
        if (field.duration !== undefined && !(finite(field.duration) && field.duration >= 0)) {
          return fail(422, "brightness.duration is in seconds, 0 or more");
        }
        if (finite(field.duration)) durationMs = field.duration * 1000;
        if (finite(field.value) && !("on" in body) && this.options.brightnessTurnsOn) next.on = true;
      } else {
        next.colorMode = key === "ct" ? "ct" : "hs";
        colour = true;
      }
    }
    this.#commitState(next, { durationMs, colour });
    return ok(204);
  }

  /** `PUT /effects`: `{select}` or `{write}`. */
  putEffects(body) {
    if (!isRecord(body)) return fail(400, "PUT /effects takes a JSON object");
    if (typeof body.select === "string") {
      if (!this.effectsList.includes(body.select)) return fail(404, `no effect named "${body.select}"`);
      this.selectEffect(body.select);
      return ok(204);
    }
    if ("write" in body) return this.#write(body.write);
    return fail(400, "PUT /effects needs select or write");
  }

  /** `PUT /panelLayout {globalOrientation: {value}}`. */
  putPanelLayout(body) {
    const value = isRecord(body) && isRecord(body.globalOrientation) ? body.globalOrientation.value : undefined;
    if (!finite(value)) return fail(422, "PUT /panelLayout takes {globalOrientation: {value}}");
    const orientation = Math.min(360, Math.max(0, Math.round(value)));
    const panelLayout = { ...this.panelLayout, globalOrientation: { value: orientation, max: 360, min: 0 } };
    this.#applyLayout(panelLayout, this.layoutName);
    this.#emit(2, [{ attr: 2, value: orientation }]);
    this.#notify({ kind: "layout", name: this.layoutName });
    return ok(204);
  }

  /* -- UDP -- */

  /** One extControl v2 datagram: applied, ignored (not streaming), or dropped whole (malformed or an unknown id). */
  receiveFrame(bytes) {
    if (this.options.faults.dropFrames) {
      this.lost++;
      return "lost";
    }
    if (this.select !== "*ExtControl*") {
      this.ignored++;
      this.window.ignored++;
      return "ignored";
    }
    let panels;
    try {
      panels = decodeExtControlV2(bytes);
    } catch (error) {
      return this.#drop(`malformed: ${error.message}`);
    }
    const unknown = panels.find((panel) => !this.lightIds.has(panel.id));
    if (unknown) return this.#drop(`unknown panel ${unknown.id}`);
    this.display.paint(panels.map((panel) => [panel.id, panel.rgb, panel.transitionDs * 100]));
    this.frames++;
    this.window.frames++;
    this.frameTimes.push(this.now());
    this.#notify({ kind: "frame", panels: panels.length });
    return "applied";
  }

  /** Logs the last few seconds of UDP traffic, if there was any. */
  summariseFrames() {
    const { frames, dropped, ignored, reason } = this.window;
    if (frames + dropped + ignored === 0) return;
    const seconds = UDP_SUMMARY_MS / 1000;
    const parts = [`${frames} frames in ${seconds} s (${(frames / seconds).toFixed(1)} fps)`];
    if (dropped > 0) parts.push(`${dropped} dropped (last: ${reason})`);
    if (ignored > 0) parts.push(`${ignored} ignored (not in extControl)`);
    this.say(`UDP ${this.endpoints.udp}: ${parts.join(", ")}`);
    this.window = { frames: 0, dropped: 0, ignored: 0, reason: null };
  }

  /* -- SSE -- */

  /** Sends a comment to every event stream so proxies and idle timers see traffic. */
  keepAlive() {
    for (const stream of this.streams) write(stream.res, ": keep-alive\n\n");
  }

  /** Cuts every event stream without a clean end (a network hiccup); returns how many there were. */
  closeEvents() {
    const count = this.streams.size;
    for (const stream of this.streams) stream.res.destroy();
    this.streams.clear();
    if (count > 0) this.say(`Cut ${count} event stream${count === 1 ? "" : "s"} (fault)`);
    return count;
  }

  /** Stops timers and ends every stream (close()). */
  dispose() {
    this.#cancelTemp();
    for (const stream of this.streams) stream.res.end();
    for (const viewer of this.viewers) viewer.res.end();
    this.streams.clear();
    this.viewers.clear();
  }

  /* -- Internals -- */

  #stateFields() {
    const { on, brightness, hue, sat, ct, colorMode } = this;
    return { on, brightness, hue, sat, ct, colorMode };
  }

  /** Applies new state fields, then sends one state event (and an effects event when it becomes `*Solid*`). */
  #commitState(next, { durationMs = null, colour = false }) {
    const changed = STATE_ATTRS.filter(([, key]) => next[key] !== this[key]).map(([attr, key]) => ({
      attr,
      value: next[key],
    }));
    if (next.brightness !== this.brightness || durationMs !== null) {
      this.display.setBrightness(next.brightness, durationMs ?? BRIGHTNESS_EASE_MS);
    }
    if (next.on !== this.on) this.display.setPower(next.on);
    Object.assign(this, next);
    if (colour) {
      this.#cancelTemp();
      this.display.generate({ kind: "solid", rgb: this.#solidRgb() });
    }
    if (changed.length > 0) {
      this.#emit(1, changed);
      this.#notify({ kind: "state", changed });
    }
    if (colour) this.#setSelect("*Solid*", false);
  }

  /** Switches to an effect-mode scene: colorMode `effect`, optionally on, then the effects event. */
  #enterEffect(name, { turnOn = false, always = false }) {
    const changed = [];
    if (turnOn && !this.on) {
      this.on = true;
      this.display.setPower(true);
      changed.push({ attr: 1, value: true });
    }
    if (this.colorMode !== "effect") {
      this.colorMode = "effect";
      changed.push({ attr: 6, value: "effect" });
    }
    if (changed.length > 0) {
      this.#emit(1, changed);
      this.#notify({ kind: "state", changed });
    }
    this.#setSelect(name, always);
  }

  #setSelect(name, always) {
    if (name === this.select && !always) return;
    const previous = this.select;
    this.select = name;
    this.#emit(3, [{ attr: 1, value: name }]);
    if (name !== previous) this.say(`Effect: ${previous} → ${name}`);
    this.#notify({ kind: "effect", name, previous });
  }

  /** Draws whatever `select` says, for startup and for reverting a `displayTemp`. */
  #showSelect({ instant = false } = {}) {
    const select = this.select;
    if (select === "*Solid*") this.display.generate({ kind: "solid", rgb: this.#solidRgb() }, instant);
    else if (select === "*ExtControl*") this.display.hold();
    else if (select === "*Static*") {
      this.staticAnimData ??= this.#defaultStatic();
      this.#paintStatic(parseAnimData(this.staticAnimData));
    } else this.display.generate({ kind: "effect", palette: this.#paletteOf(select) }, instant);
  }

  #solidRgb() {
    return this.colorMode === "ct" ? kelvinRgb(this.ct) : hsvRgb(this.hue, this.sat / 100);
  }

  #paletteOf(name) {
    const saved = this.saved.get(name);
    return paletteFromHsb(saved?.palette) ?? paletteFor(name);
  }

  /** A warm gradient across the wall, for a fixture that starts on `*Static*` without animData. */
  #defaultStatic() {
    const ids = this.placed.panels.map((panel) => panel.id);
    const parts = ids.map((id, i) => {
      const [r, g, b] = hsvRgb(20 + (30 * i) / Math.max(ids.length - 1, 1), 0.8);
      return `${id} 1 ${r} ${g} ${b} 0 5`;
    });
    return `${ids.length} ${parts.join(" ")}`.trim();
  }

  #paintStatic(parsed) {
    const entries = [];
    for (const [id, frames] of parsed) {
      const frame = frames[0];
      if (!this.lightIds.has(id) || !frame) continue;
      entries.push([id, [frame.r, frame.g, frame.b], Math.max(frame.t, 0) * 100]);
    }
    this.display.paint(entries, UNLISTED_OFF_MS);
  }

  /** `PUT /effects {write}`. */
  #write(command) {
    if (!isRecord(command)) return fail(400, "write takes an object");
    switch (command.command) {
      case "display":
      case "displayTemp":
        return this.#display(command);
      case "add": {
        if (typeof command.animName !== "string" || command.animName === "") return fail(422, "add needs animName");
        const { command: _, ...definition } = command;
        this.saved.set(command.animName, definition);
        if (!this.effectsList.includes(command.animName)) this.effectsList.push(command.animName);
        return ok(204);
      }
      case "request":
        return this.#request(command.animName);
      case "requestAll":
        return ok(200, { animations: this.effectsList.map((name) => this.#definition(name)) });
      case "delete": {
        const index = this.effectsList.indexOf(command.animName);
        if (index < 0) return fail(404, `no effect named "${command.animName}"`);
        this.effectsList.splice(index, 1);
        this.saved.delete(command.animName);
        return ok(204);
      }
      case "rename": {
        const index = this.effectsList.indexOf(command.animName);
        if (index < 0 || typeof command.newName !== "string") return fail(404, "rename needs animName and newName");
        this.effectsList[index] = command.newName;
        if (this.select === command.animName) this.select = command.newName;
        return ok(204);
      }
      default:
        return fail(400, `unknown write command ${JSON.stringify(command.command)}`);
    }
  }

  #display(command) {
    const temp = command.command === "displayTemp";
    if (temp && !(finite(command.duration) && command.duration > 0)) {
      return fail(422, "displayTemp needs a duration in seconds");
    }
    const previous = { select: this.select, staticAnimData: this.staticAnimData };
    const turnOn = this.options.writesTurnOn;
    const { animType } = command;
    if (animType === "extControl") {
      if (command.extControlVersion !== "v2") {
        return fail(400, 'Shapes stream extControl v2 only: add extControlVersion "v2"');
      }
      if (!this.options.extControl || this.options.faults.refuseExtControl) {
        return fail(400, "extControl is switched off in this emulator (extControl: false or refuseExtControl)");
      }
      this.#cancelTemp();
      this.display.hold();
      this.#enterEffect("*ExtControl*", { turnOn });
      return ok(204);
    }
    if (animType === "static" || animType === "custom") {
      if (typeof command.animData !== "string") return fail(422, "animData must be a string");
      let parsed;
      try {
        parsed = parseAnimData(command.animData);
      } catch (error) {
        return fail(422, error.message);
      }
      this.#cancelTemp();
      if (animType === "static") {
        this.staticAnimData = command.animData.trim().split(/\s+/).join(" ");
        this.#paintStatic(parsed);
        this.#enterEffect("*Static*", { turnOn });
      } else {
        const frames = new Map();
        for (const [id, list] of parsed) {
          if (!this.lightIds.has(id)) continue;
          frames.set(id, list.map((f) => ({ rgb: [f.r, f.g, f.b], ms: Math.max(f.t, 0) * 100 })));
        }
        this.display.generate({ kind: "custom", frames, loop: command.loop === true });
        this.#enterEffect("*Dynamic*", { turnOn });
      }
    } else if (typeof animType === "string" && animType !== "") {
      this.#cancelTemp();
      this.display.generate({ kind: "effect", palette: paletteFromHsb(command.palette) ?? paletteFor(animType) });
      this.#enterEffect("*Dynamic*", { turnOn });
    } else {
      return fail(422, "display needs animType");
    }
    if (temp) {
      this.tempTimer = setTimeout(() => {
        this.tempTimer = null;
        this.staticAnimData = previous.staticAnimData;
        this.#setSelect(previous.select, false);
        this.#showSelect();
      }, command.duration * 1000);
      this.tempTimer.unref();
    }
    return ok(204);
  }

  /**
   * `write {command: "request"}`. `*Static*` returns the static scene while one shows; like the device (openHAB's
   * reports), it answers 400 while a dynamic effect runs and 404 when there is no static scene.
   */
  #request(name) {
    if (name === "*Static*") {
      if (this.select === "*Static*" && this.staticAnimData) {
        return ok(200, {
          animName: "*Static*",
          animType: "static",
          colorType: "HSB",
          animData: this.staticAnimData,
          palette: [],
          loop: false,
          version: "2.0",
        });
      }
      const dynamic = this.select === "*Dynamic*" || !/^\*.*\*$/.test(this.select);
      return dynamic ? fail(400, "a dynamic effect is running") : fail(404, "there is no static scene");
    }
    if (typeof name !== "string" || !this.effectsList.includes(name)) return fail(404, `no effect named "${name}"`);
    return ok(200, this.#definition(name));
  }

  #definition(name) {
    const saved = this.saved.get(name);
    if (saved) return { animName: name, ...saved };
    return {
      animName: name,
      animType: "plugin",
      colorType: "HSB",
      palette: paletteHsb(name),
      pluginType: "color",
      pluginUuid: uuidFrom(`effect:${name}`),
      loop: true,
      version: "2.0",
    };
  }

  #cancelTemp() {
    if (this.tempTimer) clearTimeout(this.tempTimer);
    this.tempTimer = null;
  }

  #drop(reason) {
    this.dropped++;
    this.window.dropped++;
    this.window.reason = reason;
    this.#notify({ kind: "drop", reason });
    return "dropped";
  }

  #applyLayout(raw, name) {
    const panelLayout = isRecord(raw) ? raw : {};
    const layout = isRecord(panelLayout.layout) ? panelLayout.layout : {};
    const positionData = Array.isArray(layout.positionData) ? structuredClone(layout.positionData) : [];
    const orientation = valueOf(panelLayout.globalOrientation);
    this.panelLayout = {
      globalOrientation: { value: finite(orientation) ? orientation : 0, max: 360, min: 0 },
      layout: {
        numPanels: positionData.length,
        sideLength: finite(layout.sideLength) ? layout.sideLength : 0,
        positionData,
      },
    };
    const id = typeof this.base.serialNo === "string" ? this.base.serialNo : "emulator";
    this.placed = placeLayout(layoutFromPanelLayout(this.panelLayout, id, new Date(0).toISOString()));
    this.lightIds = new Set(this.placed.panels.map((panel) => panel.id));
    this.display.setPanels(this.placed);
    this.layoutName = name;
    this.layoutVersion++;
  }

  #emit(id, events) {
    const text = `id: ${id}\ndata: ${JSON.stringify({ events })}\n\n`;
    for (const stream of this.streams) if (stream.ids.has(id)) write(stream.res, text);
  }

  #notify(change) {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        this.say(`An onChange listener failed: ${error?.message ?? error}`);
      }
    }
  }
}

/* ---- What the panels show ---- */

/**
 * The panels' light over time. Each panel's LED colour comes from the current scene: per-panel transitions for
 * static displays and extControl frames, or a generated scene (solid colour, named effect, custom animation) that
 * crossfades in. Global brightness and power multiply everything as a level; identify and pairing flash on top.
 */
class Display {
  constructor(now) {
    this.now = now;
    this.panels = [];
    this.phase = new Map();
    this.mode = { kind: "solid", rgb: OFF };
    this.since = now();
    this.start = new Map();
    this.tracks = new Map();
    this.bright = still(100, now());
    this.power = still(1, now());
    this.flashAt = -Infinity;
    this.flashMs = 0;
    this.flashes = 1;
  }

  /** New layout: panels that stay keep their light; each gets a phase for effects that sweep across the wall. */
  setPanels(placed) {
    this.panels = placed.panels;
    const { minX, minY, maxX, maxY } = placed.bounds;
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    this.phase = new Map(
      this.panels.map((panel) => {
        const [x, y] = panel.center;
        const jitter = (((panel.id * 2654435761) >>> 0) % 1000) / 1000;
        return [panel.id, (0.45 * (x - minX)) / spanX + (0.3 * (y - minY)) / spanY + 0.08 * jitter];
      }),
    );
  }

  setLevel(brightness, on) {
    const t = this.now();
    this.bright = still(brightness, t);
    this.power = still(on ? 1 : 0, t);
  }

  setBrightness(value, ms) {
    this.bright = retarget(this.bright, value, ms, this.now());
  }

  setPower(on) {
    this.power = retarget(this.power, on ? 1 : 0, POWER_FADE_MS, this.now());
  }

  /** Blinks the whole wall `count` times over `ms`. */
  flash(count, ms) {
    this.flashAt = this.now();
    this.flashMs = ms;
    this.flashes = count;
  }

  /** Switches to a generated scene, crossfading from what shows now (or at once). */
  generate(mode, instant = false) {
    const t = this.now();
    this.start = instant ? new Map() : this.#capture(t);
    this.tracks.clear();
    this.mode = mode;
    this.since = instant ? t - MODE_FADE_MS : t;
  }

  /** Switches to per-panel transitions, each panel holding its current colour (entering extControl). */
  hold() {
    const t = this.now();
    const current = this.#capture(t);
    this.tracks = new Map([...current].map(([id, rgb]) => [id, { from: rgb, to: rgb, t0: t, ms: 0 }]));
    this.mode = { kind: "tracks" };
    this.since = t;
  }

  /** Per-panel transitions: `[id, rgb, ms]` entries; with `unlistedMs`, every other panel fades off. */
  paint(entries, unlistedMs = null) {
    if (this.mode.kind !== "tracks") this.hold();
    const t = this.now();
    const listed = new Set();
    for (const [id, rgb, ms] of entries) {
      listed.add(id);
      this.tracks.set(id, { from: this.#colour(id, t), to: [...rgb], t0: t, ms });
    }
    if (unlistedMs === null) return;
    for (const panel of this.panels) {
      if (listed.has(panel.id)) continue;
      this.tracks.set(panel.id, { from: this.#colour(panel.id, t), to: OFF, t0: t, ms: unlistedMs });
    }
  }

  /**
   * Each light panel's LED colour (integers 0–255, before brightness) and level (global brightness × power, 0–1).
   * `settled` gives where every transition is heading instead of where it is now; `overlays` adds the identify and
   * pairing flashes (cosmetic, so tests reading colours right after pairing aren't thrown by them).
   */
  lights({ settled = false, overlays = false } = {}) {
    const t = this.now();
    const flash = settled || !overlays ? 0 : this.#flashAmount(t);
    const base = settled ? (this.bright.to / 100) * this.power.to : this.level(t);
    const out = new Map();
    for (const panel of this.panels) {
      let rgb = settled ? this.#target(panel.id, t) : this.#colour(panel.id, t);
      let level = base;
      if (flash > 0) {
        rgb = mix(rgb, WHITE, flash);
        level = Math.max(level, flash);
      }
      out.set(panel.id, { rgb: rgb.map((c) => Math.round(c)), level: Math.round(level * 10_000) / 10_000 });
    }
    return out;
  }

  /** Global brightness × power, 0–1, at `t`. */
  level(t) {
    return (numberAt(this.bright, t) / 100) * numberAt(this.power, t);
  }

  #capture(t) {
    return new Map(this.panels.map((panel) => [panel.id, this.#colour(panel.id, t)]));
  }

  #colour(id, t) {
    const mode = this.mode;
    if (mode.kind === "tracks") return trackAt(this.tracks.get(id), t);
    const from = this.start.get(id) ?? OFF;
    if (mode.kind === "custom") {
      const frames = mode.frames.get(id);
      if (frames) return customAt(frames, from, t - this.since, mode.loop);
      return mix(from, OFF, (t - this.since) / MODE_FADE_MS);
    }
    return mix(from, this.#generated(id, t), easeInOut((t - this.since) / MODE_FADE_MS));
  }

  #target(id, t) {
    const mode = this.mode;
    if (mode.kind === "tracks") return this.tracks.get(id)?.to ?? OFF;
    if (mode.kind === "custom") {
      const frames = mode.frames.get(id);
      return frames ? customAt(frames, this.start.get(id) ?? OFF, t - this.since, mode.loop) : OFF;
    }
    return this.#generated(id, t);
  }

  #generated(id, t) {
    const mode = this.mode;
    if (mode.kind === "solid") return mode.rgb;
    return paletteAt(mode.palette, t / EFFECT_PERIOD_MS + (this.phase.get(id) ?? 0));
  }

  #flashAmount(t) {
    const elapsed = t - this.flashAt;
    if (elapsed < 0 || elapsed >= this.flashMs) return 0;
    return 0.5 - 0.5 * Math.cos((2 * Math.PI * elapsed * this.flashes) / this.flashMs);
  }
}

function still(value, t) {
  return { from: value, to: value, t0: t, ms: 0 };
}

function retarget(track, value, ms, t) {
  return { from: numberAt(track, t), to: value, t0: t, ms };
}

function numberAt(track, t) {
  if (track.ms <= 0 || t >= track.t0 + track.ms) return track.to;
  if (t <= track.t0) return track.from;
  return track.from + ((track.to - track.from) * (t - track.t0)) / track.ms;
}

function trackAt(track, t) {
  if (!track) return OFF;
  if (track.ms <= 0 || t >= track.t0 + track.ms) return track.to;
  return mix(track.from, track.to, (t - track.t0) / track.ms);
}

/** A custom animation: from the previous colour into each frame over its transition, looping when asked. */
function customAt(frames, from, elapsed, loop) {
  let previous = from;
  let rest = Math.max(elapsed, 0);
  for (const frame of frames) {
    if (rest < frame.ms) return mix(previous, frame.rgb, rest / frame.ms);
    rest -= frame.ms;
    previous = frame.rgb;
  }
  const cycle = frames.reduce((sum, frame) => sum + frame.ms, 0);
  if (!loop || cycle <= 0) return previous;
  rest %= cycle;
  for (const frame of frames) {
    if (rest < frame.ms) return mix(previous, frame.rgb, rest / frame.ms);
    rest -= frame.ms;
    previous = frame.rgb;
  }
  return previous;
}

/* ---- Colour ---- */

function mix(a, b, t) {
  const u = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

function easeInOut(t) {
  const u = Math.min(1, Math.max(0, t));
  return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
}

/** HSV (hue in degrees, saturation 0–1, full value) to LED RGB. */
function hsvRgb(hue, sat, value = 1) {
  const channel = (n) => {
    const k = (n + hue / 60) % 6;
    return value - value * sat * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [channel(5), channel(3), channel(1)].map((c) => Math.round(c * 255));
}

/** A colour temperature in kelvin as RGB (Tanner Helland's fit). */
function kelvinRgb(kelvin) {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((c) => Math.min(255, Math.max(0, Math.round(c))));
}

/** A named effect's palette as [hue, saturation] pairs: by keyword, else three hues derived from the name. */
function paletteHsbPairs(name) {
  for (const [pattern, pairs] of PALETTES) if (pattern.test(name)) return pairs;
  const hue = hashOf(name) % 360;
  return [
    [hue, 100],
    [(hue + 40) % 360, 90],
    [(hue + 200) % 360, 80],
  ];
}

function paletteFor(name) {
  return paletteHsbPairs(name).map(([hue, sat]) => hsvRgb(hue, sat / 100));
}

function paletteHsb(name) {
  return paletteHsbPairs(name).map(([hue, saturation]) => ({ hue, saturation, brightness: 100 }));
}

/** An effect definition's `palette` ([{hue, saturation, brightness}]) as RGB, or null when there's none. */
function paletteFromHsb(palette) {
  if (!Array.isArray(palette)) return null;
  const colours = palette
    .filter((entry) => isRecord(entry) && finite(entry.hue))
    .map((entry) => {
      const sat = finite(entry.saturation) ? entry.saturation / 100 : 1;
      const value = finite(entry.brightness) ? entry.brightness / 100 : 1;
      return hsvRgb(entry.hue, sat, value);
    });
  return colours.length > 0 ? colours : null;
}

/** A point on a looping palette: `position` in cycles, smoothly blended between neighbouring colours. */
function paletteAt(palette, position) {
  const n = palette.length;
  if (n === 1) return palette[0];
  const f = (((position % 1) + 1) % 1) * n;
  const i = Math.floor(f);
  return mix(palette[i % n], palette[(i + 1) % n], easeInOut(f - i));
}

/**
 * How an LED colour at a brightness level looks on a screen, as hex. The emulated controller maps RGB and brightness
 * perceptually, as the real one most likely does (nanoleaf-api.md §11.13), so 128 at 100% looks half as bright as 255:
 * the value goes to the screen as it is, scaled by the level.
 */
function screenHex(light) {
  if (!light) return "000000";
  return light.rgb
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c * light.level)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
}

function hashOf(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

/** A stable UUID-shaped string for a name (SSDP USN, effect plugin ids). */
function uuidFrom(name) {
  const hex = createHash("sha1").update(name).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/* ---- REST ---- */

/** The controller's REST API (nanoleaf-api.md §2, §3, §6) as a node:http request handler, with `faults` applied. */
function restHandler(device, say, faults) {
  return (req, res) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const request = { method: req.method ?? "GET", path: apiPath(req.url ?? "/"), body: text };
      const handle = () => {
        let answer;
        try {
          const fault = faults.take(request);
          if (fault === "reset" || fault === "hang") {
            if (fault === "reset") req.socket.destroy();
            logRequest(device, say, req, text, { status: 0, reason: `fault: ${fault}` });
            return;
          }
          if (fault !== null) answer = fail(fault, `fault: injected ${fault}`);
          else answer = size > MAX_BODY ? fail(413, "body too large") : route(device, say, req, res, text);
        } catch (error) {
          answer = fail(500, `emulator bug: ${error?.stack ?? error}`);
        }
        if (answer === null) return;
        respond(res, answer);
        logRequest(device, say, req, text, answer);
      };
      let delayMs = 0;
      try {
        delayMs = faults.delayFor(request);
      } catch (error) {
        say(`A fault matcher failed: ${error?.message ?? error}`);
      }
      faults.after(delayMs, handle);
    });
  };
}

/** A request's path for fault matching: what follows `/api/v1/<token>` ("/" for the token itself), or "/new". */
function apiPath(rawUrl) {
  const url = new URL(rawUrl, "http://nanoleaf");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "v1") return url.pathname;
  if (parts[2] === "new" && parts.length === 3) return "/new";
  return `/${parts.slice(3).join("/")}`;
}

/* ---- Injected failures ---- */

/** The fault rules and switches behind `emu.faults()` (see `FaultSpec`). */
class Faults {
  constructor() {
    this.timers = new Set();
    this.disposed = false;
    this.clear();
  }

  clear() {
    /** { match, action: "reset" | "hang" | status, left } in the order they were added. */
    this.rules = [];
    this.delay = null;
    this.refuseExtControl = false;
    this.dropFrames = false;
  }

  /** @param {FaultSpec} spec */
  apply(spec) {
    if (!isRecord(spec)) throw new TypeError("faults takes an object, or null to clear them");
    const match = spec.match ?? null;
    const text = (value) => value === undefined || typeof value === "string" || value instanceof RegExp;
    const method = (value) => value === undefined || typeof value === "string";
    const valid =
      match === null ||
      typeof match === "function" ||
      (isRecord(match) && method(match.method) && text(match.path) && text(match.body));
    if (!valid) throw new TypeError("faults: match is {method?, path?, body?} (strings or RegExps) or a function");
    const status = spec.failStatus ?? 503;
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new RangeError("faults: bad failStatus");
    const counters = [
      ["dropNext", "reset"],
      ["hangNext", "hang"],
      ["failNext", status],
    ].filter(([key]) => spec[key] !== undefined);
    for (const [key] of counters) {
      const count = spec[key];
      if (!(count === Infinity || (Number.isInteger(count) && count >= 0))) {
        throw new RangeError(`faults: ${key} must be a count`);
      }
    }
    if (spec.delayMs !== undefined && !(finite(spec.delayMs) && spec.delayMs >= 0)) {
      throw new RangeError("faults: delayMs must be 0 or more");
    }
    for (const [key, action] of counters) if (spec[key] > 0) this.rules.push({ match, action, left: spec[key] });
    if (spec.delayMs !== undefined) this.delay = spec.delayMs > 0 ? { ms: spec.delayMs, match } : null;
    if (spec.refuseExtControl !== undefined) this.refuseExtControl = spec.refuseExtControl === true;
    if (spec.dropFrames !== undefined) this.dropFrames = spec.dropFrames === true;
  }

  /** The fault for this request, using up one count of the first rule that matches; null to handle it normally. */
  take(request) {
    const rule = this.rules.find((candidate) => candidate.left > 0 && matches(candidate.match, request));
    if (!rule) return null;
    rule.left--;
    if (rule.left === 0) this.rules.splice(this.rules.indexOf(rule), 1);
    return rule.action;
  }

  delayFor(request) {
    return this.delay && matches(this.delay.match, request) ? this.delay.ms : 0;
  }

  /** Runs `fn` now, or after `ms` unless the emulator closes first. */
  after(ms, fn) {
    if (ms <= 0) {
      fn();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(timer);
  }

  /** @returns {FaultState} */
  snapshot() {
    return {
      pending: this.rules.map(({ action, left, match }) => ({ action, left, match })),
      delay: this.delay ? { ...this.delay } : null,
      refuseExtControl: this.refuseExtControl,
      dropFrames: this.dropFrames,
    };
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

function matches(match, request) {
  if (match === null) return true;
  if (typeof match === "function") return match(request) === true;
  if (match.method !== undefined && match.method.toUpperCase() !== request.method.toUpperCase()) return false;
  if (match.path !== undefined && !textMatches(match.path, request.path, true)) return false;
  if (match.body !== undefined && !textMatches(match.body, request.body, false)) return false;
  return true;
}

function textMatches(pattern, text, exact) {
  if (pattern instanceof RegExp) return pattern.test(text);
  return exact ? text === pattern : text.includes(pattern);
}

/** Routes one request; null when the handler took over the response (the event stream). */
function route(device, say, req, res, text) {
  const url = new URL(req.url ?? "/", "http://nanoleaf");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "v1") return fail(404, "not an OpenAPI path");
  const method = req.method ?? "GET";
  if (parts[2] === "new" && parts.length === 3) {
    return method === "POST" ? device.pair() : fail(405, "POST /api/v1/new to pair");
  }
  const token = parts[2] === undefined ? "" : safeDecode(parts[2]);
  if (!device.tokens.has(token)) return fail(401, "unknown token");
  const path = `/${parts.slice(3).join("/")}`;
  let body;
  if (method === "PUT") {
    try {
      body = text.trim() === "" ? undefined : JSON.parse(text);
    } catch {
      return fail(400, "the body isn't JSON");
    }
  }
  if (path === "/") {
    if (method === "GET") return ok(200, device.infoObject());
    if (method === "DELETE") return device.revoke(token);
    return fail(405, "GET or DELETE");
  }
  const key = `${method} ${path}`;
  if (method === "GET" && path.startsWith("/state/")) {
    const state = device.stateObject();
    const field = path.slice("/state/".length);
    return Object.hasOwn(state, field) ? ok(200, state[field]) : fail(404, `no state ${field}`);
  }
  switch (key) {
    case "GET /state":
      return ok(200, device.stateObject());
    case "PUT /state":
      return device.putState(body);
    case "GET /effects":
      return ok(200, { effectsList: [...device.effectsList], select: device.select });
    case "GET /effects/select":
      return ok(200, device.select);
    case "GET /effects/effectsList":
      return ok(200, [...device.effectsList]);
    case "PUT /effects":
      return device.putEffects(body);
    case "GET /panelLayout":
      return ok(200, structuredClone(device.panelLayout));
    case "GET /panelLayout/layout":
      return ok(200, structuredClone(device.panelLayout.layout));
    case "GET /panelLayout/globalOrientation":
      return ok(200, { ...device.panelLayout.globalOrientation });
    case "PUT /panelLayout":
      return device.putPanelLayout(body);
    case "PUT /identify":
      device.identify();
      return ok(204);
    case "GET /events":
      return openEvents(device, say, req, res, token, url.searchParams.get("id"));
    default:
      return fail(404, `no ${key}`);
  }
}

/** `GET /events?id=…`: keeps the response open and registers it for the event types asked for. */
function openEvents(device, say, req, res, token, query) {
  const ids = new Set(
    String(query ?? "")
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isInteger(id) && id >= 1 && id <= 4),
  );
  if (ids.size === 0) return fail(400, "events needs ?id= with types 1–4");
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders();
  req.socket.setNoDelay(true);
  const stream = { ids, token, res };
  device.streams.add(stream);
  say(`GET /events?id=${[...ids].join(",")} → 200, streaming (${device.streams.size} open)`);
  res.on("close", () => {
    if (!device.streams.delete(stream)) return;
    say(`Event stream closed (${device.streams.size} open)`);
  });
  return null;
}

function respond(res, { status, body, reason }) {
  const headers = {};
  if (reason) headers["X-Emulator-Reason"] = encodeURIComponent(reason);
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  headers["Content-Type"] = "application/json";
  headers["Content-Length"] = Buffer.byteLength(json);
  res.writeHead(status, headers);
  res.end(json);
}

function logRequest(device, say, req, text, { status, reason }) {
  const path = req.url ?? "/";
  device.requests.push({ method: req.method, path, status, body: text === "" ? null : text, reason: reason ?? null });
  if (device.requests.length > MAX_REQUESTS) device.requests.splice(0, device.requests.length - MAX_REQUESTS);
  const shown = path.replace(/^\/api\/v1\/([^/?]{6})[^/?]+/, "/api/v1/$1…");
  const detail = text.trim() === "" ? "" : ` ${truncate(text.replace(/\s+/g, " ").trim(), 90)}`;
  say(`${req.method} ${shown} → ${status}${reason ? ` (${reason})` : ""}${detail}`);
}

function ok(status, body) {
  return { status, body };
}

function fail(status, reason) {
  return { status, reason };
}

/* ---- The virtual wall page ---- */

/** Serves the wall page, its own event stream (`/stream`) and the buttons' actions. */
function wallHandler(device, say) {
  let page = readFileSync(WALL_PAGE);
  let timer = null;
  const tick = () => {
    if (device.viewers.size === 0) {
      clearInterval(timer);
      timer = null;
      return;
    }
    const frame = `event: frame\ndata: ${JSON.stringify({ v: device.layoutVersion, c: wallColours(device) })}\n\n`;
    const status = `event: status\ndata: ${JSON.stringify(wallStatus(device))}\n\n`;
    const t = Date.now();
    for (const viewer of device.viewers) {
      if (viewer.layoutVersion !== device.layoutVersion) {
        viewer.layoutVersion = device.layoutVersion;
        write(viewer.res, `event: layout\ndata: ${JSON.stringify(wallLayout(device))}\n\n`);
      }
      if (status !== viewer.status) write(viewer.res, (viewer.status = status));
      if (frame !== viewer.frame || t - viewer.sentAt > 15_000) {
        viewer.frame = frame;
        viewer.sentAt = t;
        write(viewer.res, frame);
      }
    }
  };
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://wall");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      try {
        page = readFileSync(WALL_PAGE);
      } catch {
        // Keep serving the copy read at startup.
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(page);
      return;
    }
    if (req.method === "GET" && url.pathname === "/stream") {
      res.writeHead(200, SSE_HEADERS);
      res.flushHeaders();
      const viewer = { res, layoutVersion: -1, status: "", frame: "", sentAt: 0 };
      device.viewers.add(viewer);
      res.on("close", () => device.viewers.delete(viewer));
      tick();
      if (!timer) {
        timer = setInterval(tick, WALL_TICK_MS);
        timer.unref();
      }
      return;
    }
    if (req.method === "POST") {
      let text = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        if (text.length < 4096) text += chunk;
      });
      req.on("end", () => {
        let body = {};
        try {
          body = text.trim() === "" ? {} : JSON.parse(text);
        } catch {
          body = {};
        }
        try {
          const result = wallAction(device, url.pathname, isRecord(body) ? body : {});
          if (result === undefined) respond(res, fail(404, "no such action"));
          else respond(res, ok(200, { ok: true, result }));
        } catch (error) {
          say(`Wall action ${url.pathname} failed: ${error.message}`);
          respond(res, { status: 422, body: { ok: false, error: error.message } });
        }
      });
      return;
    }
    respond(res, fail(404, "not found"));
  };
}

function wallAction(device, path, body) {
  switch (path) {
    case "/pair":
      return device.openPairing(PAIRING_MS);
    case "/power":
      return device.pressPower();
    case "/effect":
      return device.selectEffect(typeof body.name === "string" && body.name !== "" ? body.name : undefined);
    case "/rearrange":
      return device.setLayout(device.nextLayoutName());
    case "/touch":
      return device.touch(finite(body.panelId) ? body.panelId : -1, finite(body.gesture) ? body.gesture : 0);
    case "/identify":
      device.identify();
      return true;
    default:
      return undefined;
  }
}

/** Polygons for the page, in SVG space (Y down), rounded to 0.1 units. */
function wallLayout(device) {
  const { panels, others, bounds } = device.placed;
  const point = ([x, y]) => [round1(x), round1(-y)];
  const { minX, minY, maxX, maxY } = bounds;
  return {
    v: device.layoutVersion,
    box: [round1(minX), round1(-maxY), round1(maxX - minX), round1(maxY - minY)],
    panels: panels.map((panel) => ({
      id: panel.id,
      name: shapeLabel(panel.shapeType),
      pts: panel.corners.map(point),
      c: point(panel.center),
      r: round1(panel.inradius),
    })),
    others: others.map((other) => ({
      id: other.id,
      role: other.role,
      pts: other.corners ? other.corners.map(point) : null,
      c: point(other.center),
    })),
  };
}

function wallColours(device) {
  const lights = device.display.lights({ overlays: true });
  return device.placed.panels.map((panel) => screenHex(lights.get(panel.id))).join(",");
}

function wallStatus(device) {
  const base = device.base;
  return {
    name: typeof base.name === "string" ? base.name : "Nanoleaf",
    model: typeof base.model === "string" ? base.model : "NL42",
    firmware: typeof base.firmwareVersion === "string" ? base.firmwareVersion : null,
    on: device.on,
    brightness: device.brightness,
    effect: device.select,
    effects: device.effectsList,
    fps: Math.round(device.fps() * 10) / 10,
    frames: device.frames,
    dropped: device.dropped,
    pairing: device.options.pairing,
    pairingLeft: Math.max(0, Math.ceil((device.pairingUntil - device.now()) / 1000)),
    tokens: device.tokens.size,
    streams: device.streams.size,
    layout: device.layoutName,
    next: device.nextLayoutName(),
    panels: device.placed.panels.length,
    rest: device.endpoints.rest,
    udp: device.endpoints.udp,
  };
}

/* ---- SSDP ---- */

/**
 * Answers M-SEARCH for `ssdp:all` and `nanoleaf:<model>` the way a Shapes controller does: a unicast `HTTP/1.1 200`
 * with ST, USN, Location, nl-deviceid and nl-devicename, after a random 0…min(MX, 1) s delay.
 */
async function startSsdp(device, { host, port, restPort, random, say }) {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  const serial = typeof device.base.serialNo === "string" ? device.base.serialNo : "emulator";
  const uuid = uuidFrom(`device:${serial}`);
  const deviceId = createHash("sha1")
    .update(serial)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase()
    .match(/../g)
    .join(":");
  socket.on("message", (message, rinfo) => {
    const text = message.toString("utf8");
    const lines = text.split(/\r\n|\n/);
    if (!/^M-SEARCH\s+\*\s+HTTP\/1\.1$/i.test((lines[0] ?? "").trim())) return;
    const headers = new Map();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const own = `nanoleaf:${String(device.base.model ?? "NL42").toLowerCase()}`;
    const st = (headers.get("st") ?? "").toLowerCase();
    if (st !== "ssdp:all" && st !== own) return;
    const mx = Math.min(Math.max(Number(headers.get("mx")) || 0, 0), 1);
    const answer = [
      "HTTP/1.1 200 OK",
      `S: uuid:${uuid}`,
      "Ext:",
      "Cache-Control: max-age=60",
      `ST: ${own}`,
      `USN: uuid:${uuid}::${own}`,
      `Location: http://${locationHost(host, rinfo.address)}:${restPort}`,
      `nl-deviceid: ${deviceId}`,
      `nl-devicename: ${device.base.name ?? "Nanoleaf"}`,
      "",
      "",
    ].join("\r\n");
    const timer = setTimeout(() => {
      const failed = (error) => say(`SSDP: couldn't answer ${rinfo.address} (${error.code ?? error.message})`);
      try {
        socket.send(answer, rinfo.port, rinfo.address, (error) => error && failed(error));
      } catch (error) {
        failed(error);
      }
    }, random() * mx * 1000);
    timer.unref();
    say(`SSDP: M-SEARCH ${st} from ${rinfo.address}:${rinfo.port}`);
  });
  socket.on("error", (error) => say(`SSDP: ${error.message}`));
  await new Promise((done, reject) => {
    socket.once("error", reject);
    socket.bind(port, () => {
      socket.off("error", reject);
      done();
    });
  });
  try {
    socket.addMembership(SSDP_GROUP);
  } catch (error) {
    say(`SSDP: couldn't join ${SSDP_GROUP} (${error.code ?? error.message}); answering unicast searches only`);
  }
  return socket;
}

/** The address a searcher can reach the REST API on: the bound host, else the interface on the searcher's subnet. */
function locationHost(host, sender) {
  if (host !== "0.0.0.0" && host !== "::") return host;
  if (sender.startsWith("127.")) return "127.0.0.1";
  let first = null;
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      first ??= entry.address;
      if (sameSubnet(entry.address, sender, entry.netmask)) return entry.address;
    }
  }
  return first ?? "127.0.0.1";
}

function sameSubnet(a, b, mask) {
  const toInt = (ip) => ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
  return (toInt(a) & toInt(mask)) >>> 0 === (toInt(b) & toInt(mask)) >>> 0;
}

/* ---- Sockets ---- */

function listen(server, port, host) {
  return new Promise((done, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      done(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host, exclusive: true });
  });
}

function bindUdp(port, host, onMessage) {
  const socket = createSocket(host.includes(":") ? "udp6" : "udp4");
  socket.on("message", onMessage);
  return new Promise((done, reject) => {
    const onError = (error) => {
      socket.close();
      reject(error);
    };
    socket.once("error", onError);
    socket.bind({ port, address: host, exclusive: true }, () => {
      socket.off("error", onError);
      socket.on("error", () => {});
      done(socket);
    });
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
}

function closeSocket(socket) {
  if (!socket) return Promise.resolve();
  return new Promise((done) => {
    try {
      socket.close(() => done());
    } catch {
      done();
    }
  });
}

function write(res, text) {
  if (!res.writableEnded && !res.destroyed) res.write(text);
}

function hostForUrl(host) {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") ? `[${host}]` : host;
}

/* ---- Small readers ---- */

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueOf(field) {
  return isRecord(field) ? field.value : field;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clampRange(value, key) {
  const [min, max] = RANGES[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readRange(value, key, fallback) {
  return finite(value) ? clampRange(value, key) : fallback;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function defaultLog(message) {
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`${time}  ${message}`);
}

/* ---- Command line ---- */

const USAGE = `Usage: node tools/fake-nanoleaf.mjs [options]

  --layout <name|file>   ${Object.keys(LAYOUTS).join(", ")}, or a GET / JSON file (default mixed)
  --port <n>             REST port (default 16021)
  --udp <n>              extControl UDP port (default 60222)
  --wall <n|none>        virtual wall page port (default 16022)
  --host <address>       address to listen on (default 127.0.0.1; 0.0.0.0 for the LAN)
  --pairing <mode>       button: pair after "Hold power button" (default); open: always pair
  --ssdp                 answer SSDP M-SEARCH on UDP 1900
  --serial <serial>      the serial number it reports (default: the layout's)
  --token <token>        a token it already knows; repeat for more
  --quiet                no request log`;

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        layout: { type: "string", default: "mixed" },
        port: { type: "string", default: "16021" },
        udp: { type: "string", default: "60222" },
        wall: { type: "string", default: "16022" },
        host: { type: "string", default: "127.0.0.1" },
        pairing: { type: "string", default: "button" },
        ssdp: { type: "boolean", default: false },
        serial: { type: "string" },
        token: { type: "string", multiple: true },
        quiet: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const port = (text, name) => {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new RangeError(`--${name} must be a port number`);
    return n;
  };
  let emu;
  try {
    emu = await startEmulator({
      host: values.host,
      port: port(values.port, "port"),
      udpPort: port(values.udp, "udp"),
      wallPort: values.wall === "none" || values.wall === "off" ? null : port(values.wall, "wall"),
      layout: values.layout,
      pairing: values.pairing,
      ssdp: values.ssdp,
      serialNo: values.serial,
      tokens: values.token,
      quiet: values.quiet,
    });
  } catch (error) {
    const hint = error.code === "EADDRINUSE" ? " (another emulator? pick other ports with --port/--udp/--wall)" : "";
    console.error(`Couldn't start: ${error.message}${hint}`);
    process.exitCode = 1;
    return;
  }
  printBanner(emu, values);
  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    await emu.close();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key) => {
      if (key === "q" || key === "\u0003") void quit();
      else if (key === "p") emu.openPairing();
      else if (key === "o") emu.pressPower();
      else if (key === "e") emu.selectEffect();
      else if (key === "r") emu.setLayout(nextName(emu.layoutName()));
      else if (key === "t") emu.touch();
    });
  }
}

function nextName(current) {
  const names = Object.keys(LAYOUTS);
  return names[(names.indexOf(current) + 1) % names.length];
}

function printBanner(emu, values) {
  const info = emu.info();
  const counts = new Map();
  for (const panel of info.panelLayout.layout.positionData) {
    if (panel.shapeType === 12) continue;
    const name = shapeLabel(panel.shapeType).toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const kinds = [...counts].map(([name, n]) => `${n} ${name}${n === 1 ? "" : "s"}`).join(", ");
  const pairing =
    values.pairing === "open"
      ? "always open: pair from the plugin now"
      : `press P here or click "Hold power button" on the wall page, then pair within ${PAIRING_MS / 1000} s`;
  const lines = [
    `Fake Nanoleaf "${info.name}" (${info.model}, firmware ${info.firmwareVersion}): ${kinds}`,
    `  REST     ${emu.url}/api/v1/   (pair with host ${hostForUrl(emu.host)}, port ${emu.port})`,
    `  UDP      ${hostForUrl(emu.host)}:${emu.udpPort}   extControl v2 frames`,
    `  Wall     ${emu.wallUrl ?? "off"}`,
  ];
  if (emu.ssdpPort !== null) lines.push(`  SSDP     answering M-SEARCH on UDP ${emu.ssdpPort}`);
  lines.push(`  Pairing  ${pairing}`);
  if (process.stdin.isTTY) lines.push("  Keys     p pairing · o power · e effect · r rearrange · t tap · q quit");
  console.log(lines.join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
