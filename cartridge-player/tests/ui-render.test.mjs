// Server-renders the real interface (bundled once with the esbuild vite ships) over a model shaped like the live
// one, and checks what assistive technology gets from the markup: one live region that says the phase and never the
// clock, named controls for each phase, read-only controls while main isn't running, and no error on a field the
// user hasn't touched.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodeSetupCode } from "../shared/setup-code.ts";
import { readMappings, readPlayerRecord } from "../shared/storage.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const TAG = "04:A2:3B:1C:7F:5D:80";
const OTHER = "04:C4:58:2E:61:0B:80";
const DEVICE = "cp-a1b2c3";
let ui;
let dir;

before(async () => {
  const require = createRequire(join(ROOT, "package.json"));
  const esbuild = createRequire(require.resolve("vite"))("esbuild");
  const out = await esbuild.build({
    stdin: {
      contents: [
        'export { App } from "./ui/src/App.tsx";',
        'export { SetupGuide } from "./ui/src/components/setup/SetupGuide.tsx";',
        'export { CartridgeDetails } from "./ui/src/components/shelf/CartridgeDetails.tsx";',
        'export { buildLibrary } from "./ui/src/view/library.ts";',
        'export { ModelProvider } from "./ui/src/model.ts";',
        'export { byId } from "./ui/src/view/types.ts";',
        'export { renderToStaticMarkup } from "react-dom/server";',
        'export { createElement } from "react";',
      ].join("\n"),
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    write: false,
    logLevel: "error",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await esbuild.stop();
  dir = mkdtempSync(join(tmpdir(), "cartridge-ui-"));
  const file = join(dir, "ui.cjs");
  writeFileSync(file, out.outputFiles[0].contents);
  ui = createRequire(import.meta.url)(file);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/* ---- A small HTML tree, enough for React's static markup ---- */

const VOID = new Set(["input", "br", "img", "hr", "meta", "link"]);

function decode(text) {
  return text
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parse(html) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re = /<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      stack.pop();
    } else if (m[2]) {
      const attrs = {};
      for (const a of m[3].matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? "");
      const node = { tag: m[2].toLowerCase(), attrs, children: [] };
      top.children.push(node);
      if (!m[4] && !VOID.has(node.tag)) stack.push(node);
    } else {
      top.children.push(decode(m[5]));
    }
  }
  return root;
}

function findAll(node, pred, out = []) {
  if (typeof node === "string") return out;
  if (pred(node)) out.push(node);
  for (const child of node.children) findAll(child, pred, out);
  return out;
}

/** The text a screen reader gets from a subtree: aria-hidden branches left out, elements read one after another. */
function spoken(node) {
  if (typeof node === "string") return node;
  if (node.attrs["aria-hidden"] === "true") return "";
  return node.children.map(spoken).join(" ");
}

const squash = (text) => text.replace(/\s+/g, " ").trim();
/** A control's accessible name: its aria-label, else its spoken text. */
const nameOf = (node) => node.attrs["aria-label"] ?? squash(spoken(node));
const has = (node, attr) => Object.hasOwn(node.attrs, attr);

/* ---- A model like the live one: storage through the shared readers, the workspace as plain rows ---- */

const activity = (id, name, extra = {}) => ({ id, name, color: "#60a5fa", iconPath: "M0 0H24V24H0Z", categoryId: null, categoryName: null, archived: false, point: false, ...extra });
const ACTIVITIES = [activity("deep", "Deep work"), activity("gym", "Gym"), activity("water", "Glass of water", { point: true, iconPath: null })];

function model({ slot = null, mappings = { [TAG]: "deep", [OTHER]: "gym" }, live = [], history = [], devices, unknown = [], ...patch } = {}) {
  const refuse = () => Promise.reject(new Error("no request is made while rendering"));
  return {
    activities: ACTIVITIES,
    lookup: ui.byId(ACTIVITIES),
    categories: [],
    live,
    mappings: readMappings(mappings),
    record: readPlayerRecord({
      v: 1,
      devices: devices ?? { [DEVICE]: { name: "Cartridge-A1B2", fw: "2.0.0", slot, lastHeardAt: iso(NOW - 60_000), hubHost: "192.168.1.12:9001" } },
      active: devices ? null : DEVICE,
      unknown,
      cartridges: { [TAG]: { seenAt: iso(NOW - 3_600_000), plays: 4, playedMs: 7_200_000 } },
      history,
      nextId: history.length + 1,
    }),
    presence: { online: true, lastHeardAt: iso(NOW - 60_000), deviceId: DEVICE, name: "Cartridge-A1B2", firmware: "2.0.0", reader: "ok" },
    mainStatus: "running",
    mainStatusReason: null,
    reading: null,
    apiPath: "/api/plugins/cartridge-player/api",
    pageHost: "192.168.1.12",
    actions: { label: refuse, forget: refuse, dismiss: refuse, start: refuse },
    ...patch,
  };
}

/** The whole interface over `value`, or one of its parts (`element`) over the same model. */
function render(value, element = ui.createElement(ui.App)) {
  const html = ui.renderToStaticMarkup(ui.createElement(ui.ModelProvider, { value }, element));
  const tree = parse(html);
  return {
    tree,
    live: findAll(tree, (n) => has(n, "aria-live")),
    buttons: findAll(tree, (n) => n.tag === "button"),
    button: (name) => findAll(tree, (n) => n.tag === "button" && nameOf(n) === name)[0],
    stage: findAll(tree, (n) => n.tag === "section" && n.attrs["aria-label"] === "Player")[0],
    text: squash(spoken(tree)),
  };
}

const since = iso(NOW - 23 * 60_000);
const slot = (extra = {}) => ({ tag: TAG, since, activityId: "deep", sessionId: "s1", outcome: "started", error: null, ...extra });
const PLAYING = { slot: slot(), live: [{ id: "s1", activityId: "deep", startedAt: NOW - 23 * 60_000 }] };

test("render: one polite live region says the phase in words, and the ticking clock is kept from it", () => {
  const view = render(model(PLAYING));
  assert.equal(view.live.length, 1);
  const [region] = view.live;
  assert.deepEqual([region.attrs["aria-live"], region.attrs.role], ["polite", "status"]);
  assert.equal(squash(spoken(region)), "Deep work is tracking.");
  // The clock ticks every second: it's drawn for the eye and hidden from assistive technology, live region or not.
  const clocks = findAll(view.tree, (n) => (n.attrs.class ?? "").split(" ").includes("cp-clock"));
  assert.equal(clocks.length, 1);
  assert.match(clocks[0].children.join(""), /^\d\d:\d\d:\d\d$/);
  assert.equal(clocks[0].attrs["aria-hidden"], "true");
  assert.doesNotMatch(view.text, /\d\d:\d\d:\d\d/);
  // The scene is decoration: the words beside it say the same.
  const scene = findAll(view.stage, (n) => n.tag === "svg" && n.attrs.viewBox !== "0 0 24 24")[0];
  assert.equal(scene.attrs["aria-hidden"], "true");
});

test("render: each phase names what the user can do about it", () => {
  // A new cartridge: suggestions (activities without a cartridge) and a search, nothing else.
  const unknown = render(model({ slot: slot({ activityId: null, sessionId: null, outcome: "unknown" }), mappings: { [OTHER]: "gym" } }));
  assert.equal(squash(spoken(unknown.live[0])), "A new cartridge is in the player. It needs a label.");
  const group = findAll(unknown.stage, (n) => n.attrs.role === "group" && n.attrs["aria-label"] === "Suggested labels")[0];
  assert.deepEqual(findAll(group, (n) => n.tag === "button").map(nameOf), ["Deep work", "Glass of water"]);
  const search = findAll(unknown.stage, (n) => n.attrs.role === "combobox");
  assert.equal(search.length, 1);
  // Nothing takes focus by itself when a cartridge arrives, and the list stays shut until the user types.
  assert.deepEqual([has(search[0], "autofocus"), search[0].attrs["aria-expanded"]], [false, "false"]);
  assert.equal(unknown.button("Start tracking"), undefined);

  // Labelled, nothing tracking: start it or leave it.
  const ready = render(model({ slot: slot({ sessionId: null, outcome: "idle" }) }));
  assert.deepEqual(findAll(ready.stage, (n) => n.tag === "button").map(nameOf).slice(1), ["Start tracking", "Later"]);
  // A point activity is marked, not started.
  const point = render(model({ slot: slot({ activityId: "water", sessionId: null, outcome: "idle" }), mappings: { [TAG]: "water" } }));
  assert.ok(point.button("Mark now"));

  // Main couldn't start it: its reason as a sentence, and a retry.
  const failed = render(model({ slot: slot({ sessionId: null, outcome: "error", error: "Drift Beacon is restarting" }) }));
  assert.match(squash(spoken(failed.stage)), /Couldn't start Deep work Drift Beacon is restarting\. Try again Later/);
  assert.equal(findAll(failed.stage, (n) => n.attrs.role === "alert").length, 0, "the note carries the reason once");

  // Tracking: nothing to press on the stage but the player's own panel.
  const playing = render(model(PLAYING));
  assert.deepEqual(findAll(playing.stage, (n) => n.tag === "button").map(nameOf), ["Player online"]);
});

test("render: every shelf card is a named button that opens a dialog, and says what's tracking", () => {
  const view = render(model({ ...PLAYING, mappings: { [TAG]: "gym", [OTHER]: "gym" } }));
  const cards = findAll(view.tree, (n) => n.tag === "button" && has(n, "data-cartridge"));
  assert.equal(cards.length, 2);
  for (const card of cards) assert.deepEqual([card.attrs["aria-haspopup"], card.attrs["aria-expanded"]], ["dialog", "false"]);
  // Relabelled Gym while Deep work plays: the card names both.
  const inSlot = cards.find((card) => card.attrs["data-cartridge"] === TAG);
  assert.match(inSlot.attrs["aria-label"], /^Gym, in the player, tracking Deep work, /);
  assert.equal(squash(spoken(view.live[0])), "Deep work is tracking.");
  // The shelf's heading can take focus when a card it held is forgotten.
  const heading = findAll(view.tree, (n) => n.attrs.id === "cp-shelf")[0];
  assert.deepEqual([heading.tag, heading.attrs.tabindex], ["h2", "-1"]);
});

test("render: while main isn't running everything is read-only, under a notice that says why", () => {
  const idle = { slot: slot({ sessionId: null, outcome: "idle" }), unknown: [{ tag: "04:9C:41:E7:08:B3:81", firstSeenAt: since, lastSeenAt: since }] };
  const stopped = render(model({ ...idle, mainStatus: "unavailable", mainStatusReason: "It crashed.", presence: null }));
  const notices = findAll(stopped.tree, (n) => n.attrs.role === "status" && !has(n, "aria-live"));
  assert.match(squash(spoken(notices[0])), /^The plugin isn't running It crashed\. Until it's running again, the player can't start anything/);
  assert.ok(has(stopped.button("Start tracking"), "disabled"));
  assert.ok(has(stopped.button("Label"), "disabled"));
  assert.ok(has(stopped.button("Dismiss cartridge 04:9C:41:E7:08:B3:81"), "disabled"));
  // Looking is still allowed: the shelf's cards and the player's panel open.
  assert.ok(!has(findAll(stopped.tree, (n) => has(n, "data-cartridge"))[0], "disabled"));
  assert.ok(!has(stopped.button("Player status unknown"), "disabled"));

  const running = render(model(idle));
  assert.equal(findAll(running.tree, (n) => n.attrs.role === "status" && !has(n, "aria-live")).length, 0);
  for (const name of ["Start tracking", "Label"]) assert.ok(!has(running.button(name), "disabled"), name);
  // Still being heard from: no notice yet, but nothing can be changed either.
  const connecting = render(model({ ...idle, mainStatus: "connecting" }));
  assert.equal(findAll(connecting.tree, (n) => n.attrs.role === "status" && !has(n, "aria-live")).length, 0);
  assert.ok(has(connecting.button("Start tracking"), "disabled"));
});

test("render: first run opens the guide on one question, and asks for the hub's address only when the page can't tell", () => {
  const firstRun = (pageHost) => render(model({ devices: {}, mappings: {}, presence: null, pageHost }));
  const heading = (view) => squash(spoken(findAll(view.stage, (n) => n.tag === "h2")[0]));

  // Opened on the hub's own machine: the address is the first question, asked rather than marked wrong.
  const local = firstRun("localhost");
  assert.equal(squash(spoken(local.live[0])), "The slot is empty.");
  assert.equal(heading(local), "Where is your hub?");
  assert.match(local.text, /Step 1 of 4/);
  const host = findAll(local.stage, (n) => n.tag === "input" && n.attrs.placeholder === "192.168.1.12")[0];
  assert.deepEqual([host.attrs.value, has(host, "aria-invalid")], ["", false]);
  assert.ok(has(local.button("Continue"), "disabled"));

  // Opened at an address a player can use: no question about it, straight to the key, which can be skipped.
  const lan = firstRun("192.168.1.12");
  assert.equal(heading(lan), "Paste an API key");
  assert.match(lan.text, /Step 1 of 3/);
  assert.match(lan.text, /Workspace settings → API Keys/);
  assert.ok(has(lan.button("Continue"), "disabled"));
  assert.ok(!has(lan.button("Skip: I'll paste it on the player"), "disabled"));
  // One question at a time: the code and the phone's steps aren't on this screen.
  assert.equal(findAll(lan.stage, (n) => n.attrs["aria-label"] === "Setup code").length, 0);
  assert.doesNotMatch(lan.text, /Finish on your phone/);
  // The guide is the whole panel: the presence pill would only offer the same guide again.
  assert.equal(lan.button("No player yet"), undefined);
});

test("render: the code step holds a code the player accepts, with Copy as its main action", () => {
  const view = render(model({ devices: {}, mappings: {}, presence: null }), ui.createElement(ui.SetupGuide, { initialStep: "code" }));
  const code = findAll(view.tree, (n) => n.tag === "input" && n.attrs["aria-label"] === "Setup code")[0];
  assert.deepEqual(decodeSetupCode(code.attrs.value), { host: "192.168.1.12", port: 9001, base: "/api/plugins/cartridge-player/api", key: null });
  assert.ok(view.button("Copy code"));
  // Continue is there from the start (a copy the frame refuses must not strand the user), and Back leads to the key.
  assert.ok(!has(view.button("Continue"), "disabled"));
  assert.ok(!has(view.button("Back"), "aria-hidden"));
});

test("render: the phone step's facts are the firmware's own", () => {
  const view = render(model({ devices: {}, mappings: {}, presence: null }), ui.createElement(ui.SetupGuide, { initialStep: "phone" }));
  const lines = findAll(view.tree, (n) => n.tag === "li").map((n) => squash(spoken(n)));
  assert.equal(lines.length, 3);
  // What the firmware does, read from its sources, so the guide can't keep an address the player has moved from.
  const firmware = (file) => readFileSync(join(ROOT, "player/src", file), "utf8");
  const [, ...ip] = /ACCESS_POINT_IP\((\d+), *(\d+), *(\d+), *(\d+)\)/.exec(firmware("hal/wifi_link.cpp"));
  const [, prefix] = /namePrefix = "([^"]+)"/.exec(firmware("core/device.h"));
  const [, holdMs] = /HOLD_MS = (\d+)/.exec(firmware("core/inputs.h"));
  assert.ok(lines[1].includes(`Join the Wi-Fi ${prefix}XXXX`), lines[1]);
  assert.ok(view.text.includes(`Hold the player's BOOT button for ${holdMs / 1000} seconds`), view.text);
  assert.ok(view.text.includes(`Go to http://${ip.join(".")}/`), view.text);
  // It listens for the player rather than asking the user to say when they're done.
  assert.match(view.text, /Listening for your player…/);
  assert.equal(view.button("Continue"), undefined);
});

test("render: a cartridge's details offer Forget unless it's tracking or in a player that's online", () => {
  const details = (patch) => {
    const value = model(patch);
    const item = ui.buildLibrary(value.mappings, value.record, value.lookup, value.live).find((entry) => entry.tag === TAG);
    const props = { item, now: NOW, readOnly: value.mainStatus !== "running", onRelabelled() {}, onForgotten() {} };
    return render(value, ui.createElement(ui.CartridgeDetails, props));
  };
  const offline = { online: false, lastHeardAt: iso(NOW - 3 * 3_600_000), deviceId: DEVICE, name: "Cartridge-A1B2", firmware: "2.0.0", reader: null };
  const idle = slot({ sessionId: null, outcome: "idle" });

  // Out of the player.
  assert.ok(!has(details({}).button("Forget cartridge"), "disabled"));
  // In a player that's online: it says when the cartridge leaves, and that is all there is to it.
  const inPlayer = details({ slot: idle });
  assert.ok(has(inPlayer.button("Take it out of the player to forget it"), "disabled"));
  assert.doesNotMatch(inPlayer.text, /end the session/);
  // Its player has gone quiet: the record may be all that keeps it "in", so Forget is on.
  assert.ok(!has(details({ slot: idle, presence: offline }).button("Forget cartridge"), "disabled"));
  // Still tracking there: off, with the other way out.
  const tracking = details({ ...PLAYING, presence: offline });
  assert.ok(has(tracking.button("Take it out of the player to forget it"), "disabled"));
  assert.match(tracking.text, /If it's already out and its player hasn't said so, end the session in Drift Beacon; then it can be forgotten\./);
  // Read-only while main isn't running, whatever the slot says.
  assert.ok(has(details({ slot: idle, presence: null, mainStatus: "unavailable" }).button("Forget cartridge"), "disabled"));
});

test("render: a player main is still waiting to hear from is a quiet pill, where an offline one is marked", () => {
  const presence = (online) => ({ online, lastHeardAt: iso(NOW - 60_000), deviceId: DEVICE, name: "Cartridge-A1B2", firmware: "2.0.0", reader: null });
  const danger = (button) => button.attrs.class.split(" ").includes("text-danger");
  const waiting = render(model({ presence: presence(null) })).button("Waiting for player");
  assert.ok(waiting, "the pill says it's waiting");
  assert.equal(danger(waiting), false);
  assert.equal(danger(render(model({ presence: presence(false) })).button("Player offline")), true);
});
