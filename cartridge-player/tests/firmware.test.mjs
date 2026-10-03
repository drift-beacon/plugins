// The player firmware's host tests. The C++ core (player/src/core) has no Arduino in it, so it compiles here: each
// player/tests/test_*.cpp is a program that checks one module's rules, and player/tests/contract.cpp prints what the
// firmware sends and understands, for the plugin's own shared/*.ts to judge. Needs a C++17 compiler (CXX picks one).
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CXX, missingCompiler } from "../player/tests/toolchain.mjs";
import { HEARTBEAT_S, cueFor, parseReport, playerReply, probeReply } from "../shared/protocol.ts";
import { decodeSetupCode, encodeSetupCode, setupFieldError } from "../shared/setup-code.ts";

const run = promisify(execFile);
const SOURCES = fileURLToPath(new URL("../player/tests/", import.meta.url));
const FLAGS = ["-std=c++17", "-Wall", "-Wextra", "-pedantic", "-Werror", "-O1", "-g"];

/** Each module's test program, and the part of the player it protects. */
const MODULES = {
  test_uid: "cartridge UIDs keep their text form (the key of every label)",
  test_tag_tracker: "the slot is debounced: in after two reads, out after 3 polls and 400 ms, faults never out",
  test_slot_feed: "polls become reports: a swap is two changes, a reader is faulty after a second, and only a read slot is reported ok",
  test_reporter: "reports are level-triggered, one at a time, retried by status class, with the right cues, for months",
  test_protocol: "report bodies and the answers the player reads",
  test_http_body: "an answer's body is read plain or chunked, 512 bytes at most, and never past where it stops",
  test_settings: "saved settings load by the setup rules: Wi-Fi when it is there, a hub only whole",
  test_setup_code: "setup codes decode by the same rules as the interface's",
  test_setup:
    "Connect: a form read from its own request alone, secrets reused only where proven, failures on the right field, /api/state",
  test_scan: "the setup page's network scan: retried for 12 s, then given up and said so once",
  test_link: "setup mode opens and closes when DESIGN.md says, the station retries with backoff, and who is a client of the access point",
  test_indicator: "the light says what the cartridge is doing as the interface draws it, and the player's own states never look like that",
  test_inputs: "the BOOT long-press and the serial console",
};

let dir;
/** Why nothing was compiled, on a machine without a C++ compiler. */
let missing = null;
const binaries = new Map();

before(async () => {
  missing = await missingCompiler("the firmware's host tests and its contract with shared/*.ts were");
  if (missing) return;
  dir = mkdtempSync(join(tmpdir(), "cartridge-firmware-"));
  // Sanitizers turn an overrun of the core's fixed buffers into a failure; use them wherever the toolchain has them.
  let extra = ["-fsanitize=address,undefined", "-fno-sanitize-recover=all"];
  const probe = join(dir, "probe.cpp");
  writeFileSync(probe, "int main() { return 0; }\n");
  try {
    await run(CXX, [...FLAGS, ...extra, probe, "-o", join(dir, "probe")]);
  } catch {
    extra = [];
  }
  await Promise.all(
    [...Object.keys(MODULES), "contract"].map(async (name) => {
      const binary = join(dir, name);
      await run(CXX, [...FLAGS, ...extra, join(SOURCES, `${name}.cpp`), "-o", binary]);
      binaries.set(name, binary);
    }),
  );
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Without a compiler this one test fails, saying what to install, and the rest are skipped with the same sentence:
// the firmware's contract is never reported as checked when it wasn't.
test("a C++17 compiler is here to build the firmware's host tests", () => {
  assert.equal(missing, null, missing ?? undefined);
});

/** A test that runs the compiled programs. */
const compiled = (name, body) => test(name, (t) => (missing ? t.skip(missing) : body(t)));

for (const [name, about] of Object.entries(MODULES)) {
  compiled(`firmware: ${about} (player/tests/${name}.cpp)`, async () => {
    try {
      await run(binaries.get(name));
    } catch (error) {
      assert.fail(`${error.stdout}${error.stderr}`);
    }
  });
}

/** Runs a contract command with one JSON object per stdin line; returns one parsed object per output line. */
function contract(command, inputs = []) {
  const stdout = execFileSync(binaries.get("contract"), [command], {
    input: inputs.map((input) => JSON.stringify(input)).join("\n"),
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The firmware's own version, from the one place it is written. */
function firmwareVersion() {
  const header = readFileSync(new URL("../player/src/core/device.h", import.meta.url), "utf8");
  const version = /#define CP_FIRMWARE_VERSION "(\d+\.\d+\.\d+)"/.exec(header);
  assert.ok(version, "core/device.h defines CP_FIRMWARE_VERSION as three numbers");
  return version[1];
}

compiled("the plugin's parseReport accepts every report the firmware writes, field for field", () => {
  const device = { id: "cp-a1b2c3", fw: firmwareVersion(), name: "Cartridge-A1B2" };
  const expected = {
    "boot-empty": { seq: 0, reason: "boot", tag: null, ageMs: 0, rssi: -52, uptimeS: 3, reader: "ok" },
    insert: { seq: 1, reason: "change", tag: "04:A1:B2:C3:D4:E5:F6", ageMs: 300, rssi: -55, reader: "ok" },
    // A swap is out then in: two changes.
    swap: { seq: 3, reason: "change", tag: "04:0B:00:1C", reader: "ok" },
    // A reader fault (the reader failing for over a second) keeps the slot and the seq.
    "reader-fault": { seq: 3, reason: "heartbeat", tag: "04:0B:00:1C", reader: "fault" },
    // Back from the fault, the player says nothing until it has read the slot again: no "still there, reader ok".
    "reader-back-unread": null,
    eject: { seq: 4, reason: "change", tag: null, rssi: null, reader: "ok" },
    "ten-byte": { seq: 5, tag: "00:01:0F:10:7F:80:AB:CD:EF:FF", rssi: -128, uptimeS: 4294967295 },
    heartbeat: { seq: 5, reason: "heartbeat", ageMs: 30000 },
    reconnect: { seq: 5, reason: "reconnect" },
    pair: { seq: 5, reason: "pair" },
    // A second power-up, with a reader that never answers: the plugin still hears from the player, and why.
    "boot-dead-reader": { seq: 0, reason: "boot", tag: null, reader: "fault" },
    // Main trusts the slot a report carries (DESIGN.md "Main", step 1), so "empty, reader ok" must mean the reader
    // found the slot empty. When that reader comes back with the cartridge still in, nothing may be sent before the
    // cartridge itself: an empty-and-ok report here would end its session.
    "dead-reader-back-unread": null,
    "dead-reader-cartridge": { seq: 1, reason: "change", tag: "04:A1:B2:C3:D4:E5:F6", reader: "ok" },
    // A third power-up, dead reader and an empty slot: empty-and-ok only once the slot was read empty.
    "boot-dead-reader-empty": { seq: 0, reason: "boot", tag: null, reader: "fault" },
    "dead-reader-empty-unread": null,
    "dead-reader-empty": { seq: 0, reason: "heartbeat", tag: null, reader: "ok" },
  };
  const reports = contract("reports");
  assert.deepEqual(
    reports.map((report) => report.name),
    Object.keys(expected),
  );
  for (const { name, body } of reports) {
    if (expected[name] === null) {
      assert.equal(body, null, `${name}: the player must send nothing here`);
      continue;
    }
    const raw = JSON.parse(body);
    const parsed = parseReport(raw);
    assert.ok(parsed.ok, `${name}: ${parsed.error}`);
    const report = parsed.value;
    assert.deepEqual(report.device, device, name);
    assert.equal(report.v, 2, name);
    assert.equal(report.boot, 3141592653, name);
    // The firmware sends the canonical text itself: storage keys never depend on the plugin's normalising.
    assert.equal(raw.tag, report.tag, name);
    for (const [field, value] of Object.entries(expected[name])) assert.equal(report[field], value, `${name}.${field}`);
  }
});

compiled("the firmware reads every reply, probe answer and error the plugin and platform send", () => {
  const results = ["started", "marked", "resumed", "unchanged", "ended", "empty", "unknown", "orphan", "archived"];
  const activities = ["Deep work", null, 'Café "focus" 🎵 \\ tabs\tand more', "x".repeat(60)];
  const cases = [];
  results.concat(["error", "stale"]).forEach((result, i) => {
    const activity = activities[i % activities.length];
    const reply = playerReply(1000 + i, result, activity);
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 512, "replies fit the player's 512-byte buffer");
    const expect = {
      parsed: true,
      ok: true,
      seq: 1000 + i,
      result,
      cue: cueFor(result),
      heartbeat_s: HEARTBEAT_S,
      activity: reply.activity ?? "",
      delivery: "delivered",
    };
    cases.push({ status: 200, body: JSON.stringify(reply), expect });
    // Field order and extra fields don't matter.
    const reordered = { future: { nested: [1, { x: null }] }, ...Object.fromEntries(Object.entries(reply).reverse()) };
    cases.push({ status: 200, body: JSON.stringify(reordered), expect });
  });
  cases.push(
    {
      status: 200,
      body: JSON.stringify(probeReply()),
      expect: { parsed: true, ok: true, probe: true, player: "cartridge-player", protocol: 2, delivery: "delivered" },
    },
    {
      status: 503,
      body: JSON.stringify({ ok: false, v: 2, code: "retry", error: "Plugin is restarting", retry_ms: 2500 }),
      expect: { ok: false, code: "retry", retry_ms: 2500, wait: 2500, delivery: "retry" },
    },
    {
      status: 400,
      body: JSON.stringify({ ok: false, v: 2, code: "bad_request", error: "seq must be an unsigned 32-bit integer" }),
      expect: { ok: false, code: "bad_request", wait: 0, delivery: "dropped" },
    },
    { status: 401, body: '{"success":false,"error":"Invalid API key"}', expect: { delivery: "key-rejected" } },
    { status: 403, body: '{"success":false,"error":"No workspace"}', expect: { delivery: "key-rejected" } },
    {
      status: 404,
      body: '{"success":false,"error":"Plugin is disabled or unavailable"}',
      expect: { parsed: true, ok: false, error: "Plugin is disabled or unavailable", delivery: "not-found" },
    },
    { status: 502, body: "<html><body>Bad gateway</body></html>", expect: { parsed: false, delivery: "retry" } },
    { status: 504, body: '{"success":false,"error":"Timed out"}', expect: { delivery: "retry", wait: 0 } },
  );
  const answers = contract(
    "answers",
    cases.map(({ status, body }) => ({ status, body })),
  );
  assert.equal(answers.length, cases.length);
  cases.forEach(({ body, expect }, i) => {
    for (const [field, value] of Object.entries(expect)) assert.equal(answers[i][field], value, `${body} → ${field}`);
  });
});

const BASE = "/api/plugins/github.12345.cartridge-player/api";

/** base64url of raw text, for codes encodeSetupCode would never write. */
const handMade = (text) => `CP1-${Buffer.from(text, "latin1").toString("base64url")}`;

compiled("setup codes from the interface decode identically in the firmware, and bad ones are refused by both", () => {
  const valid = [
    { host: "192.168.1.12", port: 9001, base: BASE, key: `db_${"a1".repeat(20)}` },
    { host: "beacon.local", port: 1, base: "/api/plugins/cartridge-player-dev/api", key: null },
    { host: "a".repeat(253), port: 65535, base: `/api/plugins/${"i".repeat(128)}/api`, key: "k".repeat(256) },
    // Every printable character a key may hold, and the longest code there can be (each `"` and `\` escaped).
    { host: "hub", port: 9001, base: BASE, key: "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~09azAZ" },
    { host: "hub", port: 9001, base: BASE, key: '"\\'.repeat(128) },
  ].map(encodeSetupCode);
  const codes = [
    ...valid,
    ` \n\t${valid[0]}\r\n`,
    `\u00a0${valid[1]}\u3000\ufeff`,
    handMade('{"h":"x","p":9001.0,"b":"/api/plugins/x/api"}'),
    handMade('{"h":"x","p":9.001e3,"b":"/api/plugins/x/api"} '),
    handMade('{"h":"x","p":9001,"b":"/api/plugins/x/api","later":{"a":[1,2,{"b":null}]}}'),
    handMade('{"h":"\\u0078","p":9001,"b":"/api/plugins/x/api"}'),
    handMade('{"h":"bad host","h":"x","p":9001,"b":"/api/plugins/x/api"}'),
    handMade('{"h":"x","p":9001,"b":"/api/plugins/x/api","n":"caf\u00e9"}'),
    handMade('{"h":"x","p":9001,"b":"/api/plugins/x/api","k":null}'),
    handMade('{"h":"x","h":"bad host","p":9001,"b":"/api/plugins/x/api"}'),
    handMade('{"h":"x\\u0000","p":9001,"b":"/api/plugins/x/api"}'),
    handMade('{"h":"x","p":-0,"b":"/api/plugins/x/api"}'),
    handMade('{"h":"x","p":1e400,"b":"/api/plugins/x/api"}'),
    handMade('{"h":"x","p":"9001","b":"/api/plugins/x/api"}'),
    handMade('{"h":"x","p":9001,"b":"/api/plugins/x/api",}'),
    handMade('[{"h":"x","p":9001,"b":"/api/plugins/x/api"}]'),
    handMade('"text"'),
    handMade('{"h":"x","p":9001,"b":"/api/plugins/x/api/player"}'),
    handMade('{"h":"x","p":9001,"b":"/api/plugins/x/api","k":"has space1"}'),
    valid[0].slice(0, -1),
    valid[0].slice(0, -2),
    valid[0].toLowerCase(),
    valid[0].replace("CP1-", "CP2-"),
    `${valid[0].slice(0, 10)} ${valid[0].slice(10)}`,
    `${valid[0]}=`,
    "CP1-",
    "CP1-!",
    "",
    "db_0123456789abcdef",
  ];
  const decoded = contract(
    "setup-codes",
    codes.map((code) => ({ code })),
  );
  assert.equal(decoded.length, codes.length);
  codes.forEach((code, i) => {
    const expected = decodeSetupCode(code);
    const actual = decoded[i];
    if (expected === null) {
      assert.equal(actual.valid, false, `firmware accepted ${JSON.stringify(code)}`);
    } else {
      assert.deepEqual(actual, { valid: true, ...expected }, `firmware decoded ${JSON.stringify(code)} differently`);
    }
  });
  assert.equal(decoded.slice(0, valid.length).filter((code) => code.valid).length, valid.length);
});

compiled("each setup field is judged the same way, with the same message, in the firmware and the interface", () => {
  const values = {
    host: ["192.168.1.12", "beacon.local", "", "http://x", "x:9001", "a b", "a".repeat(253), "a".repeat(254), "héllo", 5, null],
    port: [1, 9001, 65535, 0, 65536, -1, 9001.5, "9001", null],
    base: [
      BASE,
      "/api/plugins/./api",
      "/api/plugins/../api",
      "/api/plugins/.../api",
      `${BASE}/player`,
      "/api/plugins//api",
      `/api/plugins/${"a".repeat(128)}/api`,
      `/api/plugins/${"a".repeat(129)}/api`,
      "/api/plugins/x y/api",
      7,
    ],
    key: ["db_abcdefgh", "short", "has space", "k".repeat(256), "k".repeat(257), "tab\tkey123", "ключ12345678", null],
  };
  const inputs = Object.entries(values).flatMap(([field, list]) => list.map((value) => ({ field, value })));
  const verdicts = contract("fields", inputs);
  inputs.forEach(({ field, value }, i) => {
    assert.equal(verdicts[i].error, setupFieldError(field, value), `${field} ${JSON.stringify(value)}`);
  });
});

/** How the interface draws the player's LED in each phase: its colour, and the loop it runs (deck.css). */
function replicaLights() {
  const ui = (file) => readFileSync(new URL(`../ui/src/components/${file}`, import.meta.url), "utf8");
  const css = ui("deck.css");
  const lights = {};
  for (const [, phase, hex, loop] of ui("scene/Led.tsx").matchAll(/^\s*(\w+): \{ color: "#([0-9a-f]{6})", loop: (?:"([\w-]+)"|null) \}/gm)) {
    const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
    // The colour's family: grey has none; amber is a red with most of its green.
    let hue = "white";
    if (Math.max(r, g, b) - Math.min(r, g, b) > 40) hue = b >= r && b >= g ? "blue" : g >= r ? "green" : g - b > 60 ? "amber" : "red";
    if (!loop) {
      lights[phase] = { hue, motion: "steady", period_ms: 0 };
      continue;
    }
    const rule = new RegExp(`\\.${loop} \\{\\s*animation: (cp-[a-z]+) ([\\d.]+)(ms|s) `).exec(css);
    assert.ok(rule, `deck.css has no .${loop} animation`);
    const motion = { "cp-blink": "blinking", "cp-breathe": "breathing" }[rule[1]];
    assert.ok(motion, `${rule[1]} is a loop the player's light has no word for`);
    lights[phase] = { hue, motion, period_ms: Math.round(Number(rule[2]) * (rule[3] === "s" ? 1000 : 1)) };
  }
  return lights;
}

compiled("the player's light shows a cartridge the way the interface's replica of it does, answer by answer", () => {
  const replica = replicaLights();
  // What the plugin answers a report about a cartridge with, and the phase the interface then draws.
  const phases = {
    started: "playing",
    resumed: "playing",
    marked: "marked",
    unknown: "unknown",
    orphan: "orphan",
    archived: "archived",
    error: "error",
  };
  const cases = [
    { slot: "empty", body: null, phase: "empty" },
    { slot: "in", body: null, phase: "reading" },
    ...Object.entries(phases).map(([result, phase]) => ({ slot: "in", body: JSON.stringify(playerReply(1, result, "Deep work")), phase })),
  ];
  for (const { phase } of cases) assert.ok(replica[phase], `Led.tsx has no ${phase} phase`);
  const shown = contract(
    "lights",
    cases.map(({ slot, body }) => ({ slot, body })),
  );
  assert.equal(shown.length, cases.length);
  cases.forEach(({ body, phase }, i) => {
    const about = `${phase} (${body ? JSON.parse(body).result : "no answer"})`;
    // The replica blinks a cartridge that needs attention a few times and then holds; the player's LED keeps on.
    assert.deepEqual(shown[i], replica[phase], about);
  });
  // An empty slot has no colour on either: the replica's dot is grey with no glow, the player's a faint white.
  assert.deepEqual(shown[0], { hue: "white", motion: "steady", period_ms: 0 });
});

/** A firmware source without its comments: a rule is checked against the code, not against its explanation. */
function firmwareCode(file) {
  const source = readFileSync(new URL(`../player/src/${file}`, import.meta.url), "utf8");
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("the setup portal reads a form from its own request only, and keeps nothing of a request once it is answered", () => {
  // The Arduino core's web server parses a body before any handler runs, and keeps what a multipart body left when
  // it couldn't be read to the end: arg(name) and hasArg(name) then find that first, for every request after it.
  const code = firmwareCode("hal/portal.cpp");
  assert.doesNotMatch(code, /\bhasArg\s*\(/, "hasArg searches what earlier requests left behind");
  const reads = [...code.matchAll(/\bserver\.arg\(([^)]*)\)/g)].map((match) => match[1].trim());
  assert.deepEqual([...new Set(reads)], ["i"], "form fields are read by position, never by name");
  assert.match(code, /\bserver\.argName\(i\)/);
  // Every pass of the server is followed by forgetting: the leftovers, the last form and the last Host. The only
  // pass is in SetupServer::serve.
  const passes = [...code.matchAll(/\bhandleClient\(\);(\s*forget\(\);)?/g)];
  assert.ok(passes.length === 1 && passes[0][1], "forget() follows the one handleClient()");
  assert.doesNotMatch(code, /\bserver\.handleClient\(/, "the server is only run through serve()");
  assert.match(code, /\bserver\.serve\(\);/);
  const forget = /void forget\(\) \{([\s\S]*?)\n {2}\}/.exec(code);
  assert.ok(forget, "SetupServer::forget()");
  for (const member of ["_postArgs = nullptr", "_postArgsLen = 0", "_currentArgs = nullptr", "_currentArgCount = 0", "_hostHeader = String()"]) {
    assert.ok(forget[1].includes(member), `forget() resets ${member.split(" ")[0]}`);
  }
  // A multipart body is refused by its type: only what the core parsed as a urlencoded form passes (core/setup.h).
  const mayChange = /bool mayChange\(\) \{([\s\S]*?)\n\}/.exec(code);
  assert.ok(mayChange && /!isFormBody\(server\.header\("Content-Type"\)\.c_str\(\)\)/.test(mayChange[1]));
});

test("the setup portal tells its clients by their own address, not only by the address they asked for", () => {
  const code = firmwareCode("hal/portal.cpp");
  const check = /bool onSetupNetwork\(NetworkClient& client\) \{([\s\S]*?)\n\}/.exec(code);
  assert.ok(check, "onSetupNetwork()");
  assert.match(check[1], /askedHere = client\.localIP\(\) == WiFi\.softAPIP\(\);/);
  assert.match(check[1], /fromItsNetwork = wifi::onAccessPointNetwork\(static_cast<uint32_t>\(client\.remoteIP\(\)\)\);/);
  assert.match(check[1], /return askedHere && fromItsNetwork;/);
  assert.match(firmwareCode("hal/wifi_link.cpp"), /sameSubnet\(address, static_cast<uint32_t>\(ACCESS_POINT_IP\), static_cast<uint32_t>\(ACCESS_POINT_MASK\)\)/);
  // The handlers still refuse by it, as the second check.
  const handler = /bool fromAccessPoint\(\) \{([\s\S]*?)\n\}/.exec(code);
  assert.ok(handler && /if \(onSetupNetwork\(server\.client\(\)\)\) return true;\s*server\.send\(403,/.test(handler[1]));
});

test("the setup portal turns away a connection from the wrong side before the core reads a byte of it", () => {
  // The core's handleClient() accepts, then reads and parses the whole request (waiting on a slow one, keeping every
  // field of a large one) before any handler can refuse it. serve() accepts first and only hands over its own clients.
  const code = firmwareCode("hal/portal.cpp");
  const serve = /void serve\(\) \{([\s\S]*?)\n {2}\}/.exec(code);
  assert.ok(serve, "SetupServer::serve()");
  const steps = [
    /if \(_currentStatus == HC_NONE\) \{/,
    /NetworkClient next = _server\.accept\(\);/,
    /if \(!next\) return;/,
    /if \(!onSetupNetwork\(next\)\) \{\s*next\.stop\(\);\s*return;\s*\}/,
    /_currentClient = next;/,
    /_currentStatus = HC_WAIT_READ;/,
    /\}\s*handleClient\(\);/,
  ];
  let from = 0;
  for (const step of steps) {
    const found = step.exec(serve[1].slice(from));
    assert.ok(found, `serve(): ${step.source}, in this order`);
    from += found.index + found[0].length;
  }
});

test("the setup page's use is what carries its token: nothing else keeps setup open or starts a scan", () => {
  const code = firmwareCode("hal/portal.cpp");
  const body = (name) => {
    const found = new RegExp(`(?:void|bool) ${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`).exec(code);
    assert.ok(found, `${name}()`);
    return found[1];
  };
  assert.match(body("hasToken"), /sent = server\.header\("X-Setup-Token"\);\s*return token\[0\] != '\\0' && std::strcmp\(sent\.c_str\(\), token\) == 0;/);
  // Every touched() in the portal sits behind the token.
  assert.equal([...code.matchAll(/host->touched\(\)/g)].length, 3, "touched(): in mayChange, serveState and serveScan");
  assert.match(body("mayChange"), /if \(!hasToken\(\) \|\|[^\n]*\) \{\s*sendError\(403,[^\n]*\s*return false;\s*\}\s*host->touched\(\);/);
  assert.match(body("serveState"), /if \(hasToken\(\)\) host->touched\(\);/);
  // A scan pauses the station, so it is refused without the token, before anything is asked of the radio.
  assert.match(body("serveScan"), /^\s*if \(!forApi\(\)\) return;\s*if \(!hasToken\(\)\) \{\s*sendError\(403,[^\n]*\s*return;\s*\}\s*host->touched\(\);/);
  assert.doesNotMatch(body("servePage"), /touched/);
  assert.doesNotMatch(body("redirectHome"), /touched/);
});

test("the API key only goes out on a connection that is the station's own", () => {
  // The loop starts a request with the station up, but the connection is made later, on the hub task. Every connect
  // HTTPClient makes goes through the client it was given, so that client refuses one that isn't over the station.
  const code = firmwareCode("hal/hub_client.cpp");
  const client = /class StationClient final : public NetworkClient \{([\s\S]*?)\n\};/.exec(code);
  assert.ok(client, "StationClient");
  assert.match(
    client[1],
    /int connect\(IPAddress ip, uint16_t port, int32_t timeoutMs\) override \{\s*if \(!NetworkClient::connect\(ip, port, timeoutMs\)\) return 0;\s*if \(wifi::overStation\(static_cast<uint32_t>\(localIP\(\)\)\)\) return 1;\s*stop\(\);\s*return 0;\s*\}/,
  );
  const perform = /void perform\(const Request& request, Response& response\) \{([\s\S]*?)\n\}/.exec(code);
  assert.ok(perform, "perform()");
  assert.match(perform[1], /StationClient client;[\s\S]*http\.begin\(client, request\.host, request\.port, request\.path, false\)[\s\S]*addHeader\("Authorization"/);
  assert.equal([...code.matchAll(/\bNetworkClient \w+;/g)].length, 0, "no plain client for the key to leave by");
  assert.match(
    firmwareCode("hal/wifi_link.cpp"),
    /bool overStation\(uint32_t local\) \{\s*return cp::overStation\(local, static_cast<uint32_t>\(WiFi\.localIP\(\)\), static_cast<uint32_t>\(ACCESS_POINT_IP\)\);/,
  );
});

test("a Connect's probe is only sent with the station up, and one whose network dropped ends there", () => {
  const code = firmwareCode("app.cpp");
  const starts = [...code.matchAll(/^.*\bstartProbe\(now\);.*$/gm)].map((match) => match[0]);
  assert.ok(starts.length > 0);
  for (const line of starts) assert.match(line, /link\.stationIsUp\(\) && attempt\.probeDue\(now\)/, line.trim());
  const down = /void stationWentDown\(Millis now\) \{([\s\S]*?)\n\}/.exec(code);
  assert.ok(down && /if \(attempt\.linkLost\(\)\) endAttempt\(false, now\);/.test(down[1]), "a lost network ends the Connect");
  // Every way the station goes down runs through it, and a late answer is only taken by the attempt that asked.
  assert.equal([...code.matchAll(/\blink\.stationDown\(now\)/g)].length, 1, "stationDown: only in stationWentDown");
  // The one leave of the player's own is told to the link as such, and no address counts after it until a join.
  assert.equal([...code.matchAll(/\bwifi::leave\(\);\s*link\.stationLeft\(now\);/g)].length, 1, "endAttempt's leave");
  assert.equal([...code.matchAll(/\bwifi::leave\(\)/g)].length, 1);
  assert.match(code, /if \(late\) break;\s*if \(!joining && !link\.expectsUp\(\)\) break;\s*link\.stationUp\(now\);/);
  assert.equal([...code.matchAll(/\blink\.stationUp\(/g)].length, 1, "stationUp: only behind those two checks");
  assert.match(code, /if \(attempt\.probeOut\(\)\) finishProbe\(answer, now\);/);
});
