#!/usr/bin/env node
/**
 * A check, run at a real wall, of the controller's UDP touch stream (nanoleaf-api.md §6 and §11): whether the
 * controller sends it at all, whether it reaches this computer, what the from-id holds on a touch that isn't a swipe
 * (0xFFFF or 0x00FF), and how type and strength share byte 2. What one Shapes wall answered is in §6. It has no
 * dependencies: it imports the plugin's own TypeScript (shared/touch.ts, events.ts) through Node's type stripping.
 *
 *   node tools/touch-probe.mjs --host <address> [--port 16021] [--token <token>] [--seconds 60]
 *
 * Without `--token` it pairs (the person holds the power button) and always removes its own token at the end: after
 * the normal end, an error, or Ctrl-C (a second Ctrl-C waits for the removal; a third quits and names the token's
 * last four characters). A token passed with `--token` is never removed. It accepts any host, including this machine
 * (for the emulator). Exit codes: 0 done, 1 stopped by an error, 2 bad arguments, 130 stopped with Ctrl-C.
 */
import { createSocket } from "node:dgram";
import { isIP } from "node:net";
import { parseArgs } from "node:util";
import {
  EFFECTS_EVENT,
  effectName,
  EventStream,
  LAYOUT_EVENT,
  layoutChange,
  STATE_EVENT,
  stateAttrs,
  touches,
} from "../main/src/nanoleaf/events.ts";
import { SHAPES } from "../shared/geometry.ts";
import {
  decodeTouchPacket,
  FILL_LIKE_PANEL_IDS,
  SWIPE_GRACE_MS,
  SWIPE_WINDOW_MS,
  TOUCH_DOWN,
  TOUCH_SWIPE,
  TOUCH_UP,
  TouchBuffer,
  touchByteReadings,
  touchTypeName,
} from "../shared/touch.ts";

const PAIRING_WAIT_MS = 90_000;
const MAX_SECONDS = 3600;
const USAGE = `Usage: node tools/touch-probe.mjs --host <address> [--port 16021] [--token <token>] [--seconds 60]

Checks whether your Nanoleaf controller sends its detailed touch data to this computer, and what that data looks like.

  --host <address>   the controller's address, for example 192.168.1.50
  --port <n>         the controller's API port (default 16021)
  --token <token>    a token the controller already gave out; without one, the probe pairs, and removes
                     its access again at the end
  --seconds <n>      how long to listen (default 60, at most ${MAX_SECONDS})`;

/** One monotonic clock for everything: packet arrivals, events and the stamps printed. */
const clock = () => performance.now();
const started = clock();
const stamp = () => `[${String(Math.round(clock() - started)).padStart(6)} ms]`;
const say = (line = "") => console.log(line);
const hex16 = (n) => `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;
const readingText = ({ type, strength }) => `${touchTypeName(type) ?? `unknown type ${type}`}, strength ${strength}`;

/** What the run did, for the summary and for cleaning up. */
const run = {
  base: "",
  /** The probe's own token (from pairing), removed at the end; null with `--token` or before pairing. */
  ownToken: null,
  cancelled: false,
  interrupts: 0,
  layoutRead: false,
  eventsOpened: false,
  listening: false,
  lights: new Set(),
  packets: 0,
  malformed: 0,
  sources: new Set(),
  fills: new Map(),
  swipes: [],
  /** State, layout and effect events heard while the touch data was asked for. */
  others: { state: 0, layout: 0, effects: 0 },
  taps: { checked: 0, table: 0, text: 0 },
  closers: [],
};

/** Wakes whatever the probe is waiting on (a pairing retry or the listening period) when it is cancelled. */
let wake = () => {};
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

let finishing = null;
/** The one way out: closes everything, prints the summary, and removes the probe's own token. Runs once. */
function finish() {
  finishing ??= (async () => {
    for (const close of run.closers.splice(0)) {
      try {
        close();
      } catch {
        // Already closed.
      }
    }
    summary();
    if (run.ownToken) await revoke(run.base, run.ownToken);
  })();
  return finishing;
}

/** Ctrl-C: the first stops and cleans up, the second says it is still cleaning up, the third quits at once. */
function interrupted() {
  run.interrupts++;
  if (run.interrupts === 1) {
    run.cancelled = true;
    say();
    say(`${stamp()} Stopping.`);
    wake();
  } else if (run.interrupts === 2) {
    say(`${stamp()} Still finishing${run.ownToken ? " and removing the probe's access to the controller" : ""}. ` +
      "Press Ctrl-C again to quit without waiting.");
  } else {
    const left = run.ownToken ? ` The probe's access may be left on the controller (its token ends in "${run.ownToken.slice(-4)}").` : "";
    say(`${stamp()} Quitting now.${left}`);
    process.exit(130);
  }
}

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        host: { type: "string" },
        port: { type: "string", default: "16021" },
        token: { type: "string" },
        seconds: { type: "string", default: "60" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    return usage(error.message);
  }
  if (values.help) {
    say(USAGE);
    return 0;
  }
  if (!values.host) return usage("--host is needed: the controller's address.");
  const host = values.host.trim();
  const port = Number(values.port);
  let seconds = Number(values.seconds);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return usage(`--port must be a port number, not "${values.port}"`);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return usage(`--seconds must be a positive number, not "${values.seconds}"`);
  }
  if (seconds > MAX_SECONDS) {
    say(`The probe listens for at most an hour, so it will listen for ${MAX_SECONDS} seconds.`);
    seconds = MAX_SECONDS;
  }
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const family = isIP(bare);
  if (family === 0) {
    say(`"${bare}" is a name, not an address, so the probe listens for touch data over IPv4 only.`);
    say("If nothing arrives, run it again with the controller's address (for example 192.168.1.50).");
  }
  run.base = `http://${family === 6 ? `[${bare}]` : bare}:${port}/api/v1`;

  // Installed before pairing, so a Ctrl-C while the controller hands out a token still removes it.
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  let code = 0;
  try {
    let token = values.token;
    if (!token) {
      token = await pair(run.base);
      if (!token) return run.cancelled ? 130 : 1;
    }
    if (run.cancelled) return 130;
    await listen(bare, family, port, token, seconds);
    code = run.cancelled ? 130 : 0;
  } catch (error) {
    say(`${stamp()} Stopped: ${error.message}`);
    code = 1;
  } finally {
    await finish();
  }
  return code;
}

function usage(message) {
  say(message);
  say(USAGE);
  return 2;
}

/**
 * Asks the person to hold the power button, then polls `POST /new` until the controller hands out a token. A request
 * already on its way when Ctrl-C comes is let finish, so a token it brings back is known, and removed at the end.
 */
async function pair(base) {
  say("To let this probe talk to your controller, hold its power button for 5 to 7 seconds, until the lights flash.");
  say("Waiting for that now...");
  const deadline = clock() + PAIRING_WAIT_MS;
  while (!run.cancelled && clock() < deadline) {
    try {
      const response = await fetch(`${base}/new`, { method: "POST", signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const body = await response.json();
        if (typeof body?.auth_token === "string") {
          run.ownToken = body.auth_token;
          if (run.cancelled) say(`${stamp()} The controller let the probe in just as it stopped; removing that access.`);
          else say(`${stamp()} Paired. The probe will remove its access again when it finishes.`);
          return body.auth_token;
        }
      } else if (response.status !== 403) {
        say(`${stamp()} The controller answered ${response.status} when asked to pair.`);
      }
    } catch (error) {
      const reason = error.cause?.code ?? error.message;
      say(`${stamp()} Can't reach the controller at ${base.replace(/\/api\/v1$/, "")} (${reason}).`);
    }
    if (!run.cancelled) await sleep(1000);
  }
  if (!run.cancelled) {
    say("The controller didn't open pairing in time. Run the probe again and hold the power button a little longer.");
  }
  return null;
}

/** Reads the wall, binds the UDP socket, opens the events request with the header and listens for `seconds`. */
async function listen(bare, family, port, token, seconds) {
  run.lights = await wallPanels(run.base, token);
  run.layoutRead = true;
  say(`${stamp()} Your wall has ${run.lights.size} light panels: ${[...run.lights].join(", ") || "none found"}.`);
  const clashes = FILL_LIKE_PANEL_IDS.filter((id) => run.lights.has(id));
  if (clashes.length > 0) {
    say(`Note: your wall has a panel numbered ${clashes.join(" and ")}. The controller may use that same number to mean`);
    say(`"no panel" in its touch data, so where a swipe started can come out as that panel by mistake.`);
  }
  if (run.cancelled) return;

  const buffer = new TouchBuffer();
  /** Records in the last window, for reading each tap's touch data. */
  let recent = [];
  const socket = createSocket(family === 6 ? "udp6" : "udp4");
  run.closers.push(() => socket.close());
  socket.on("message", (message, rinfo) => {
    const at = clock();
    const packet = decodeTouchPacket(message);
    run.packets++;
    run.sources.add(rinfo.address);
    if (packet.malformed) run.malformed++;
    buffer.push(packet.records, at);
    recent = recent.filter((entry) => at - entry.at <= SWIPE_WINDOW_MS);
    for (const record of packet.records) recent.push({ record, at });
    const shape = packet.malformed ? ` (its length doesn't match its count of ${packet.count})` : "";
    say(`${stamp()} Touch data from ${rinfo.address}, ${message.length} bytes: ${spaced(message)}${shape}`);
    for (const record of packet.records) {
      const { table, text } = touchByteReadings(record.raw);
      const onWall = run.lights.has(record.panelId) ? "" : " (not a panel on your wall)";
      const byte = `0x${record.raw.toString(16).padStart(2, "0")}`;
      say(`             panel ${record.panelId}${onWall}, byte 2 = ${byte}, from ${hex16(record.fromId)} (${record.fromId})`);
      say(`               read as bits 6-3 / 2-0: ${readingText(table)}`);
      say(`               read as bits 6-4 / 3-0: ${readingText(text)}`);
      const swipeEither = table.type === TOUCH_SWIPE || text.type === TOUCH_SWIPE;
      if (!swipeEither && !run.lights.has(record.fromId)) {
        run.fills.set(record.fromId, (run.fills.get(record.fromId) ?? 0) + 1);
      }
    }
  });
  const udpPort = await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, () => {
      socket.off("error", reject);
      socket.on("error", (error) => say(`${stamp()} The listening socket failed: ${error.message}`));
      resolve(socket.address().port);
    });
  });
  run.listening = true;
  say(`${stamp()} Listening for touch data on UDP port ${udpPort} of this computer.`);
  if (run.cancelled) return;

  // The same request the plugin opens (controller.ts): every event type (no `ids`, so 1, 2, 3 and 4) with the header.
  const events = new EventStream({
    host: family === 6 ? `[${bare}]` : bare,
    port,
    token,
    touchEventsPort: udpPort,
    backoffMs: [2000],
    onEvent: (event) => {
      if (event.id !== 4) {
        otherEvent(event);
        return;
      }
      const at = clock();
      for (const touch of touches(event)) {
        if (touch.gesture === "tap" || touch.gesture === "double-tap") {
          say(`${stamp()} The controller reports a ${touch.gesture} on panel ${touch.panelId}.`);
          tapShape(touch.panelId, recent.filter((entry) => at - entry.at <= SWIPE_WINDOW_MS));
        } else {
          // As the plugin does (touch-stream.ts placeSwipe): take at once; if nothing is there yet, the touch data may
          // not have been read, so wait the grace and take again. The grace's end also uses up a late tail.
          say(`${stamp()} The controller reports a ${touch.gesture.replace("-", " ")}.`);
          const swipe = { gesture: touch.gesture, at, placed: undefined };
          run.swipes.push(swipe);
          const atOnce = buffer.takeSwipePanel(at, run.lights);
          if (atOnce !== null) placedSwipe(swipe, atOnce, "");
          const timer = setTimeout(() => {
            const late = buffer.takeSwipePanel(at, run.lights, SWIPE_GRACE_MS);
            if (atOnce === null) placedSwipe(swipe, late, ` (after waiting ${SWIPE_GRACE_MS} ms)`);
          }, SWIPE_GRACE_MS);
          run.closers.push(() => clearTimeout(timer));
        }
      }
    },
    onStatus: (open, error) => {
      if (open && !run.eventsOpened) {
        say(`${stamp()} Connected. Touch, tap and swipe the wall now, for ${seconds} seconds.`);
        say("             Also change the wall's brightness once, from the Nanoleaf app or the controller's buttons, so the");
        say("             probe can check it still hears the wall's other news while the touch data is on.");
      }
      else if (!open) {
        say(`${stamp()} The connection to the controller dropped${error ? ` (${error.message})` : ""}; trying again.`);
      }
      run.eventsOpened ||= open;
    },
    log: (message, error) => {
      if (!run.eventsOpened) say(`${stamp()} ${message}${error?.message ? `: ${error.message}` : ""}`);
    },
  });
  run.closers.unshift(() => events.close());
  await sleep(seconds * 1000);
}

/** A state, layout or effect event, in plain words, with a short tail of its raw data. */
function otherEvent(event) {
  const raw = JSON.stringify(event.events);
  const tail = ` [${raw.length > 80 ? `${raw.slice(0, 77)}...` : raw}]`;
  if (event.id === STATE_EVENT) {
    run.others.state++;
    const attrs = stateAttrs(event);
    const parts = [];
    if (attrs.on !== undefined) parts.push(attrs.on ? "it was turned on" : "it was turned off");
    if (attrs.brightness !== undefined) parts.push(`its brightness changed to ${attrs.brightness}`);
    if (attrs.hue !== undefined || attrs.sat !== undefined || attrs.ct !== undefined) parts.push("its colour changed");
    if (attrs.colorMode !== undefined) parts.push(`it switched to ${attrs.colorMode === "effect" ? "an effect" : "a plain colour"}`);
    say(`${stamp()} The controller reports ${parts.length > 0 ? parts.join(", ") : "a change of state"}.${tail}`);
  } else if (event.id === LAYOUT_EVENT) {
    run.others.layout++;
    const change = layoutChange(event);
    const what = change?.positionData ? "its layout changed" : change?.globalOrientation !== null ? "its orientation changed" : "a layout change";
    say(`${stamp()} The controller reports ${what}.${tail}`);
  } else if (event.id === EFFECTS_EVENT) {
    run.others.effects++;
    const name = effectName(event);
    say(`${stamp()} The controller reports its effect changed${name ? ` to "${name}"` : ""}.${tail}`);
  }
}

function placedSwipe(swipe, placed, after) {
  swipe.placed = placed;
  const where = placed === null ? "the touch data doesn't place it" : `the touch data places it on panel ${placed}`;
  say(`${stamp()} ${capitalise(swipe.gesture.replace("-", " "))}: ${where}${after}.`);
}

/**
 * Whether a tap's touch data has a down and then an up under each layout of byte 2. Not first and last: a real tap
 * has hovers before its down and a type the doc doesn't list after its up.
 */
function tapShape(panelId, entries) {
  const records = entries.filter(({ record }) => record.panelId === panelId);
  if (records.length === 0) return;
  run.taps.checked++;
  for (const layout of ["table", "text"]) {
    const types = records.map(({ record }) => touchByteReadings(record.raw)[layout].type);
    const down = types.indexOf(TOUCH_DOWN);
    if (down !== -1 && types.includes(TOUCH_UP, down + 1)) run.taps[layout]++;
  }
}

/** The light panels' ids (no controller or connectors), from the controller's layout. */
async function wallPanels(base, token) {
  let response;
  try {
    response = await fetch(`${base}/${encodeURIComponent(token)}/panelLayout/layout`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    throw new Error(`can't reach the controller at ${base.replace(/\/api\/v1$/, "")} (${error.cause?.code ?? error.message})`);
  }
  if (response.status === 401) throw new Error("the controller doesn't accept this token");
  if (!response.ok) throw new Error(`the controller answered ${response.status} when asked for its layout`);
  const layout = await response.json();
  const ids = new Set();
  for (const panel of Array.isArray(layout?.positionData) ? layout.positionData : []) {
    if (Number.isInteger(panel?.panelId) && SHAPES[panel.shapeType]?.light) ids.add(panel.panelId);
  }
  return ids;
}

async function revoke(base, token) {
  try {
    const response = await fetch(`${base}/${encodeURIComponent(token)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) say("Removed the probe's access to the controller.");
    else say(`Couldn't remove the probe's access (${response.status}); its token ends in "${token.slice(-4)}".`);
  } catch (error) {
    say(`Couldn't remove the probe's access (${error.message}); its token ends in "${token.slice(-4)}".`);
  }
}

function summary() {
  say();
  say("Summary");
  say("-------");
  if (!run.layoutRead || !run.eventsOpened) {
    const why = run.cancelled
      ? "it was stopped first"
      : "the address may be wrong, the controller may have refused the token, or it didn't answer";
    say(`The probe never connected to the controller (${why}), so this run says nothing about touch data.`);
    return;
  }
  if (run.cancelled) say(`You stopped the probe after ${Math.round((clock() - started) / 1000)} s.`);
  if (run.packets === 0 && run.cancelled) {
    say("No touch data arrived before you stopped it. Run it again for longer, and touch the wall, to find out more.");
  } else if (run.packets === 0) {
    say("No touch data arrived. Either this controller doesn't send it, or something between it and this computer");
    say("blocked it: a firewall on this computer (on a Mac, allow Node to accept incoming connections if asked), or");
    say("a network that doesn't pass it on. Touches and swipes still work without it; the plugin just can't tell");
    say("which panel a swipe was on.");
  } else {
    say(`${run.packets} packets of touch data arrived, from ${[...run.sources].join(", ")}.`);
    if (run.malformed > 0) say(`${run.malformed} of them were shorter or longer than they said.`);
  }
  if (run.fills.size > 0) {
    const fills = [...run.fills].map(([id, count]) => `${hex16(id)} (${id}) ${count} times`).join(", ");
    say(`On touches that weren't swipes, the "from" field held: ${fills}.`);
  } else if (run.packets > 0) {
    say(`No touch outside a swipe carried a "from" value that isn't a panel on your wall.`);
  }
  if (run.taps.checked > 0) {
    const taps = `${run.taps.checked} ${run.taps.checked === 1 ? "tap" : "taps"}`;
    say(`Of ${taps} with touch data, ${run.taps.table} had a "down" and then an "up" with bits 6-3 / 2-0,`);
    say(`and ${run.taps.text} with bits 6-4 / 3-0.`);
  }
  if (run.swipes.length === 0) say("No swipes were reported.");
  const { state, layout, effects } = run.others;
  if (state + layout + effects > 0) {
    const heard = [
      state > 0 ? `${state} about its state (power, brightness, colour)` : null,
      layout > 0 ? `${layout} about its layout` : null,
      effects > 0 ? `${effects} about its effect` : null,
    ].filter(Boolean);
    say(`While the touch data was on, the controller still sent its other news: ${heard.join(", ")}.`);
  } else {
    say("No news about the wall's state, layout or effect arrived while the touch data was on. That only means");
    say("something if you changed the brightness during the run; if you didn't, run it again and change it once.");
  }
  for (const swipe of run.swipes) {
    const when = `${((swipe.at - started) / 1000).toFixed(1)} s`;
    const where =
      swipe.placed === undefined
        ? "stopped before it was placed"
        : swipe.placed === null
          ? "not placed (no touch data for a panel on your wall around it)"
          : `placed on panel ${swipe.placed}`;
    say(`${capitalise(swipe.gesture.replace("-", " "))} at ${when}: ${where}.`);
  }
  say(`The wall had ${run.lights.size} light panels.`);
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function spaced(bytes) {
  return Buffer.from(bytes).toString("hex").replace(/(..)/g, "$1 ").trim();
}

process.exitCode = await main(process.argv.slice(2));
