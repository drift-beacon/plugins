// Server-renders the shell's real components (bundled once with the esbuild vite ships) and checks what assistive
// technology gets from the markup: accessible names that resolve, and live regions that don't chatter.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_ORDER, DEFAULT_SETTINGS } from "../shared/storage.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const T0 = Date.parse("2026-09-30T10:00:00.000Z");
let ui;
let dir;

before(async () => {
  const require = createRequire(join(ROOT, "package.json"));
  const esbuild = createRequire(require.resolve("vite"))("esbuild");
  const out = await esbuild.build({
    stdin: {
      contents: [
        'export { Notices, noticesFor, Notice } from "./ui/src/components/Notice.tsx";',
        'export { NowCard } from "./ui/src/components/NowCard.tsx";',
        'export { PairStep } from "./ui/src/components/setup/PairStep.tsx";',
        'export { ControllerCard } from "./ui/src/components/ControllerCard.tsx";',
        'export { SettingsPanel } from "./ui/src/components/SettingsPanel.tsx";',
        'export { ModelProvider } from "./ui/src/model.ts";',
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
  dir = mkdtempSync(join(tmpdir(), "nanoleaf-ui-"));
  const file = join(dir, "ui.cjs");
  writeFileSync(file, out.outputFiles[0].contents);
  ui = createRequire(import.meta.url)(file);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/* ---- A small HTML tree, enough for React's static markup ---- */

const VOID = new Set(["input", "br", "img", "hr", "meta", "link"]);

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

function decode(text) {
  return text
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function findAll(node, pred, out = []) {
  if (typeof node === "string") return out;
  if (pred(node)) out.push(node);
  for (const child of node.children) findAll(child, pred, out);
  return out;
}

/** The text a screen reader gets from a subtree: aria-hidden branches left out. */
function spoken(node) {
  if (typeof node === "string") return node;
  if (node.attrs["aria-hidden"] === "true" || node.attrs["aria-hidden"] === "") return "";
  return node.children.map(spoken).join("");
}

const squash = (s) => s.replace(/\s+/g, " ").trim();

/* ---- A model like the live one ---- */

const LAYOUT = {
  controllerId: "S1",
  globalOrientation: 0,
  fetchedAt: "",
  panels: [1, 2, 3].map((id) => ({ id, x: id * 134, y: 0, o: 0, shapeType: 7 })),
};
const DEEP_WORK = {
  id: "deep-work",
  name: "Deep work",
  trackingType: "span",
  color: "#38bdf8",
  iconPath: "M0 0H24V24H0Z",
  archived: false,
  goal: { type: "duration", seconds: 7200 },
  // All time, not a day: a day's start depends on the machine's time zone.
  period: null,
  pinnedBy: [],
};
const LIVE_SESSION = {
  id: "s1",
  activityId: "deep-work",
  type: "span",
  status: "live",
  startedAt: new Date(T0 - 30 * 60_000),
  endedAt: null,
  memberIds: ["u"],
};

function model(patch = {}) {
  const noop = async () => {};
  return {
    userId: "u",
    activities: [DEEP_WORK],
    sessions: [LIVE_SESSION],
    settings: DEFAULT_SETTINGS,
    order: DEFAULT_ORDER,
    layout: LAYOUT,
    controller: { host: "192.168.1.40", port: 16021, name: "The Duck", model: "NL42" },
    connection: { status: "connected", name: "The Duck", host: "192.168.1.40", port: 16021, retryAt: null },
    output: { mode: "live", activityId: "deep-work", fraction: 0.25, inControl: true, detail: null, since: "" },
    mainStatus: "running",
    mainStatusReason: null,
    supportsGoals: true,
    actions: {
      saveSettings: noop,
      saveOrder: noop,
      discover: async () => [],
      pair: async () => ({ name: null, model: null, panels: 0 }),
      forget: noop,
      refresh: noop,
      resume: noop,
      preview: noop,
      brightness: noop,
    },
    onTouch: () => () => {},
    onControllerChanged: () => () => {},
    onResync: () => () => {},
    ...patch,
  };
}

function render(value, component, props = {}) {
  const { createElement, ModelProvider, renderToStaticMarkup } = ui;
  return renderToStaticMarkup(createElement(ModelProvider, { value }, createElement(component, props)));
}

const HANDLERS = { onPairAgain() {}, onEditAddress() {} };

/* ---- Tests ---- */

describe("notices speak state changes, not a ticking clock (ux-10)", () => {
  const offline = model({
    connection: {
      status: "unreachable",
      name: "The Duck",
      host: "192.168.1.40",
      port: 16021,
      retryAt: new Date(T0 + 9_000).toISOString(),
    },
    output: { mode: "disconnected", activityId: null, fraction: null, inControl: false, detail: null, since: "" },
  });

  test("the countdown ticks on screen while the live region's words stay the same", (t) => {
    const at = (ms) => {
      t.mock.method(Date, "now", () => ms);
      const tree = parse(render(offline, ui.Notices, HANDLERS));
      mock.restoreAll();
      return tree;
    };
    const first = at(T0);
    const later = at(T0 + 4_000);
    const regions = [first, later].map((tree) => findAll(tree, (n) => n.attrs.role === "status"));
    assert.equal(regions[0].length, 1, "one live region per notice");
    assert.match(squash(spoken(first)), /Trying again|keeps trying/);
    // What a sighted user sees changes each second...
    assert.match(squash(JSON.stringify(first)), /\b9\b/);
    assert.match(squash(JSON.stringify(later)), /\b5\b/);
    // ...what the live region says doesn't.
    assert.equal(squash(spoken(regions[0][0])), squash(spoken(regions[1][0])));
    assert.match(squash(spoken(regions[0][0])), /Can't reach The Duck.*keeps trying again by itself/);
  });

  test("unreachable: it offers Search again, and suggests a fixed address in the router", async () => {
    const said = squash(spoken(parse(render(offline, ui.Notices, HANDLERS))));
    assert.doesNotMatch(said, /Reserving a fixed address/);
    const info = ui.noticesFor(offline, HANDLERS)[0].info;
    assert.match(info, /new address, the plugin looks for it by itself/);
    assert.match(info, /Reserving a fixed address for it in your router/);
    assert.doesNotMatch(info, /Search again looks right now/);
    const actions = ui.noticesFor(offline, HANDLERS)[0].actions;
    assert.deepEqual(
      actions.map((action) => action.label),
      ["Search again", "Edit address"],
    );
    // The setup has its own buttons: none here while it is open.
    assert.deepEqual(ui.noticesFor(offline, { ...HANDLERS, setupOpen: true })[0].actions, []);

    // Search again asks main to reconnect and search; the existing warning covers a missing controller.
    let refreshes = 0;
    const withRefresh = (refresh) => ({ ...offline, actions: { ...offline.actions, refresh } });
    const found = ui.noticesFor(
      withRefresh(async () => void refreshes++),
      HANDLERS,
    )[0].actions[0];
    await found.run();
    assert.equal(refreshes, 1);
    const failing = (code, message) =>
      ui
        .noticesFor(
          withRefresh(() => Promise.reject(Object.assign(new Error(message), { code }))),
          HANDLERS,
        )[0]
        .actions[0].run();
    await assert.doesNotReject(failing("unavailable", "fetch failed"));
    await assert.rejects(failing("timeout", "refresh timed out"), { message: /^Still searching/ });
    await assert.rejects(failing("stopped", "The plugin stopped"), { message: "The plugin stopped" });
  });

  test("pairing's countdown shows on screen, not in its live region", (t) => {
    t.mock.method(Date, "now", () => T0);
    const target = { host: "192.168.1.40", port: 16021, name: "The Duck" };
    const tree = parse(render(model(), ui.PairStep, { target, onPaired() {}, onBack() {} }));
    const [region] = findAll(tree, (n) => n.attrs["aria-live"] === "polite");
    assert.ok(region, "the step's words are a live region");
    assert.match(JSON.stringify(region), /30 s left/, "the seconds are on screen");
    const said = squash(spoken(region));
    assert.doesNotMatch(said, /\d+ s left/, "and never read out as they tick");
    assert.match(said, /Hold the power button on The Duck.*Listening for up to 30 seconds/);
  });

  test("the notice's buttons sit outside its live region", () => {
    const tree = parse(render(offline, ui.Notices, HANDLERS));
    const [region] = findAll(tree, (n) => n.attrs.role === "status");
    assert.equal(findAll(region, (n) => n.tag === "button").length, 0);
    assert.ok(findAll(tree, (n) => n.tag === "button").length >= 1, "Edit address and Forget still render");
  });

  test("an address main won't connect to shows why, not a retry that isn't coming", () => {
    const error = "8.8.8.8 isn't on your network. Enter the controller's local address, like 192.168.1.40.";
    const refused = model({
      controller: { host: "8.8.8.8", port: 16021, name: "The Duck", model: "NL42" },
      connection: { status: "unreachable", name: "The Duck", host: "8.8.8.8", port: 16021, retryAt: null, error },
      output: offline.output,
    });
    const said = squash(spoken(parse(render(refused, ui.Notices, HANDLERS))));
    assert.match(said, /Can't reach The Duck.*8\.8\.8\.8 isn't on your network\. Enter the controller's local address/);
    assert.doesNotMatch(said, /Nothing answers|Trying again|keeps trying/);
    assert.deepEqual(
      ui.noticesFor(refused, HANDLERS)[0].actions.map((action) => action.label),
      ["Search again", "Edit address"],
    );
  });

  test("opening the page while main's status is unknown shows no notice about main", () => {
    const notices = ui.noticesFor(model({ mainStatus: "connecting", connection: null, output: null }), HANDLERS);
    assert.deepEqual(notices.map((n) => n.id), []);
  });

  test("a platform reason reads as a sentence before what it means for the wall", () => {
    const [notice] = ui.noticesFor(
      model({
        mainStatus: "unavailable",
        mainStatusReason: "Waiting for Drift Beacon",
        connection: null,
        output: null,
      }),
      HANDLERS,
    );
    assert.equal(notice.body, "Waiting for Drift Beacon. The wall keeps whatever it shows until the plugin is back.");
  });
});

describe("settings switches are named by their own words (ux-13)", () => {
  test("every switch's aria-labelledby points at an element with its label", (t) => {
    t.mock.method(Date, "now", () => T0);
    const tree = parse(render(model(), ui.ControllerCard) + render(model(), ui.SettingsPanel));
    const switches = findAll(tree, (n) => n.tag === "input" && n.attrs.role === "switch");
    const byId = new Map(findAll(tree, (n) => n.attrs.id !== undefined).map((n) => [n.attrs.id, n]));
    const names = switches.map((input) => {
      const ids = (input.attrs["aria-labelledby"] ?? "").split(/\s+/).filter(Boolean);
      assert.ok(ids.length > 0, "labelled by something");
      for (const id of ids) assert.ok(byId.has(id), `aria-labelledby="${id}" resolves`);
      return squash(ids.map((id) => spoken(byId.get(id))).join(" "));
    });
    assert.deepEqual(names, [
      "Drive my Nanoleaf",
      "Show goal progress",
      "Faint track",
      "Pulse the wall",
      "Let other plugins control the wall",
    ]);
  });

  test("the words are inside the switch's own label, so clicking them toggles it", (t) => {
    t.mock.method(Date, "now", () => T0);
    const tree = parse(render(model(), ui.ControllerCard) + render(model(), ui.SettingsPanel));
    const labels = findAll(tree, (n) => n.tag === "label" && findAll(n, (c) => c.attrs.role === "switch").length > 0);
    assert.equal(labels.length, 5);
    for (const label of labels) assert.match(squash(spoken(label)), /\w+ .*\. ?$/, "label text and description");
  });

  test("Pinned brightness says it is a share of Max brightness", (t) => {
    t.mock.method(Date, "now", () => T0);
    const markup = render(model(), ui.SettingsPanel);
    assert.match(markup, /Pinned brightness, as a share of Max brightness/);
    assert.match(markup, /% of max/);
  });
});

describe("the Now card claims the wall only while main drives it (decision 5, ux-6)", () => {
  test("another plugin holds the wall: the card says who, not the session underneath", (t) => {
    t.mock.method(Date, "now", () => T0);
    const effect = { id: "e1", type: "shuffle", colors: [[255, 0, 0], [0, 0, 255]], periodMs: 900, color: null, startedAt: T0 };
    const held = model({
      control: { holder: "magic-cube", leaseId: "l1", effect },
      output: { mode: "control", activityId: null, fraction: null, inControl: true, detail: null, since: "" },
    });
    const text = squash(spoken(parse(render(held, ui.NowCard))));
    assert.match(text, /Now on your wall/);
    assert.match(text, /Controlled/);
    assert.match(text, /Magic Cube controls your wall/);
    assert.doesNotMatch(text, /Every panel changes|wave of|lock to one colour/);
    assert.doesNotMatch(text, /Deep work|Would show/);
  });

  test("in control: 'Now on your wall', and nothing says it isn't", (t) => {
    t.mock.method(Date, "now", () => T0);
    const text = squash(spoken(parse(render(model(), ui.NowCard))));
    assert.match(text, /Now on your wall/);
    assert.match(text, /Deep work/);
    assert.match(text, /Live/);
    assert.doesNotMatch(text, /Not on your wall|Would show/);
  });

  test("offline, busy, stepped aside, main down or unpaired: Would show with a status badge", (t) => {
    t.mock.method(Date, "now", () => T0);
    const quiet = { activityId: null, fraction: null, inControl: false, detail: null, since: "" };
    const cases = [
      [
        {
          connection: { status: "unreachable", name: "The Duck", host: "192.168.1.40", port: 16021, retryAt: null },
          output: { ...quiet, mode: "disconnected" },
        },
        /Offline/,
      ],
      [{ output: { ...quiet, mode: "busy" } }, /Busy/],
      [{ output: { ...quiet, mode: "yielded" } }, /Stepped aside/],
      [{ mainStatus: "unavailable", connection: null, output: null }, /Not running/],
      [{ controller: null, connection: null, output: null }, /Not paired/],
    ];
    for (const [patch, reason] of cases) {
      const text = squash(spoken(parse(render(model(patch), ui.NowCard))));
      assert.match(text, /Would show on your wall/, JSON.stringify(patch));
      assert.doesNotMatch(text, /Not on your wall: /, JSON.stringify(patch));
      assert.match(text, reason, JSON.stringify(patch));
    }
  });

  test("the goal shows the app's rounded percent (decision 2, ux-5)", (t) => {
    // 30 min of a 2 h goal is 25%; 52 min 12 s is 43.5%, which the app shows as 44%.
    t.mock.method(Date, "now", () => T0 + 22 * 60_000 + 12_000);
    const text = squash(spoken(parse(render(model(), ui.NowCard))));
    assert.match(text, /44%/);
  });
});
