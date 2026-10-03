// The player's setup page (player/portal/), as the player serves it: the script inside the built page runs against a
// small fake DOM and a fake player API, and is driven the way a phone would (clicks, typing, submit). The fake DOM
// has no HTML parser and refuses innerHTML, so device text can only ever land as text.
//
// The fake player answers whatever a test tells it to, so what the page sends and shows is also put to the player's
// own rules: player/portal/contract.cpp runs the firmware's core (its form reader and planConnect, the Wi-Fi rules,
// the field and phase names, the /api/state it writes, its scan) on a host. Needs a C++17 compiler (CXX picks one);
// without one those checks are skipped and one test fails, saying what to install: the policy of the firmware's own
// suite (player/tests/toolchain.mjs).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import { MAX_GZIP_BYTES, buildPage } from "../player/portal/build.mjs";
import { refusal } from "../player/portal/dev-server.mjs";
import { CXX, missingCompiler } from "../player/tests/toolchain.mjs";
import { decodeSetupCode, encodeSetupCode, setupFieldError } from "../shared/setup-code.ts";

const headerUrl = new URL("../player/src/portal_page.h", import.meta.url);
const page = buildPage();
const FLAGS = ["-std=c++17", "-Wall", "-Wextra", "-pedantic", "-Werror"];

let scratch;
/** Why nothing was compiled, on a machine without a C++ compiler. */
let missing = null;
/** player/portal/contract.cpp, built; null on a machine without a C++ compiler. */
let contractBinary = null;

/** Compiles one source into the scratch folder. */
function compile(source, name) {
  const binary = join(scratch, name);
  try {
    execFileSync(CXX, [...FLAGS, source, "-o", binary], { stdio: "pipe" });
  } catch (error) {
    throw new Error(error.stderr?.toString() || error.message);
  }
  return binary;
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "portal-page-"));
  missing = await missingCompiler("the setup page's contract with the firmware's core was");
  if (missing) return;
  contractBinary = compile(fileURLToPath(new URL("../player/portal/contract.cpp", import.meta.url)), "contract");
});

after(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs a contract command with one JSON object per stdin line: one parsed object per output line, or null. */
function contract(command, inputs = []) {
  if (!contractBinary) return null;
  const stdout = execFileSync(contractBinary, [command], {
    input: inputs.map((input) => JSON.stringify(input)).join("\n"),
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The form must be one the player reads whole and accepts, joining and probing exactly `expected`. */
function assertPlanned(form, saved, expected) {
  const plans = contract("connect", [{ saved, form }]);
  if (plans) assert.deepEqual(plans[0], { ok: true, ...expected });
}

const DEVICE = { id: "cp-a1b2c3", name: "Cartridge-A1B2", fw: "2.0.0", reader: "ok" };
const TOKEN = "8f3a5c1d";
const IDLE = { id: 0, phase: "idle", message: "", field: null, ip: null, ssid: null };
const SAVED = {
  ssid: "Home", hasPassword: true, host: "192.168.1.12", port: 9001, base: "/api/plugins/cartridge-player/api", hasKey: true,
};
/** What the player holds behind SAVED's flags. */
const SAVED_SECRETS = { ...SAVED, password: "home-password", key: "db_saved-key-0123" };
const HUB = { host: SAVED.host, port: SAVED.port, base: SAVED.base };
const NETWORKS = [
  { ssid: "Home", rssi: -48, secure: true },
  { ssid: "Office", rssi: -62, secure: true },
  { ssid: "Café guest", rssi: -80, secure: false },
];
const KEY_NEEDED = "Paste the API key from Drift Beacon (Workspace settings → API Keys)";
/** For the saved hub reached another way: the sentence the player refuses a kept key with. */
const KEY_STAYS = "Paste the API key: the saved one is only kept on the saved Wi-Fi network";
/** For the saved hub on the saved network with a password typed: the page's own, since a blank one is a way out. */
const KEY_NOT_WITH_TYPED =
  "Paste the API key, or leave the Wi-Fi password blank: the saved key isn't kept with a typed password";
const FORGOTTEN = "The player started setup again. Check the settings and press Connect.";
const SCAN_FAILED = "Couldn't get a new list of networks. Scan again, or choose Other network.";
const CODE_WITH_KEY = encodeSetupCode({ host: "192.168.1.12", port: 9001, base: SAVED.base, key: "db_0123456789abcdef" });
const CODE_WITHOUT_KEY = encodeSetupCode({ host: "beacon.local", port: 9001, base: SAVED.base, key: null });

class FakeElement {
  constructor(document, tag, attributes = {}) {
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.id = attributes.id ?? "";
    this.className = attributes.class ?? "";
    this.hidden = "hidden" in attributes;
    this.disabled = "disabled" in attributes;
    this.value = attributes.value ?? "";
    this.type = attributes.type ?? "";
    this.placeholder = attributes.placeholder ?? "";
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    this.ownText = "";
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith("aria-")) this.attributes[name] = value;
    }
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.ownText = String(value);
    this.children = [];
  }

  set innerHTML(value) {
    throw new Error(`innerHTML used with ${value}`);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  fire(type) {
    // As in a browser: a disabled control can't be pressed.
    if (type === "click" && this.disabled) return;
    for (const listener of this.listeners[type] ?? []) listener({ type, target: this, preventDefault() {} });
  }
}

/** A document holding every element of the built page that has an id, with the attributes the script reads. */
function fakeDocument() {
  const document = { title: "", activeElement: null, byId: new Map() };
  for (const [, tag, rest] of page.matchAll(/<([a-z0-9]+)(\s[^>]*)?>/g)) {
    const attributes = {};
    for (const [, name, value] of (rest ?? "").matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) attributes[name] = value ?? "";
    if (attributes.id) document.byId.set(attributes.id, new FakeElement(document, tag, attributes));
  }
  document.getElementById = (id) => document.byId.get(id) ?? null;
  document.createElement = (tag) => new FakeElement(document, tag);
  return document;
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Runs the page's own script against a fake player. `world` is what the player answers: `state` and `scan` bodies
 * (`scanStatus` when the scan isn't answered with 200; a scan asked without the state's token is refused, as the
 * player refuses it), `connect(fields)` for POST /api/connect, `post(url, token)`
 * for the other POSTs (200 when it returns nothing), and `drop` / `hang` to stop answering /api/state the way a
 * phone that left the access point sees it. Timers only run on `tick()`, so polling is stepped by hand.
 */
async function openPage(world) {
  const document = fakeDocument();
  const timers = new Map();
  let nextTimer = 1;
  const requests = [];
  const answer = (url, init) => {
    const method = init.method ?? "GET";
    if (method === "GET" && url === "/api/state") {
      if (world.drop) return "drop";
      if (world.hang) return "hang";
      return { body: world.state };
    }
    if (method === "GET" && url === "/api/scan") {
      if (init.headers?.["X-Setup-Token"] !== world.state.token) return { status: 403, body: { error: "Reload the setup page and try again", field: null } };
      return { status: world.scanStatus, body: world.scan };
    }
    if (method === "POST" && url === "/api/connect") return world.connect(Object.fromEntries(new URLSearchParams(init.body)));
    if (method === "POST") return world.post?.(url, init.headers["X-Setup-Token"]) ?? { status: 200, body: { ok: true } };
    return { status: 404, body: {} };
  };
  const context = vm.createContext({
    document,
    navigator: world.navigator ?? {},
    AbortController,
    URLSearchParams,
    atob,
    setTimeout: (callback) => {
      timers.set(nextTimer, callback);
      return nextTimer++;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, init = {}) => {
      requests.push({ url, init });
      const reply = answer(url, init);
      if (reply === "drop") throw new TypeError("Failed to fetch");
      if (reply === "hang") {
        return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return { status: reply.status ?? 200, json: async () => structuredClone(reply.body) };
    },
  });
  vm.runInContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await settle();
  const $ = (id) => document.getElementById(id);
  return {
    $,
    context,
    document,
    requests,
    posts: (url) => requests.filter((request) => request.url === url && request.init.method === "POST"),
    async tick() {
      const due = [...timers.values()];
      timers.clear();
      for (const callback of due) callback();
      await settle();
    },
    rows: () => $("networks").children.map((item) => item.children[0]),
    row(ssid) {
      return this.rows().find((row) => row.children[0].textContent === ssid);
    },
    async type(id, value) {
      $(id).value = value;
      $(id).fire("input");
      await settle();
    },
    async submit() {
      $("form").fire("submit");
      await settle();
    },
    /** How often the page has asked the player for its state. */
    stateRequests: () => requests.filter((request) => request.url === "/api/state").length,
    /** The checklist steps drawn as in progress. */
    activeSteps: () => ["wifi", "ip", "plugin", "saved"].filter((step) => $(`step-${step}`).className === "active"),
    visibleErrors: () =>
      Object.fromEntries(
        [...document.byId.values()]
          .filter((element) => element.id.endsWith("-error") && !element.hidden)
          .map((element) => [element.id.slice(0, -"-error".length), element.textContent]),
      ),
  };
}

function world(overrides = {}) {
  return {
    state: { device: DEVICE, token: TOKEN, configured: false, saved: null, attempt: IDLE },
    scan: { scanning: false, failed: false, networks: NETWORKS },
    connect: () => ({ status: 202, body: { attempt: 1 } }),
    ...overrides,
  };
}

/** A player that has been set up before: SAVED is saved, and nothing is running. */
const configuredPlayer = (overrides = {}) =>
  world({ state: { device: DEVICE, token: TOKEN, configured: true, saved: SAVED, attempt: IDLE }, ...overrides });

/** The page as it opens on a player whose last attempt is `attempt`. */
function reopen(attempt, player = configuredPlayer()) {
  player.state = { ...player.state, attempt: { id: 3, message: "", field: null, ip: null, ...attempt } };
  return openPage(player);
}

const formOf = (request) => Object.fromEntries(new URLSearchParams(request.init.body));

test("the committed header is a fresh build of player/portal and fits the page budget", () => {
  const header = readFileSync(headerUrl, "utf8");
  const array = header.match(/static const uint8_t PORTAL_PAGE_GZ\[\] PROGMEM = \{([\s\S]*?)\};/);
  assert.ok(array, "portal_page.h defines PORTAL_PAGE_GZ");
  const bytes = Buffer.from([...array[1].matchAll(/0x([0-9a-f]{2})/g)].map((match) => parseInt(match[1], 16)));
  assert.equal(Number(header.match(/static const size_t PORTAL_PAGE_GZ_LEN = (\d+);/)[1]), bytes.length);
  assert.equal(gunzipSync(bytes).toString("utf8"), page, "portal_page.h is stale: run node player/portal/build.mjs");
  assert.ok(bytes.length <= MAX_GZIP_BYTES, `${bytes.length} bytes gzipped, over ${MAX_GZIP_BYTES}`);
});

test("the header compiles on a host, without the Arduino core", (t) => {
  const source = join(scratch, "check.cpp");
  writeFileSync(
    source,
    `#include "${fileURLToPath(headerUrl)}"\nint main() { return sizeof(PORTAL_PAGE_GZ) == PORTAL_PAGE_GZ_LEN ? 0 : 1; }\n`,
  );
  if (missing) return t.skip(missing);
  execFileSync(compile(source, "check"));
});

// Without a compiler this one test fails, saying what to install, and the checks that need one are skipped: the page
// is never reported as judged by the player's rules when it wasn't.
test("a C++17 compiler is here to judge the page by the player's own rules", () => {
  assert.equal(missing, null, missing ?? undefined);
});

test("the page loads nothing from elsewhere and never parses strings as HTML", () => {
  assert.doesNotMatch(page, /<link|\s(src|href)=|@import/);
  assert.doesNotMatch(page, /url\((?!"data:)/);
  assert.doesNotMatch(page, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(page, /^<!doctype html><html lang="en"><head><meta charset="utf-8">/);
});

test("scanned networks land as text, de-duplicated, with the saved one marked, after polling a running scan", async () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const player = configuredPlayer({ scan: { scanning: true, networks: [] } });
  const view = await openPage(player);
  assert.equal(view.$("scan-status").textContent, "Looking for networks…");
  assert.equal(view.$("rescan").disabled, true);

  player.scan = {
    scanning: false,
    networks: [{ ssid: hostile, rssi: -50, secure: true }, ...NETWORKS, { ssid: "Home", rssi: -90, secure: true }],
  };
  await view.tick();
  assert.deepEqual(view.rows().map((row) => row.children[0].textContent), [hostile, "Home", "Office", "Café guest"]);
  const name = view.row(hostile).children[0];
  assert.equal(name.children.length, 0);
  assert.equal(view.row(hostile).textContent, `${hostile}, secured, strong signal`);
  assert.equal(view.row("Home").textContent, "HomeSaved, secured, strong signal");
  assert.equal(view.row("Café guest").textContent, "Café guest, open, weak signal");
  assert.equal(view.row("Home").getAttribute("aria-pressed"), "true");
  assert.equal(view.$("scan-status").textContent, "");
  assert.equal(view.$("rescan").disabled, false);
});

const scans = (view) => view.requests.filter((request) => request.url === "/api/scan").length;

test("what only the page can send: its scans and its state polls carry the token, which is what keeps setup open", async () => {
  const sent = (view, url) =>
    view.requests.filter((request) => request.url === url && !request.init.method).map((request) => request.init.headers?.["X-Setup-Token"]);
  const player = configuredPlayer({ scan: { scanning: true, failed: false, networks: [] } });
  const view = await openPage(player);
  // The token comes from the first state, so that request has none; the scan waits for it and is never refused.
  assert.deepEqual(sent(view, "/api/state"), [undefined]);
  assert.deepEqual(sent(view, "/api/scan"), [TOKEN]);
  assert.equal(view.$("scan-status").textContent, "Looking for networks…");
  await view.tick();
  assert.deepEqual(sent(view, "/api/scan"), [TOKEN, TOKEN], "a poll of a running scan");

  player.scan = { scanning: false, failed: false, networks: NETWORKS };
  await view.tick();
  player.connect = () => ({ status: 202, body: { attempt: 1 } });
  player.state = { ...player.state, attempt: { ...IDLE, id: 1, phase: "joining", ssid: "Home" } };
  await view.submit();
  await view.tick();
  const polls = sent(view, "/api/state").slice(1);
  assert.ok(polls.length > 0 && polls.every((token) => token === TOKEN), "following a Connect");

  // A player that restarted since: the scan is refused for the old token, and asked once more with the new one.
  const restarted = configuredPlayer();
  const later = await openPage(restarted);
  restarted.state = { ...restarted.state, token: "fresh" };
  later.$("rescan").fire("click");
  await settle();
  assert.deepEqual(sent(later, "/api/scan"), [TOKEN, TOKEN, "fresh"]);
  assert.equal(later.$("scan-status").textContent, "");
  assert.match(readFileSync(new URL("../player/portal/dev-server.mjs", import.meta.url), "utf8"), /"\/api\/scan"\) \{\s*(\/\/.*\s*)*if \(req\.headers\["x-setup-token"\] !== token\) \{\s*send\(res, 403,/);
});

test("a scan the player gives up on shows as failed with the last list, and Scan again retries", async () => {
  // The saved network (Home) is missing from the last list: a failed scan is no reason to think it hidden.
  const player = configuredPlayer({ scan: { scanning: true, failed: false, networks: [] } });
  const view = await openPage(player);
  assert.equal(view.$("scan-status").textContent, "Looking for networks…");

  player.scan = { scanning: false, failed: true, networks: [NETWORKS[1]] };
  await view.tick();
  assert.equal(view.$("scan-status").textContent, SCAN_FAILED);
  assert.equal(view.$("rescan").disabled, false);
  assert.deepEqual(view.rows().map((row) => row.children[0].textContent), ["Office"]);
  assert.equal(view.$("ssid-wrap").hidden, true);
  const asked = scans(view);
  await view.tick();
  assert.equal(scans(view), asked, "a failed scan isn't polled");

  // An answer that isn't the player's list is a failure too, and keeps the list there was.
  player.scanStatus = 500;
  player.scan = { error: "The answer didn't fit", field: null };
  view.$("rescan").fire("click");
  await settle();
  assert.equal(scans(view), asked + 1);
  assert.equal(view.$("scan-status").textContent, SCAN_FAILED);
  assert.equal(view.rows().length, 1);

  player.scanStatus = 200;
  player.scan = { scanning: false, failed: false, networks: NETWORKS };
  view.$("rescan").fire("click");
  await settle();
  assert.equal(view.$("scan-status").textContent, "");
  assert.equal(view.rows().length, 3);
});

test("a player that never stops saying it is scanning isn't waited on for ever", async () => {
  const view = await openPage(world({ scan: { scanning: true, failed: false, networks: [] } }));
  const { SCAN_POLLS, SCAN_POLL_MS } = view.context;
  // The player gives a scan 12 s before it says it failed: the page waits longer than that.
  assert.ok((SCAN_POLLS - 1) * SCAN_POLL_MS > 12000);
  // Left alone for 45 s of the page's time.
  for (let i = 0; i < 30; i++) await view.tick();
  assert.equal(scans(view), SCAN_POLLS);
  assert.equal(view.$("scan-status").textContent, SCAN_FAILED);
  assert.equal(view.$("rescan").disabled, false);

  // Scan again waits as long again.
  view.$("rescan").fire("click");
  await settle();
  assert.equal(view.$("scan-status").textContent, "Looking for networks…");
  for (let i = 0; i < 30; i++) await view.tick();
  assert.equal(scans(view), SCAN_POLLS * 2);
});

test("a scan the player's radio never takes is waited out until the player says it failed", async (t) => {
  if (missing) return t.skip(missing);
  const player = world();
  let asked = 0;
  let told = [{ scanning: false, failed: false }];
  Object.defineProperty(player, "scan", { get: () => ({ ...told[asked++], networks: [] }) });
  const view = await openPage(player);
  const { SCAN_POLLS, SCAN_POLL_MS } = view.context;
  // What the player's own scan tells a page that asks as often as this one does.
  [{ told }] = contract("scan", [{ pollMs: SCAN_POLL_MS, polls: 20 }]);
  const failedAt = told.findIndex((answer) => answer.failed);
  assert.ok(failedAt > 0 && failedAt < SCAN_POLLS - 1, "the player gives up before the page stops waiting by itself");
  assert.deepEqual(told[failedAt + 1], { scanning: true, failed: false }, "the request after a failure starts over");

  asked = 0;
  view.$("rescan").fire("click");
  await settle();
  assert.equal(view.$("scan-status").textContent, "Looking for networks…");
  for (let i = 0; i < 30; i++) await view.tick();
  assert.equal(asked, failedAt + 1, "the page asks until the failure and no further");
  assert.equal(view.$("scan-status").textContent, SCAN_FAILED);
  view.$("rescan").fire("click");
  await settle();
  assert.equal(view.$("scan-status").textContent, "Looking for networks…");
});

test("saved settings prefill the form but never a secret; blank keeps them only where they belong", async () => {
  const player = configuredPlayer();
  const view = await openPage(player);
  assert.equal(view.$("details").hidden, false);
  assert.deepEqual([view.$("host").value, view.$("port").value, view.$("base").value], ["192.168.1.12", "9001", SAVED.base]);
  assert.equal(view.$("password").value, "");
  assert.equal(view.$("key").value, "");
  assert.equal(view.$("password").placeholder, "Saved password");
  assert.equal(view.$("key").placeholder, "Saved key");

  view.row("Office").fire("click");
  await view.submit();
  assert.deepEqual(view.visibleErrors(), { password: "Enter the password for Office", key: KEY_STAYS });

  view.row("Home").fire("click");
  assert.equal(view.$("key").placeholder, "Saved key");
  await view.type("host", "192.168.1.13");
  assert.equal(view.$("key").placeholder, "db_…");
  await view.submit();
  assert.deepEqual(view.visibleErrors(), { key: KEY_NEEDED });
  assert.equal(view.posts("/api/connect").length, 0);

  await view.type("host", "192.168.1.12");
  await view.submit();
  assert.deepEqual(view.visibleErrors(), {});
  const form = formOf(view.posts("/api/connect")[0]);
  assert.deepEqual(form, {
    ssid: "Home", password: "", keepPassword: "1",
    host: "192.168.1.12", port: "9001", base: SAVED.base, key: "", keepKey: "1",
  });
  assertPlanned(form, SAVED_SECRETS, { ssid: "Home", password: SAVED_SECRETS.password, ...HUB, key: SAVED_SECRETS.key });
});

test("the saved key is kept only on the saved network with its saved password kept, never typed", async () => {
  const player = configuredPlayer();
  const view = await openPage(player);
  const keyField = () => [view.$("key").placeholder, view.$("key-hint").textContent];
  const kept = ["Saved key", "Leave it blank to keep the saved key."];
  const elsewhere = ["db_…", "A different Wi-Fi network needs the API key again, or a setup code that includes it."];
  // Said before Connect is pressed: what a typed password costs, and the way back.
  const typed = [
    "db_…",
    "A typed Wi-Fi password needs the API key again, or a setup code that includes it. " +
      "Leave the password blank to keep the saved key.",
  ];
  assert.deepEqual(keyField(), kept);

  // Another network, same hub: the key would travel over a network it was never used on.
  view.row("Office").fire("click");
  assert.deepEqual(keyField(), elsewhere);
  await view.type("password", "correct horse");
  await view.submit();
  assert.deepEqual(view.visibleErrors(), { key: KEY_STAYS });
  // The page stops it in the player's own words: this is what the player says to the form with the key kept.
  const keptElsewhere = { ssid: "Office", password: "correct horse", ...HUB, port: "9001", key: "", keepKey: "1" };
  const verdicts = contract("connect", [{ saved: SAVED_SECRETS, form: keptElsewhere }]);
  if (verdicts) assert.deepEqual(verdicts[0], { ok: false, field: "key", message: KEY_STAYS });

  // The saved network with a typed password, the saved one included: the player keeps its key only beside a kept
  // password, or its answer would tell whoever is at this open page whether a guess at the password was right.
  view.row("Home").fire("click");
  assert.deepEqual(keyField(), kept);
  for (const password of [SAVED_SECRETS.password, "newpassword9"]) {
    await view.type("password", password);
    assert.deepEqual(keyField(), typed, password);
    await view.submit();
    assert.deepEqual(view.visibleErrors(), { key: KEY_NOT_WITH_TYPED }, password);
    // What the player makes of the form the page didn't send. Refused for the right password as for a wrong one.
    const keptWithTyped = { ssid: "Home", password, ...HUB, port: "9001", key: "", keepKey: "1" };
    const [verdict] = contract("connect", [{ saved: SAVED_SECRETS, form: keptWithTyped }]) ?? [];
    if (verdict) assert.deepEqual([verdict.ok, verdict.field], [false, "key"], password);
  }
  assert.equal(view.posts("/api/connect").length, 0);

  // With the saved password itself typed, a setup code that carries a key connects without the saved one.
  view.$("mode").fire("click");
  await view.type("code", CODE_WITH_KEY);
  await view.type("password", SAVED_SECRETS.password);
  await view.submit();
  const coded = formOf(view.posts("/api/connect")[0]);
  assert.deepEqual(coded, { ssid: "Home", password: SAVED_SECRETS.password, code: CODE_WITH_KEY });
  const { password } = SAVED_SECRETS;
  assertPlanned(coded, SAVED_SECRETS, { ssid: "Home", password, ...HUB, key: "db_0123456789abcdef" });
});

test("a password typed for the saved network connects with the key typed again", async () => {
  const view = await openPage(configuredPlayer());
  await view.type("password", "newpassword9");
  await view.type("key", "db_0123456789abcdef");
  await view.submit();
  const form = formOf(view.posts("/api/connect")[0]);
  assert.deepEqual(form, { ssid: "Home", password: "newpassword9", ...HUB, port: "9001", key: "db_0123456789abcdef" });
  assertPlanned(form, SAVED_SECRETS, { ssid: "Home", password: "newpassword9", ...HUB, key: "db_0123456789abcdef" });
});

test("the saved key is offered again once the network is the saved one, typed by name too", async () => {
  const view = await openPage(configuredPlayer());
  await view.type("password", "newpassword9");
  assert.equal(view.$("key").placeholder, "db_…");
  await view.type("password", "");
  assert.equal(view.$("key").placeholder, "Saved key");

  view.$("other").fire("click");
  assert.equal(view.$("key").placeholder, "db_…");
  await view.type("ssid", "Home");
  assert.equal(view.$("key").placeholder, "Saved key");
  await view.submit();
  assert.deepEqual(formOf(view.posts("/api/connect")[0]), {
    ssid: "Home", password: "", keepPassword: "1", ...HUB, port: "9001", key: "", keepKey: "1",
  });

  // A saved open network has no password to keep, and blank still means the same network.
  const open = { ...SAVED, ssid: "Café guest", hasPassword: false };
  const player = configuredPlayer();
  player.state = { ...player.state, saved: open };
  const guest = await openPage(player);
  assert.equal(guest.$("key").placeholder, "Saved key");
  await guest.submit();
  const form = formOf(guest.posts("/api/connect")[0]);
  assert.deepEqual(form, { ssid: "Café guest", password: "", ...HUB, port: "9001", key: "", keepKey: "1" });
  const secrets = { ...SAVED_SECRETS, ssid: "Café guest", password: "" };
  assertPlanned(form, secrets, { ssid: "Café guest", password: "", ...HUB, key: SAVED_SECRETS.key });
});

test("the Wi-Fi rules are the player's own, counted in bytes", async () => {
  const view = await openPage(world());
  const hex = "0123456789abcdefABCDEF".repeat(3).slice(0, 64);
  // Each value and whether it's allowed. "é" is 2 bytes, "п" 2, "€" 3, "😀" 4.
  const ssids = [["", false], ["a", true], ["é".repeat(16), true], ["a".repeat(32), true], ["😀".repeat(8), true],
    ["a".repeat(33), false], ["é".repeat(16) + "a", false], ["€".repeat(11), false]];
  const passwords = [["", true], ["1234567", false], ["12345678", true], ["пароль", true], ["a".repeat(63), true],
    ["z".repeat(64), false], [hex, true], [`${hex.slice(0, 63)}g`, false], ["п".repeat(36), false],
    ["tab\tinside", false], ["delete\x7finside", false], ["€".repeat(21), true], ["€".repeat(22), false]];
  const check = (field, rule, cases) => {
    const verdicts = contract("wifi", cases.map(([value]) => ({ field, value })));
    cases.forEach(([value, allowed], index) => {
      const error = view.context[rule](value);
      assert.equal(error === null, allowed, `${field} ${JSON.stringify(value)}`);
      // An empty name is asked for in the page's own words: it knows whether a list or a field is showing.
      if (verdicts && value !== "") assert.equal(error, verdicts[index].error, `${field} ${JSON.stringify(value)}`);
      if (verdicts) assert.equal(verdicts[index].error === null, allowed, `the player, ${field} ${JSON.stringify(value)}`);
    });
  };
  check("ssid", "ssidError", ssids);
  check("password", "passwordError", passwords);
});

test("a network or password the player would refuse is stopped on its field, and nothing is posted", async () => {
  const view = await openPage(world());
  await view.type("code", CODE_WITH_KEY);
  await view.submit();
  assert.deepEqual(view.visibleErrors(), { ssid: "Choose a Wi-Fi network" });
  assert.equal(view.document.activeElement, view.$("other"));

  view.$("other").fire("click");
  await view.submit();
  assert.deepEqual(view.visibleErrors(), { ssid: "Enter the network name" });
  await view.type("ssid", "é".repeat(17));
  await view.submit();
  assert.deepEqual(view.visibleErrors(), { ssid: "A network name is at most 32 bytes" });

  view.row("Office").fire("click");
  const refused = { password: "A Wi-Fi password is 8 to 63 characters" };
  for (const password of ["1234567", "x".repeat(64), "п".repeat(36)]) {
    await view.type("password", password);
    await view.submit();
    assert.deepEqual(view.visibleErrors(), refused, password);
  }
  assert.equal(view.posts("/api/connect").length, 0);

  // Six Cyrillic letters are twelve bytes: a valid passphrase.
  await view.type("password", "пароль");
  await view.submit();
  assert.deepEqual(view.visibleErrors(), {});
  const form = formOf(view.posts("/api/connect")[0]);
  assert.deepEqual(form, { ssid: "Office", password: "пароль", code: CODE_WITH_KEY });
  assertPlanned(form, {}, { ssid: "Office", password: "пароль", ...HUB, key: "db_0123456789abcdef" });
});

test("the page decodes setup codes exactly as shared/setup-code.ts does", async () => {
  const view = await openPage(world());
  const pageDecode = (text) => JSON.parse(JSON.stringify(view.context.decodeSetupCode(text)));
  const encode = (payload) => "CP1-" + Buffer.from(JSON.stringify(payload)).toString("base64url");
  const codes = [
    CODE_WITH_KEY,
    CODE_WITHOUT_KEY,
    `  ${CODE_WITH_KEY}\n`,
    encodeSetupCode({ host: "hub", port: 1, base: "/api/plugins/a.b_c-d/api", key: "!~".repeat(4) }),
    CODE_WITH_KEY.slice(0, -3),
    CODE_WITH_KEY.toLowerCase(),
    CODE_WITH_KEY.replace("CP1-", "CP2-"),
    `${CODE_WITH_KEY}=`,
    "CP1-",
    "CP1-!!!!",
    "db_0123456789abcdef",
    "/api/plugins/cartridge-player/api",
    encode([1, 2, 3]),
    encode("text"),
    encode({ h: "192.168.1.12", p: "9001", b: SAVED.base }),
    encode({ h: "192.168.1.12", p: 9001.5, b: SAVED.base }),
    encode({ h: "192.168.1.12", p: 0, b: SAVED.base }),
    encode({ h: "192.168.1.12", p: 65536, b: SAVED.base }),
    encode({ h: "http://hub", p: 9001, b: SAVED.base }),
    encode({ h: "192.168.1.12", p: 9001, b: "/api/plugins/../api" }),
    encode({ h: "192.168.1.12", p: 9001, b: "/api/plugins/x/api/player" }),
    encode({ h: "192.168.1.12", p: 9001, b: SAVED.base, k: "short" }),
    encode({ h: "192.168.1.12", p: 9001, b: SAVED.base, k: "has a space" }),
    encode({ h: "192.168.1.12", p: 9001, b: SAVED.base, k: null }),
    encode({ h: "hûb", p: 9001, b: SAVED.base }),
  ];
  for (const code of codes) assert.deepEqual(pageDecode(code), decodeSetupCode(code), code);
  assert.ok(codes.filter((code) => decodeSetupCode(code) === null).length >= 18, "most cases are rejections");

  const values = [
    "192.168.1.12", "", "a b", 9001, 0, 70000, "9001", 1.5, SAVED.base, "/api/plugins/./api", null, "db_x", "db_0123456789",
  ];
  for (const field of ["host", "port", "base", "key"]) {
    for (const value of values) {
      assert.equal(view.context.fieldError(field, value), setupFieldError(field, value), `${field} ${value}`);
    }
  }
});

test("Connect posts the form with the setup token; a code without a key asks for one", async () => {
  const view = await openPage(world());
  assert.equal(view.$("details").hidden, true);
  assert.equal(view.$("exit").hidden, true);
  view.row("Office").fire("click");
  await view.type("password", "correct horse");

  await view.type("code", "CP1-nonsense");
  assert.deepEqual(view.visibleErrors(), {
    code: "That isn't a whole setup code. Copy it again from the Cartridge Player page in Drift Beacon.",
  });
  await view.type("code", CODE_WITHOUT_KEY);
  assert.equal(view.$("code-summary").textContent, "Hub beacon.local:9001 · add the API key below");
  assert.equal(view.$("key-wrap").hidden, false);
  await view.submit();
  assert.deepEqual(view.visibleErrors(), { key: KEY_NEEDED });
  assert.equal(
    view.$("key-hint").textContent,
    "Create one in Drift Beacon under Workspace settings → API Keys, and give it the player's name.",
  );

  await view.type("code", CODE_WITH_KEY);
  assert.equal(view.$("code-summary").textContent, "Hub 192.168.1.12:9001 · key included");
  assert.equal(view.$("key-wrap").hidden, true);
  await view.submit();
  const [post] = view.posts("/api/connect");
  assert.equal(post.init.headers["X-Setup-Token"], TOKEN);
  assert.equal(post.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.deepEqual(formOf(post), { ssid: "Office", password: "correct horse", code: CODE_WITH_KEY });
  assertPlanned(formOf(post), {}, { ssid: "Office", password: "correct horse", ...HUB, key: "db_0123456789abcdef" });
  assert.equal(view.$("connect").disabled, true);
});

test("a code without its key is sent as hub fields with the key typed beside it", async () => {
  const view = await openPage(world());
  view.row("Café guest").fire("click");
  assert.equal(view.$("password-wrap").hidden, true);
  await view.type("code", CODE_WITHOUT_KEY);
  await view.type("key", " db_0123456789abcdef ");
  await view.submit();
  const form = formOf(view.posts("/api/connect")[0]);
  assert.deepEqual(form, {
    ssid: "Café guest", password: "", host: "beacon.local", port: "9001", base: SAVED.base, key: "db_0123456789abcdef",
  });
  assertPlanned(form, {}, {
    ssid: "Café guest", password: "", host: "beacon.local", port: 9001, base: SAVED.base, key: "db_0123456789abcdef",
  });
});

test("the checklist follows the attempt, and a failure lands on its field", async () => {
  const player = world();
  const view = await openPage(player);
  view.row("Office").fire("click");
  await view.type("password", "correct horse");
  await view.type("code", CODE_WITH_KEY);
  await view.submit();
  assert.equal(view.$("progress").hidden, false);

  // Each step as [state, visible label]; the screen-reader suffix (", done") is checked once below.
  const steps = () =>
    ["wifi", "ip", "plugin", "saved"].map((step) => [view.$(`step-${step}`).className, view.$(`step-${step}`).ownText]);
  player.state = { ...player.state, attempt: { id: 1, phase: "joining", message: "", field: null, ip: null } };
  await view.tick();
  assert.deepEqual(steps(), [
    ["active", "Joining Office"], ["", "Getting an address"], ["", "Reaching the plugin"], ["", "Saving"],
  ]);

  player.state = { ...player.state, attempt: { id: 1, phase: "probing", message: "", field: null, ip: "192.168.1.57" } };
  await view.tick();
  assert.deepEqual(steps(), [
    ["done", "Joined Office"], ["done", "Got 192.168.1.57"], ["active", "Reaching the plugin"], ["", "Saving"],
  ]);
  assert.equal(view.$("step-ip").textContent, "Got 192.168.1.57, done");

  const message = "Drift Beacon refused the API key. Create a new one and paste it again.";
  player.state = { ...player.state, attempt: { id: 1, phase: "failed", message, field: "key", ip: "192.168.1.57" } };
  await view.tick();
  assert.deepEqual(steps()[2], ["failed", "Reaching the plugin"]);
  assert.deepEqual(view.visibleErrors(), { code: message });
  assert.equal(view.$("note").textContent, message);
  assert.equal(view.$("connect").disabled, false);
  assert.equal(view.$("connect").textContent, "Connect");

  player.connect = () => ({ status: 202, body: { attempt: 2 } });
  await view.submit();
  const wrongPassword = "Office refused the password. Check it and try again.";
  player.state = { ...player.state, attempt: { id: 2, phase: "failed", message: wrongPassword, field: "password", ip: null } };
  await view.tick();
  assert.deepEqual(steps()[0], ["failed", "Joining Office"]);
  assert.deepEqual(view.visibleErrors(), { password: wrongPassword });
});

test("a network the player saved during a failed attempt is offered as saved afterwards", async () => {
  const player = world();
  const view = await openPage(player);
  view.row("Office").fire("click");
  await view.type("password", "correct horse");
  await view.type("code", CODE_WITH_KEY);
  await view.submit();
  // With no key saved yet, the player keeps a network as soon as it has joined it; then the hub refused the key.
  const message = "The hub didn't accept this API key";
  player.state = {
    ...player.state,
    saved: { ssid: "Office", hasPassword: true, host: null, port: null, base: null, hasKey: false },
    attempt: { id: 1, phase: "failed", message, field: "code", ip: "192.168.1.57" },
  };
  await view.tick();
  assert.equal(view.row("Office").textContent, "OfficeSaved, secured, good signal");
  assert.equal(view.$("password-hint").textContent, "Leave it blank to keep the saved password.");
  assert.equal(view.$("exit").hidden, true);

  await view.type("password", "");
  player.connect = () => ({ status: 202, body: { attempt: 2 } });
  await view.submit();
  const form = formOf(view.posts("/api/connect")[1]);
  assert.deepEqual(form, { ssid: "Office", password: "", keepPassword: "1", code: CODE_WITH_KEY });
  assertPlanned(form, { ssid: "Office", password: "correct horse" }, {
    ssid: "Office", password: "correct horse", ...HUB, key: "db_0123456789abcdef",
  });
});

test("with a setup code, the player's complaint about the hub shows on the code", async () => {
  const player = world();
  const view = await openPage(player);
  view.row("Office").fire("click");
  await view.type("password", "correct horse");
  await view.type("code", CODE_WITH_KEY);
  const failures = {
    base: "Nothing answers at this plugin path. Is Cartridge Player installed, up to date and on?",
    host: "Can't reach 192.168.1.12:9001. Check the address, and that the hub is on this network",
    port: "Enter a port from 1 to 65535",
  };
  let id = 0;
  for (const [field, message] of Object.entries(failures)) {
    id += 1;
    const attempt = { id, phase: "failed", message, field, ip: "192.168.1.57" };
    player.connect = () => ({ status: 202, body: { attempt: attempt.id } });
    await view.submit();
    player.state = { ...player.state, attempt };
    await view.tick();
    assert.deepEqual(view.visibleErrors(), { code: message }, field);
  }
});

test("a refusal from Connect itself shows on the field it names", async () => {
  const refusal = { status: 400, body: { error: "That network name is too long", field: "ssid" } };
  const view = await openPage(world({ connect: () => refusal }));
  view.row("Office").fire("click");
  await view.type("password", "correct horse");
  await view.type("code", CODE_WITH_KEY);
  await view.submit();
  assert.deepEqual(view.visibleErrors(), { ssid: "That network name is too long" });
  assert.equal(view.$("connect").disabled, false);
});

test("a kept key the player refuses shows on the key field, with the hints of what is saved now", async () => {
  // The page was opened on a set-up player, which was then erased from its console: the page still offers to keep.
  const refusal = { error: "Paste the API key: the saved one is only kept for the same hub address", field: "key" };
  const stale = { status: 403, body: { error: "Reload the setup page and try again", field: null } };
  const forms = [];
  const player = configuredPlayer({
    connect: (form) => {
      forms.push(form);
      return forms.length === 1 ? stale : { status: 400, body: refusal };
    },
  });
  // An open network, so the kept key is the only saved secret the form leans on.
  player.state = { ...player.state, saved: { ...SAVED, ssid: "Café guest", hasPassword: false } };
  const view = await openPage(player);
  assert.equal(view.$("key").placeholder, "Saved key");
  player.state = { device: DEVICE, token: "fresh", configured: false, saved: null, attempt: IDLE };
  await view.submit();
  assert.deepEqual(forms[1], { ssid: "Café guest", password: "", ...HUB, port: "9001", key: "", keepKey: "1" });
  assert.deepEqual(view.visibleErrors(), { key: refusal.error });
  assert.equal(view.$("note").textContent, refusal.error);
  assert.equal(view.$("key").placeholder, "db_…");
  assert.equal(view.$("connect").disabled, false);
  // Asked again, the page now stops it itself.
  await view.submit();
  assert.equal(forms.length, 2);
  assert.deepEqual(view.visibleErrors(), { key: KEY_NEEDED });
  // And that refusal is the player's own for a key kept with nothing saved.
  const verdicts = contract("connect", [{ saved: {}, form: forms[1] }]);
  if (verdicts) assert.deepEqual(verdicts[0], { ok: false, field: "key", message: refusal.error });
});

test("polling outlasts a phone that drops off the player's network, says so, and still shows the result", async () => {
  const player = world();
  const view = await openPage(player);
  view.row("Office").fire("click");
  await view.type("password", "correct horse");
  await view.type("code", CODE_WITH_KEY);
  await view.submit();

  player.drop = true;
  await view.tick();
  await view.tick();
  assert.equal(view.$("note").textContent, "");
  player.drop = false;
  player.hang = true;
  await view.tick();
  await view.tick();
  assert.equal(
    view.$("note").textContent,
    "Your phone may have left the player's network. Rejoin Cartridge-A1B2 to see the result.",
  );
  assert.equal(view.$("connect").disabled, true);

  player.hang = false;
  player.state = { ...player.state, attempt: { id: 1, phase: "done", message: "", field: null, ip: "192.168.1.57" } };
  await view.tick();
  assert.equal(view.$("note").textContent, "");
  assert.equal(view.$("form").hidden, true);
  assert.equal(view.$("done").hidden, false);
  assert.equal(view.document.activeElement, view.$("done"));
  const polls = view.requests.filter((request) => request.url === "/api/state").length;
  await view.tick();
  assert.equal(view.requests.filter((request) => request.url === "/api/state").length, polls, "polling stops when done");
});

test("a page reopened after rejoining shows how the last attempt ended", async () => {
  const done = await reopen({ phase: "done", ip: "192.168.1.57" });
  assert.deepEqual([done.$("form").hidden, done.$("done").hidden], [true, false]);
  assert.equal(done.$("step-ip").textContent, "Got 192.168.1.57, done");
  // The player closes this network 60 s after Done, so Done offers no way back into a form that would be cut off.
  const card = page.match(/<section id="done"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(card, /<button/);
  assert.match(card, /To change these settings later, hold the player's BOOT button for 3 seconds\./);

  const message = "Drift Beacon couldn't find the plugin at that path. Check it's enabled.";
  const failed = await reopen({ phase: "failed", message, field: "base", ip: "192.168.1.57" });
  assert.equal(failed.$("done").hidden, true);
  assert.deepEqual(failed.visibleErrors(), { base: message });
  assert.equal(failed.$("connect").disabled, false);
});

test("a reopened page names the network the attempt was for, not the one in the form", async () => {
  const message = "Can't find Office. Check the name, and that the player is in range of it";
  const attempt = { phase: "failed", message, field: "ssid" };
  // The form is prefilled with the saved network (Home), which is not the one that failed.
  const named = await reopen({ ...attempt, ssid: "Office" });
  assert.equal(named.$("step-wifi").textContent, "Joining Office, failed");
  assert.deepEqual(named.visibleErrors(), { ssid: message });
  const unnamed = await reopen(attempt);
  assert.equal(unnamed.$("step-wifi").textContent, "Joining your Wi-Fi, failed");
});

test("the fake player answers /api/state in the shape the player writes it", (t) => {
  if (missing) return t.skip(missing);
  const [fresh, setUp] = contract("state", [{ saved: {} }, { saved: SAVED_SECRETS }]);
  assert.deepEqual(fresh, world().state);
  assert.deepEqual(setUp, configuredPlayer().state);
});

test("a page opened part-way through a Connect follows it from the player's own state", async (t) => {
  if (missing) return t.skip(missing);
  // A Connect for Office on a player whose saved network, prefilled in the form, is Home.
  const form = { ssid: "Office", password: "correct horse", code: CODE_WITH_KEY };
  const [joining, probing, lost] = contract("state", [
    { saved: SAVED_SECRETS, form },
    { saved: SAVED_SECRETS, form, ip: "192.168.1.57" },
    { saved: SAVED_SECRETS, form, lost: true },
  ]);
  const player = world({ state: joining });
  const view = await openPage(player);
  assert.equal(view.row("Home").getAttribute("aria-pressed"), "true");
  assert.equal(view.$("step-wifi").textContent, "Joining Office, in progress");
  assert.equal(view.$("connect").disabled, true);
  player.state = probing;
  await view.tick();
  assert.equal(view.$("step-wifi").textContent, "Joined Office, done");
  assert.equal(view.$("step-ip").textContent, "Got 192.168.1.57, done");
  assert.equal(view.$("step-plugin").textContent, "Reaching the plugin, in progress");

  const failed = await openPage(world({ state: lost }));
  assert.equal(failed.$("step-wifi").textContent, "Joining Office, failed");
  assert.deepEqual(failed.visibleErrors(), {
    ssid: "Can't find Office. Check the name, and that the player is in range of it",
  });
  assert.equal(failed.$("connect").disabled, false);
});

test("a Connect refused because the player is already connecting follows that attempt", async () => {
  const busy = { status: 400, body: { error: "The player is already connecting: wait for it to finish", field: null } };
  const running = { id: 7, phase: "joining", message: "", field: null, ip: null, ssid: "Home" };
  const player = world({ connect: () => busy });
  const view = await openPage(player);
  view.row("Office").fire("click");
  await view.type("password", "correct horse");
  await view.type("code", CODE_WITH_KEY);
  player.state = { ...player.state, attempt: running };
  await view.submit();
  assert.deepEqual(view.visibleErrors(), {});
  assert.equal(view.$("note").textContent, "");
  assert.equal(view.$("connect").disabled, true);
  assert.equal(view.$("step-wifi").textContent, "Joining Home, in progress");

  player.state = { ...player.state, attempt: { ...running, phase: "done", ip: "192.168.1.57" } };
  await view.tick();
  assert.equal(view.$("done").hidden, false);
  assert.equal(view.$("step-wifi").textContent, "Joined Home, done");

  // The same refusal with nothing running is only a refusal.
  const idle = await openPage(world({ connect: () => busy }));
  idle.row("Office").fire("click");
  await idle.type("password", "correct horse");
  await idle.type("code", CODE_WITH_KEY);
  await idle.submit();
  assert.equal(idle.$("note").textContent, busy.body.error);
  assert.equal(idle.$("connect").disabled, false);
  await idle.tick();
  assert.equal(idle.requests.filter((request) => request.url === "/api/state").length, 2, "no polling follows");
});

test("an attempt the player forgot ends the checklist with a sentence and isn't asked about again", async () => {
  const player = world();
  const view = await openPage(player);
  view.row("Office").fire("click");
  await view.type("password", "correct horse");
  await view.type("code", CODE_WITH_KEY);
  await view.submit();
  player.state = { ...player.state, attempt: { ...IDLE, id: 1, phase: "probing", ip: "192.168.1.57", ssid: "Office" } };
  await view.tick();
  assert.deepEqual(view.activeSteps(), ["plugin"]);

  // The phone leaves the player's network. The Connect ends, setup closes, and BOOT is held to bring the network
  // back: entering setup puts the attempt back to idle under the same id.
  player.drop = true;
  for (let i = 0; i < 3; i++) await view.tick();
  player.drop = false;
  player.state = { ...player.state, configured: true, saved: SAVED, attempt: { ...IDLE, id: 1 } };
  await view.tick();
  assert.equal(view.$("note").textContent, FORGOTTEN);
  assert.deepEqual(view.visibleErrors(), {});
  assert.deepEqual(view.activeSteps(), []);
  assert.deepEqual([view.$("connect").disabled, view.$("connect").textContent], [false, "Connect"]);
  assert.equal(view.$("exit").hidden, false);
  const asked = view.stateRequests();
  for (let i = 0; i < 3; i++) await view.tick();
  assert.equal(view.stateRequests(), asked, "a forgotten attempt isn't polled");
});

test("an attempt going back to idle also unlocks a page that was opened part-way and only followed it", async () => {
  const player = configuredPlayer();
  // (`reopen` gives the attempt id 3.)
  const view = await reopen({ phase: "joining", ssid: "Office" }, player);
  assert.deepEqual([view.$("connect").disabled, view.activeSteps()], [true, ["wifi"]]);
  player.state = { ...player.state, attempt: { ...IDLE, id: 3 } };
  await view.tick();
  assert.equal(view.$("note").textContent, FORGOTTEN);
  assert.deepEqual(view.activeSteps(), []);
  assert.equal(view.$("connect").disabled, false);
  const asked = view.stateRequests();
  await view.tick();
  assert.equal(view.stateRequests(), asked);
});

test("a Connect overtaken by a newer one follows that instead of waiting for its own for ever", async () => {
  const player = world();
  const view = await openPage(player);
  view.row("Office").fire("click");
  await view.type("password", "correct horse");
  await view.type("code", CODE_WITH_KEY);
  await view.submit();
  // This page slept through the end of its attempt (1), and another page of the same phone started the next.
  player.drop = true;
  await view.tick();
  player.drop = false;
  player.state = { ...player.state, attempt: { ...IDLE, id: 2, phase: "joining", ssid: "Home" } };
  await view.tick();
  assert.equal(view.$("step-wifi").textContent, "Joining Home, in progress");
  assert.equal(view.$("connect").disabled, true);

  const message = "Home refused the password. Check it and try again.";
  const failed = { ...IDLE, id: 2, phase: "failed", field: "password", message, ssid: "Home" };
  player.state = { ...player.state, attempt: failed };
  await view.tick();
  assert.equal(view.$("note").textContent, message);
  assert.equal(view.$("connect").disabled, false);
  const asked = view.stateRequests();
  await view.tick();
  assert.equal(view.stateRequests(), asked);
});

test("a Connect that stops without the player's word on a step leaves no step in progress", async () => {
  const fill = async (view) => {
    view.row("Office").fire("click");
    await view.type("password", "correct horse");
    await view.type("code", CODE_WITH_KEY);
    await view.submit();
  };
  const stopped = (view, note) => {
    assert.equal(view.$("note").textContent, note);
    assert.deepEqual(view.activeSteps(), [], note);
    assert.equal(view.$("step-wifi").textContent, "Joining Office", note);
    assert.deepEqual([view.$("connect").disabled, view.$("connect").textContent], [false, "Connect"], note);
  };

  // Refused at the door.
  const refusal = { status: 400, body: { error: "That network name is too long", field: "ssid" } };
  const refused = await openPage(world({ connect: () => refusal }));
  await fill(refused);
  stopped(refused, refusal.body.error);

  // Never received: the request went nowhere, and the player knows of no new attempt.
  const unheard = await openPage(world({ connect: () => { throw new TypeError("Failed to fetch"); } }));
  await fill(unheard);
  stopped(unheard, "The player didn't get the request. Check your phone is on Cartridge-A1B2 and try again.");

  // Cut short by a restart, with the plugin step under way.
  const player = world();
  const restarted = await openPage(player);
  await fill(restarted);
  player.state = { ...player.state, attempt: { ...IDLE, id: 1, phase: "probing", ip: "192.168.1.57", ssid: "Office" } };
  await restarted.tick();
  assert.deepEqual(restarted.activeSteps(), ["plugin"]);
  player.state = { ...player.state, token: "fresh", attempt: IDLE };
  await restarted.tick();
  assert.equal(restarted.$("note").textContent, "The player restarted before it finished. Press Connect to try again.");
  assert.deepEqual(restarted.activeSteps(), []);
  assert.equal(restarted.$("step-plugin").textContent, "Reaching the plugin");

  // A failure the player did name keeps its mark.
  const failing = world();
  const failed = await openPage(failing);
  await fill(failed);
  const named = { ...IDLE, id: 1, phase: "failed", field: "key", message: "No", ip: "192.168.1.57" };
  failing.state = { ...failing.state, attempt: named };
  await failed.tick();
  assert.equal(failed.$("step-plugin").textContent, "Reaching the plugin, failed");
});

test("a player that restarts mid-attempt is noticed instead of polled forever", async () => {
  const player = world();
  const view = await openPage(player);
  view.row("Office").fire("click");
  await view.type("password", "correct horse");
  await view.type("code", CODE_WITH_KEY);
  await view.submit();
  player.state = { ...player.state, token: "fresh", attempt: IDLE };
  await view.tick();
  assert.equal(view.$("note").textContent, "The player restarted before it finished. Press Connect to try again.");
  assert.equal(view.$("connect").disabled, false);
  await view.submit();
  assert.equal(view.posts("/api/connect").at(-1).init.headers["X-Setup-Token"], "fresh");
});

test("a request refused for a stale token is sent once more with the restarted player's token", async () => {
  const tokens = (view, url) => view.posts(url).map((request) => request.init.headers["X-Setup-Token"]);
  const refusal = { status: 403, body: { error: "Reload the setup page and try again", field: null } };
  // A player that restarted after the page loaded: only its new token is good.
  const restarted = () =>
    configuredPlayer({ post: (url, token) => (token === "fresh" ? undefined : refusal), connect: () => refusal });

  const player = restarted();
  const view = await openPage(player);
  player.state = { ...player.state, token: "fresh" };
  view.$("exit").fire("click");
  await view.tick();
  assert.deepEqual(tokens(view, "/api/exit"), [TOKEN, "fresh"]);
  assert.equal(view.$("advanced-status").textContent, "The player left setup mode. You can close this page.");

  // No new token to be had: the player's own answer is shown, and nothing is sent twice.
  const stuck = await openPage(restarted());
  stuck.$("exit").fire("click");
  await stuck.tick();
  assert.deepEqual(tokens(stuck, "/api/exit"), [TOKEN]);
  assert.equal(stuck.$("advanced-status").textContent, "Reload the setup page and try again");
  assert.equal(stuck.$("exit").disabled, false);
  await stuck.submit();
  assert.deepEqual(tokens(stuck, "/api/connect"), [TOKEN]);
  assert.equal(stuck.$("note").textContent, "The player restarted since this page opened. Press Connect again.");
  assert.equal(stuck.$("connect").disabled, false);
});

test("Leave setup says why the player refused, is off during a Connect, and closes the form once it worked", async () => {
  const player = configuredPlayer();
  const view = await openPage(player);
  // The player's two refusals: not set up after all, and a Connect this page doesn't know of.
  for (const error of ["Set the player up first", "Wait for Connect to finish"]) {
    player.post = () => ({ status: 400, body: { error, field: null } });
    view.$("exit").fire("click");
    await view.tick();
    assert.equal(view.$("advanced-status").textContent, error);
    assert.deepEqual([view.$("exit").disabled, view.$("connect").disabled], [false, false]);
  }

  player.post = () => {
    throw new TypeError("Failed to fetch");
  };
  view.$("exit").fire("click");
  await view.tick();
  assert.equal(
    view.$("advanced-status").textContent,
    "Couldn't leave setup mode. Check your phone is on Cartridge-A1B2 and try again.",
  );

  await view.submit();
  assert.equal(view.posts("/api/connect").length, 1);
  view.$("exit").fire("click");
  view.$("reset").fire("click");
  await view.tick();
  assert.equal(view.posts("/api/exit").length, 3, "Leave setup can't be pressed while the player connects");
  assert.equal(view.$("reset-confirm").hidden, true);

  const leaving = await openPage(configuredPlayer());
  leaving.$("exit").fire("click");
  await leaving.tick();
  assert.equal(leaving.$("advanced-status").textContent, "The player left setup mode. You can close this page.");
  assert.deepEqual([leaving.$("connect").disabled, leaving.$("connect").textContent], [true, "Setup closed"]);
  await leaving.submit();
  assert.equal(leaving.posts("/api/connect").length, 0);
});

test("erasing takes two presses and Leave setup appears only once the player is configured", async () => {
  // Whether the player would leave setup is the player's call, whatever it has saved.
  const unusable = { device: DEVICE, token: TOKEN, configured: false, saved: SAVED, attempt: IDLE };
  assert.equal((await openPage(world({ state: unusable }))).$("exit").hidden, true);
  const view = await openPage(configuredPlayer());
  assert.equal(view.$("exit").hidden, false);
  assert.equal(view.$("device-id").textContent, "cp-a1b2c3");

  view.$("reset").fire("click");
  await view.tick();
  assert.equal(view.posts("/api/reset").length, 0);
  assert.equal(view.$("reset-confirm").hidden, false);
  view.$("reset-cancel").fire("click");
  assert.equal(view.$("reset-confirm").hidden, true);

  view.$("reset").fire("click");
  view.$("reset-go").fire("click");
  await view.tick();
  const [reset] = view.posts("/api/reset");
  assert.deepEqual(formOf(reset), { confirm: "erase" });
  assert.equal(reset.init.headers["X-Setup-Token"], TOKEN);
  assert.match(view.$("advanced-status").textContent, /^Erased\. The player is restarting/);
});

test("after an erase the page forgets what was saved and waits for the restarted player", async () => {
  const player = configuredPlayer();
  const view = await openPage(player);
  await view.type("key", "db_0123456789abcdef");
  view.$("reset").fire("click");
  view.$("reset-go").fire("click");
  await settle();

  assert.deepEqual([view.$("connect").disabled, view.$("connect").textContent], [true, "Restarting…"]);
  assert.deepEqual([view.$("exit").hidden, view.$("reset").hidden, view.$("reset-confirm").hidden], [true, false, true]);
  assert.deepEqual([view.$("details").hidden, view.$("code-wrap").hidden], [true, false]);
  assert.deepEqual(["host", "port", "base", "key", "password"].map((id) => view.$(id).value), ["", "9001", "", "", ""]);
  assert.equal(view.row("Home").getAttribute("aria-pressed"), "false");
  assert.equal(view.row("Home").textContent, "Home, secured, strong signal");
  assert.equal(view.$("password-wrap").hidden, true);

  // The player answers once more before it restarts, with the token it had: that isn't the new player yet.
  await view.tick();
  assert.equal(view.$("connect").disabled, true);
  assert.equal(view.$("load-error").hidden, true);
  player.drop = true;
  await view.tick();
  assert.equal(view.$("load-error").hidden, false);

  player.drop = false;
  player.state = { device: DEVICE, token: "fresh", configured: false, saved: null, attempt: IDLE };
  await view.tick();
  assert.equal(view.$("load-error").hidden, true);
  assert.deepEqual([view.$("connect").disabled, view.$("connect").textContent], [false, "Connect"]);
  assert.equal(view.$("advanced-status").textContent, "Erased. The player is ready to set up again.");
  assert.equal(view.$("reset").disabled, false);

  view.row("Office").fire("click");
  await view.type("password", "correct horse");
  await view.type("code", CODE_WITH_KEY);
  await view.submit();
  const [post] = view.posts("/api/connect");
  assert.equal(post.init.headers["X-Setup-Token"], "fresh");
  assert.deepEqual(formOf(post), { ssid: "Office", password: "correct horse", code: CODE_WITH_KEY });
});

test("an erase the player refuses, or never hears of, leaves the page as it was", async () => {
  const refusal = { status: 400, body: { error: "Send confirm=erase to erase the player", field: null } };
  const view = await openPage(configuredPlayer({ post: () => refusal }));
  view.$("reset").fire("click");
  view.$("reset-go").fire("click");
  await view.tick();
  assert.equal(view.$("advanced-status").textContent, refusal.body.error);
  assert.deepEqual([view.$("connect").disabled, view.$("reset-go").disabled], [false, false]);
  assert.equal(view.$("reset-confirm").hidden, false);
  assert.equal(view.$("host").value, SAVED.host);
});

test("the page knows every field and phase the player can name", async (t) => {
  if (missing) return t.skip(missing);
  const [names] = contract("names");
  const fresh = await openPage(world());
  assert.deepEqual([...fresh.context.FIELDS].sort(), [...names.fields].sort());

  // Where a page opened on each phase is left: at the form, following the attempt, or on Done.
  const lands = { idle: "form", joining: "following", probing: "following", failed: "form", done: "done" };
  assert.deepEqual(Object.keys(lands).sort(), [...names.phases].sort());
  for (const phase of names.phases) {
    const view = await reopen({ phase }, world());
    const landed = !view.$("done").hidden ? "done" : view.$("connect").disabled ? "following" : "form";
    assert.equal(landed, lands[phase], phase);
  }

  // A failure on any field is said in the note, and inline only on a field that is showing. With details open
  // there is no code field, so a complaint about a code used earlier has the note alone.
  const hub = { host: "details", port: "details", base: "details", key: "key-wrap" };
  const wraps = { password: "password-wrap", code: "code-wrap", ...hub };
  for (const details of [false, true]) {
    for (const field of names.fields) {
      const view = await reopen({ phase: "failed", message: "It failed", field }, details ? configuredPlayer() : world());
      const shown = Object.keys(view.visibleErrors());
      assert.equal(view.$("note").textContent, "It failed");
      assert.equal(shown.length, details && field === "code" ? 0 : 1, `${field}, ${details ? "details" : "setup code"}`);
      for (const id of shown) assert.ok(!wraps[id] || !view.$(wraps[id]).hidden, `${field} shows on a hidden field`);
    }
  }
});

test("the page posts exactly the fields the player reads, under the same names", async () => {
  const kept = await openPage(configuredPlayer());
  await kept.submit();
  const coded = await openPage(world());
  coded.row("Office").fire("click");
  await coded.type("password", "correct horse");
  await coded.type("code", CODE_WITH_KEY);
  await coded.submit();
  const posted = [kept, coded].flatMap((view) => Object.keys(formOf(view.posts("/api/connect")[0])));
  const names = [...new Set(posted)].sort();
  assert.deepEqual(names, ["base", "code", "host", "keepKey", "keepPassword", "key", "password", "port", "ssid"]);
  // The player's list of what its form reader takes; a name outside it also fails wherever a form is planned.
  const read = contract("names")?.[0].form;
  if (read) assert.deepEqual(names, [...read].sort());
  const misnamed = contract("connect", [{ saved: {}, form: { ssid: "Office", pasword: "correct horse" } }]);
  if (misnamed) assert.deepEqual(misnamed[0], { ok: false, unread: "pasword" });
});

test("every POST is a form-encoded string, which is all the player reads: never multipart", async () => {
  const connecting = await openPage(configuredPlayer());
  await connecting.submit();
  const leaving = await openPage(configuredPlayer());
  leaving.$("exit").fire("click");
  await leaving.tick();
  const erasing = await openPage(configuredPlayer());
  erasing.$("reset").fire("click");
  erasing.$("reset-go").fire("click");
  await erasing.tick();

  const posted = (view) => view.requests.filter(({ init }) => init.method === "POST");
  const posts = [connecting, leaving, erasing].flatMap(posted);
  assert.deepEqual(posts.map((request) => request.url), ["/api/connect", "/api/exit", "/api/reset"]);
  for (const { url, init } of posts) {
    assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded", url);
    assert.equal(typeof init.body, "string", `${url}: a FormData body would go out as multipart`);
    assert.equal(new URLSearchParams(init.body).toString(), init.body, url);
  }
  assert.doesNotMatch(page, /FormData|multipart|enctype/);
  // No form the browser could submit by itself, whatever the script does.
  assert.doesNotMatch(page, /<form[^>]*\s(action|method)=/);
});

test("the stand-in player keeps and refuses saved secrets as the player does", (t) => {
  if (missing) return t.skip(missing);
  const kept = { ...HUB, port: "9001", key: "", keepKey: "1" };
  const open = { ...SAVED_SECRETS, ssid: "Café guest", hasPassword: false, password: "" };
  // Each as [what is saved, the form, the field refused (null: accepted)].
  const cases = [
    [SAVED_SECRETS, { ssid: "Home", password: "", keepPassword: "1", ...kept }, null],
    [SAVED_SECRETS, { ssid: "Home", password: SAVED_SECRETS.password, ...kept }, "key"],
    [SAVED_SECRETS, { ssid: "Home", password: "newpassword9", ...kept }, "key"],
    [SAVED_SECRETS, { ssid: "Home", password: "", ...kept }, "key"],
    [SAVED_SECRETS, { ssid: "Office", password: "correct horse", ...kept }, "key"],
    [SAVED_SECRETS, { ssid: "Office", password: "", keepPassword: "1", ...kept }, "password"],
    [SAVED_SECRETS, { ssid: "Home", password: "", keepPassword: "1", ...kept, host: "192.168.1.13" }, "key"],
    [SAVED_SECRETS, { ssid: "Home", password: "", keepPassword: "1", ...kept, keepKey: "" }, "key"],
    [SAVED_SECRETS, { ssid: "Home", password: SAVED_SECRETS.password, ...kept, key: "db_0123456789abcdef" }, null],
    [SAVED_SECRETS, { ssid: "Office", password: "correct horse", code: CODE_WITH_KEY }, null],
    [open, { ssid: "Café guest", password: "", ...kept }, null],
    [open, { ssid: "Café guest", password: "12345678", ...kept }, "key"],
  ];
  const verdicts = contract("connect", cases.map(([saved, form]) => ({ saved, form })));
  cases.forEach(([saved, form, field], index) => {
    const said = verdicts[index].ok ? null : [verdicts[index].field, verdicts[index].message];
    assert.equal(said?.[0] ?? null, field, `the player, ${JSON.stringify(form)}`);
    assert.deepEqual(refusal(form, saved, saved.password), said, `the stand-in, ${JSON.stringify(form)}`);
  });
});

test("Paste reads the clipboard where the browser allows it, and otherwise points at the field", async () => {
  const allowed = await openPage(world({ navigator: { clipboard: { readText: async () => ` ${CODE_WITH_KEY} ` } } }));
  allowed.$("paste").fire("click");
  await allowed.tick();
  assert.equal(allowed.$("code").value, CODE_WITH_KEY);
  assert.equal(allowed.$("code-summary").textContent, "Hub 192.168.1.12:9001 · key included");

  const refused = await openPage(world({ navigator: { clipboard: { readText: async () => { throw new Error("denied"); } } } }));
  refused.$("paste").fire("click");
  await refused.tick();
  assert.equal(refused.document.activeElement, refused.$("code"));
  assert.equal(refused.$("code-hint").textContent, "Touch and hold the field, then choose Paste.");
});
