"use strict";

// The player's setup page. The player serves it in setup mode, and phones often show it in a captive-portal sheet:
// a limited browser that may have no clipboard API and may close when the Wi-Fi changes. No framework and no
// external requests. Every string from the player or the radio goes into the page with textContent.
// Top-level functions are plain globals so tests/portal.test.mjs can drive this exact script in node:vm.

// How long to wait for the player, and how often to ask it for news.
var REQUEST_MS = 3000;
var POST_MS = 8000;
var POLL_MS = 1000;
var SCAN_POLL_MS = 1500;
// Answers of "still looking" in a row before the page stops waiting (about 17 s). The player gives a scan 12 s and
// then says it failed; this is for a player that never says so, which would keep the list on "Looking…" for good.
var SCAN_POLLS = 12;
var LOAD_RETRY_MS = 3000;
// Missed polls in a row before the page says the phone may have left the player's network.
var MISSES_BEFORE_HINT = 3;

// The setup code, ported from shared/setup-code.ts with the same rules and messages: the test decodes codes with
// both and expects the same answers.
var CODE_PREFIX = "CP1-";
var HOST = /^[A-Za-z0-9._-]{1,253}$/;
var BASE = /^\/api\/plugins\/([A-Za-z0-9._-]{1,128})\/api$/;
var KEY = /^[\x21-\x7e]{8,256}$/;

function fieldError(field, value) {
  if (field === "host") {
    return typeof value === "string" && HOST.test(value)
      ? null
      : "Enter the hub's host name or IP address, without http:// or a port";
  }
  if (field === "port") {
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? null : "Enter a port from 1 to 65535";
  }
  if (field === "base") {
    var match = typeof value === "string" ? BASE.exec(value) : null;
    return match && match[1] !== "." && match[1] !== ".." ? null : "The plugin path must look like /api/plugins/<id>/api";
  }
  return typeof value === "string" && KEY.test(value) ? null : "Paste the whole API key, without spaces";
}

function decodeSetupCode(text) {
  var trimmed = String(text).trim();
  if (trimmed.indexOf(CODE_PREFIX) !== 0) return null;
  var body = trimmed.slice(CODE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
  var payload;
  try {
    payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
  } catch (error) {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  if (fieldError("host", payload.h) || fieldError("port", payload.p) || fieldError("base", payload.b)) return null;
  if (payload.k !== undefined && fieldError("key", payload.k)) return null;
  return { host: payload.h, port: payload.p, base: payload.b, key: payload.k === undefined ? null : payload.k };
}

// The player's Wi-Fi rules (ssidError and passwordError in player/src/core/settings.h), with its sentences. Its
// limits are in bytes, and a captive-portal browser may have no TextEncoder, so UTF-8 is counted by hand.
var HEX_KEY = /^[0-9A-Fa-f]{64}$/;
var CONTROL = /[\x00-\x1f\x7f]/;

function byteLength(text) {
  var bytes = 0;
  for (var i = 0; i < text.length; i++) {
    var unit = text.charCodeAt(i);
    var next = text.charCodeAt(i + 1);
    // Two UTF-16 units that make one character outside the basic plane: four bytes together.
    var pair = unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : pair ? 4 : 3;
    if (pair) i++;
  }
  return bytes;
}

function ssidError(ssid) {
  if (ssid === "") return S.other ? "Enter the network name" : "Choose a Wi-Fi network";
  return byteLength(ssid) > 32 ? "A network name is at most 32 bytes" : null;
}

// Blank is an open network (or a kept password); otherwise a passphrase of 8 to 63 bytes, or a 64-digit hex key.
function passwordError(password) {
  var length = byteLength(password);
  if (length === 0 || HEX_KEY.test(password)) return null;
  return length < 8 || length > 63 || CONTROL.test(password) ? "A Wi-Fi password is 8 to 63 characters" : null;
}

var S = {
  device: {},
  token: "",
  saved: null,
  // After an erase: the token of the player that was erased, until the restarted one answers.
  erased: "",
  lastAttempt: 0,
  networks: [],
  scanning: false,
  scanFailed: false,
  scanPolls: 0,
  ssid: "",
  secure: true,
  other: false,
  manual: false,
  busy: false,
  attempt: null,
  joining: "",
  // The attempt the checklist was last drawn from.
  shown: null,
  misses: 0
};

function $(id) {
  return document.getElementById(id);
}

function show(id, visible) {
  $(id).hidden = !visible;
}

function say(id, text) {
  $(id).textContent = text;
}

function make(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function deviceName() {
  return S.device.name || "the player's network";
}

async function request(path, init, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () {
    controller.abort();
  }, timeoutMs || REQUEST_MS);
  try {
    var response = await fetch(path, Object.assign({ cache: "no-store", signal: controller.signal }, init));
    var body = await response.json().catch(function () {
      return {};
    });
    return { status: response.status, body: body || {} };
  } finally {
    clearTimeout(timer);
  }
}

// A GET with the setup token, once the page has it. The token is what tells the player this page from any other in
// the phone's browser: only requests that carry it keep setup open, and the network scan is refused without it.
function ask(path) {
  return request(path, S.token ? { headers: { "X-Setup-Token": S.token } } : undefined);
}

function send(path, fields) {
  var init = {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Setup-Token": S.token },
    body: new URLSearchParams(fields).toString()
  };
  return request(path, init, POST_MS);
}

// A 403 means the player restarted since it gave this page its token (or the page has none yet): fetch the new one
// and send once more. The 403 itself is the answer when no new token came, or when the second try is refused too.
async function retried(sendIt) {
  var result = await sendIt();
  if (result.status !== 403) return result;
  var refused = S.token;
  await refresh();
  return S.token === refused ? result : sendIt();
}

function post(path, fields) {
  return retried(function () {
    return send(path, fields);
  });
}

// The player: header, saved settings and the last attempt.

function applyState(state) {
  S.device = state.device || {};
  S.token = state.token || "";
  S.saved = state.saved || null;
  var name = S.device.name || "Cartridge Player";
  say("name", name);
  document.title = "Set up " + name;
  say("fw", "Firmware " + S.device.fw);
  show("fw", Boolean(S.device.fw));
  var reader = $("reader");
  reader.className = "pill " + (S.device.reader === "ok" ? "ok" : "bad");
  reader.textContent = S.device.reader === "ok" ? "Reader ready" : "Reader not responding";
  reader.hidden = !S.device.reader;
  say("device-id", S.device.id || "Unknown");
  // Only a player that could run on what it has saved will leave setup: it says whether it is one.
  show("exit", state.configured === true);
  // What is saved decides the "Saved" badge and what a blank password or key keeps.
  renderNetworks();
  updateNetwork();
}

async function loadState() {
  var result = null;
  try {
    result = await ask("/api/state");
  } catch (error) {
    result = null;
  }
  var answered = Boolean(result && result.status === 200 && result.body.token);
  say("load-error", "Can't reach the player. Check your phone is still on its Wi-Fi network; this page keeps trying.");
  show("load-error", !answered);
  // After an erase the player answers once more with the token it had, then restarts: wait for the new one.
  if (!answered || result.body.token === S.erased) {
    setTimeout(loadState, LOAD_RETRY_MS);
    return;
  }
  if (S.erased) {
    S.erased = "";
    lock(false);
    say("advanced-status", "Erased. The player is ready to set up again.");
  }
  applyState(result.body);
  prefill();
  resume(result.body.attempt);
  // The first scan waits for the token: the player refuses one without it.
  if (!S.listed) {
    S.listed = true;
    scan();
  }
}

// A new setup token after the player restarted, leaving the form as the user filled it.
async function refresh() {
  try {
    var result = await ask("/api/state");
    if (result.status === 200 && result.body.token) applyState(result.body);
  } catch (error) {
    // Out of reach: the caller's own answer says what to do.
  }
}

function prefill() {
  var saved = S.saved;
  if (saved && saved.ssid && !S.ssid && !S.other) {
    S.ssid = saved.ssid;
    S.secure = Boolean(saved.hasPassword);
  }
  if (saved && saved.host) {
    $("host").value = saved.host;
    $("port").value = String(saved.port || 9001);
    $("base").value = saved.base || "";
  }
  setManual(Boolean(saved && saved.host));
  settleSavedNetwork();
  renderNetworks();
  updateNetwork();
}

// A page opened again after the phone rejoined shows how the last attempt went.
function resume(attempt) {
  S.lastAttempt = attempt && attempt.id ? attempt.id : 0;
  if (attempt && attempt.phase && attempt.phase !== "idle") follow(attempt);
}

// Follows an attempt this page didn't start, or doesn't know it started. Only the player knows which network that
// one is joining: the form here may name another.
function follow(attempt) {
  S.attempt = attempt.id;
  S.joining = "";
  show("progress", true);
  lock(true);
  track(attempt);
}

// Step 1: Wi-Fi.

function signalLevel(rssi) {
  if (rssi >= -55) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

var SIGNAL_WORDS = ["", "weak", "fair", "good", "strong"];

async function scan() {
  S.scanning = true;
  $("rescan").disabled = true;
  renderNetworks();
  try {
    var result = await retried(function () {
      return ask("/api/scan");
    });
    if (result.status !== 200) throw new Error("refused");
    var seen = {};
    // With `failed` this is the list from the scan before, if there was one: still the best there is to choose from.
    S.networks = (Array.isArray(result.body.networks) ? result.body.networks : []).filter(function (network) {
      var fresh = network && typeof network.ssid === "string" && network.ssid !== "" && !seen[network.ssid];
      if (fresh) seen[network.ssid] = true;
      return fresh;
    });
    var looking = result.body.scanning === true;
    S.scanPolls = looking ? S.scanPolls + 1 : 0;
    var gaveUp = S.scanPolls >= SCAN_POLLS;
    S.scanning = looking && !gaveUp;
    S.scanFailed = gaveUp || (!looking && result.body.failed === true);
    var chosen = S.other ? null : findNetwork(S.ssid);
    if (chosen) S.secure = Boolean(chosen.secure);
  } catch (error) {
    S.scanning = false;
    S.scanFailed = true;
  }
  if (!S.scanning) S.scanPolls = 0;
  $("rescan").disabled = S.scanning;
  if (S.scanning) setTimeout(scan, SCAN_POLL_MS);
  else settleSavedNetwork();
  renderNetworks();
  updateNetwork();
}

// A saved network the scan can't see is probably hidden: offer it under "Other network…" instead.
function settleSavedNetwork() {
  if (S.scanning || S.scanFailed || S.other || !S.ssid || !S.saved || S.ssid !== S.saved.ssid) return;
  if (S.networks.length === 0 || findNetwork(S.ssid)) return;
  S.other = true;
  $("ssid").value = S.ssid;
}

function findNetwork(ssid) {
  for (var i = 0; i < S.networks.length; i++) if (S.networks[i].ssid === ssid) return S.networks[i];
  return null;
}

function renderNetworks() {
  var list = $("networks");
  list.textContent = "";
  S.networks.forEach(function (network) {
    var row = make("button", "net");
    row.type = "button";
    row.setAttribute("aria-pressed", String(!S.other && network.ssid === S.ssid));
    row.appendChild(make("span", "net-name", network.ssid));
    if (S.saved && S.saved.ssid === network.ssid) row.appendChild(make("span", "badge", "Saved"));
    var level = signalLevel(network.rssi);
    var meta = make("span", "net-meta");
    meta.setAttribute("aria-hidden", "true");
    if (network.secure) meta.appendChild(make("span", "lock"));
    var bars = make("span", "bars l" + level);
    for (var i = 0; i < 4; i++) bars.appendChild(make("i"));
    meta.appendChild(bars);
    row.appendChild(meta);
    row.appendChild(make("span", "sr", (network.secure ? ", secured" : ", open") + ", " + SIGNAL_WORDS[level] + " signal"));
    row.addEventListener("click", function () {
      choose(network.ssid, Boolean(network.secure));
    });
    var item = make("li");
    item.appendChild(row);
    list.appendChild(item);
  });
  $("other").setAttribute("aria-pressed", String(S.other));
  show("ssid-wrap", S.other);
  var status = "";
  if (S.scanning) status = "Looking for networks…";
  else if (S.scanFailed) status = "Couldn't get a new list of networks. Scan again, or choose Other network.";
  else if (S.networks.length === 0) status = "No networks found. Move the player closer to your router and scan again.";
  say("scan-status", status);
}

function choose(ssid, secure) {
  S.ssid = ssid;
  S.secure = secure;
  S.other = false;
  $("password").value = "";
  clearError("ssid");
  clearError("password");
  renderNetworks();
  updateNetwork();
}

function chooseOther() {
  S.other = true;
  S.ssid = "";
  $("ssid").value = "";
  $("password").value = "";
  clearError("ssid");
  renderNetworks();
  updateNetwork();
  $("ssid").focus();
}

function currentSsid() {
  return S.other ? $("ssid").value : S.ssid;
}

function canKeepPassword(ssid) {
  return Boolean(S.saved && S.saved.hasPassword && ssid !== "" && S.saved.ssid === ssid);
}

// The chosen network decides which saved secrets a blank field keeps: the password and, with it, the key.
function updateNetwork() {
  updatePassword();
  updateKey();
}

function updatePassword() {
  var ssid = currentSsid();
  var keep = canKeepPassword(ssid);
  show("password-wrap", S.other || (ssid !== "" && (S.secure || keep)));
  say("password-label", S.other || !ssid ? "Password" : "Password for " + ssid);
  $("password").placeholder = keep ? "Saved password" : "";
  var hint = "";
  if (keep) hint = "Leave it blank to keep the saved password.";
  else if (S.other) hint = "Leave it blank for an open network.";
  say("password-hint", hint);
}

function togglePassword() {
  var input = $("password");
  var reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  say("password-toggle", reveal ? "Hide" : "Show");
  $("password-toggle").setAttribute("aria-pressed", String(reveal));
}

// Step 2: the hub, from a setup code or by hand.

function setManual(manual) {
  S.manual = manual;
  show("details", manual);
  show("code-wrap", !manual);
  say("mode", manual ? "Use a setup code instead" : "Enter details instead");
  ["code", "host", "port", "base", "key"].forEach(clearError);
  updateCode();
}

function parsePort(text) {
  return /^[0-9]{1,5}$/.test(text) ? Number(text) : NaN;
}

function hubTarget() {
  if (!S.manual) return decodeSetupCode($("code").value);
  return {
    host: $("host").value.trim(),
    port: parsePort($("port").value.trim()),
    base: $("base").value.trim()
  };
}

function savedHub(target) {
  var saved = S.saved;
  return Boolean(
    saved && saved.hasKey && target &&
    target.host === saved.host && target.port === saved.port && target.base === saved.base
  );
}

// The player keeps its saved key only for the hub it was proven with, reached over the Wi-Fi it was proven on:
// otherwise anyone at this page could have the key sent through a network of their choosing. It takes the network
// for the saved one only with the password kept (or none, for an open network), never typed again: a typed one
// held against the saved one would tell anyone at this open page whether a guess was right. So keepKey is only
// ever sent with a blank password.
function canKeepKey(target) {
  return savedHub(target) && currentSsid() === S.saved.ssid && $("password").value === "";
}

// A password typed for the saved network: leaving it blank instead is all it takes to keep the saved key.
function retyped() {
  return Boolean(S.saved) && currentSsid() === S.saved.ssid && $("password").value !== "";
}

function updateCode() {
  var value = $("code").value;
  var code = S.manual ? null : decodeSetupCode(value);
  clearError("code");
  if (code) {
    say("code-summary", "Hub " + code.host + ":" + code.port + " · " + (code.key ? "key included" : "add the API key below"));
  } else if (!S.manual && value.trim() !== "") {
    setError("code", "That isn't a whole setup code. Copy it again from the Cartridge Player page in Drift Beacon.");
  }
  show("code-summary", Boolean(code));
  show("key-wrap", S.manual || Boolean(code && code.key === null));
  updateKey();
}

function updateKey() {
  var target = hubTarget();
  var keep = canKeepKey(target);
  $("key").placeholder = keep ? "Saved key" : "db_…";
  var hint = "Create one in Drift Beacon under Workspace settings → API Keys, and give it the player's name.";
  if (keep) {
    hint = "Leave it blank to keep the saved key.";
  } else if (savedHub(target)) {
    hint = retyped()
      ? "A typed Wi-Fi password needs the API key again, or a setup code that includes it. Leave the password " +
        "blank to keep the saved key."
      : "A different Wi-Fi network needs the API key again, or a setup code that includes it.";
  }
  say("key-hint", hint);
}

async function paste() {
  var input = $("code");
  var clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard && clipboard.readText) {
    try {
      input.value = (await clipboard.readText()).trim();
      updateCode();
      return;
    } catch (error) {
      // Refused or unsupported here: fall back to the field.
    }
  }
  input.focus();
  say("code-hint", "Touch and hold the field, then choose Paste.");
}

// Errors sit under the field they're about.

var FIELDS = ["ssid", "password", "code", "host", "port", "base", "key"];

function setError(field, message) {
  say(field + "-error", message);
  show(field + "-error", true);
  $(field).setAttribute("aria-invalid", "true");
}

function clearError(field) {
  say(field + "-error", "");
  show(field + "-error", false);
  $(field).removeAttribute("aria-invalid");
}

// Where the player's complaint about a field shows: a setup code stands in for the hub fields it carries. Nowhere
// (the note alone says it) for a code used before the page was opened again on its details.
function errorTarget(field) {
  if (FIELDS.indexOf(field) < 0 || (S.manual && field === "code")) return null;
  if (!S.manual && (field === "host" || field === "port" || field === "base")) return "code";
  if (!S.manual && field === "key" && $("key-wrap").hidden) return "code";
  if (field === "password" && $("password-wrap").hidden) return "ssid";
  return field;
}

// The form as POST /api/connect fields, or null after marking what's wrong.
function collect() {
  FIELDS.forEach(clearError);
  var problems = [];
  var fields = {};
  var ssid = currentSsid();
  var ssidProblem = ssidError(ssid);
  if (ssidProblem) problems.push(["ssid", ssidProblem]);
  fields.ssid = ssid;

  var password = $("password").value;
  var passwordProblem = passwordError(password);
  fields.password = password;
  if (passwordProblem) {
    problems.push(["password", passwordProblem]);
  } else if (password === "" && canKeepPassword(ssid)) {
    fields.keepPassword = "1";
  } else if (password === "" && !S.other && S.secure && ssid !== "") {
    problems.push(["password", "Enter the password for " + ssid]);
  }

  var target;
  if (!S.manual) {
    var text = $("code").value.trim();
    target = decodeSetupCode(text);
    if (!target) {
      problems.push(["code", text === ""
        ? "Paste the setup code from the Cartridge Player page in Drift Beacon"
        : "That isn't a whole setup code. Copy it again from the Cartridge Player page in Drift Beacon."]);
    } else if (target.key !== null) {
      fields.code = text;
    }
  } else {
    target = hubTarget();
    ["host", "port", "base"].forEach(function (field) {
      var problem = fieldError(field, target[field]);
      if (problem) problems.push([field, problem]);
    });
  }
  if (target && fields.code === undefined) {
    fields.host = target.host;
    fields.port = String(target.port);
    fields.base = target.base;
    var key = $("key").value.trim();
    fields.key = key;
    if (key !== "") {
      var keyProblem = fieldError("key", key);
      if (keyProblem) problems.push(["key", keyProblem]);
    } else if (canKeepKey(target)) {
      fields.keepKey = "1";
    } else if (!savedHub(target)) {
      problems.push(["key", "Paste the API key from Drift Beacon (Workspace settings → API Keys)"]);
    } else {
      // On another network, in the words the player would refuse a kept key with.
      problems.push(["key", retyped()
        ? "Paste the API key, or leave the Wi-Fi password blank: the saved key isn't kept with a typed password"
        : "Paste the API key: the saved one is only kept on the saved Wi-Fi network"]);
    }
  }

  problems.forEach(function (problem) {
    setError(problem[0], problem[1]);
  });
  if (problems.length === 0) return fields;
  // Take the user to the first thing to fix; a network still to choose has no field of its own.
  var first = problems[0][0];
  $(first === "ssid" && !S.other ? "other" : first).focus();
  return null;
}

// Connect, then follow the attempt on the player.

// One thing at a time: while the player works on a Connect, an erase or leaving setup, the form and the Advanced
// actions are off, and the Connect button says what is happening.
function lock(busy, label) {
  S.busy = busy;
  $("fields").disabled = busy;
  ["connect", "exit", "reset", "reset-go"].forEach(function (id) {
    $(id).disabled = busy;
  });
  say("connect", busy ? label || "Connecting…" : "Connect");
}

async function connect(event) {
  event.preventDefault();
  if (S.busy) return;
  var fields = collect();
  if (!fields) return;
  lock(true);
  S.joining = fields.ssid;
  S.attempt = null;
  S.misses = 0;
  say("note", "");
  show("progress", true);
  renderPhase({ phase: "joining" });
  var result;
  try {
    result = await post("/api/connect", fields);
  } catch (error) {
    // The request may have arrived even though the answer didn't: the next state shows a newer attempt if so.
    S.attempt = 0;
    poll();
    return;
  }
  if (result.status === 202 && result.body.attempt) {
    S.attempt = result.body.attempt;
    poll();
    return;
  }
  if (result.status === 403) {
    fail(null, "The player restarted since this page opened. Press Connect again.");
    return;
  }
  // A refusal about no field is "already connecting" (another page, or a Connect whose answer was lost): show how
  // that attempt goes instead of leaving the checklist on a step nobody is watching.
  var running = result.status === 400 && !result.body.field ? await runningAttempt() : null;
  if (running) {
    follow(running);
    return;
  }
  fail(result.body.field, result.body.error || "The player couldn't start (error " + result.status + "). Try again.");
}

async function runningAttempt() {
  try {
    var result = await ask("/api/state");
    var attempt = result.status === 200 ? result.body.attempt : null;
    return attempt && (attempt.phase === "joining" || attempt.phase === "probing") ? attempt : null;
  } catch (error) {
    return null;
  }
}

async function poll() {
  var state = null;
  try {
    var result = await ask("/api/state");
    if (result.status === 200 && result.body.attempt) state = result.body;
  } catch (error) {
    state = null;
  }
  if (!state) {
    S.misses += 1;
    if (S.misses >= MISSES_BEFORE_HINT) {
      say("note", "Your phone may have left the player's network. Rejoin " + deviceName() + " to see the result.");
    }
    setTimeout(poll, POLL_MS);
    return;
  }
  S.misses = 0;
  say("note", "");
  var restarted = state.token !== S.token;
  applyState(state);
  var attempt = state.attempt;
  if (restarted) {
    fail(null, "The player restarted before it finished. Press Connect to try again.");
    return;
  }
  if (S.attempt === 0) {
    if (attempt.id > S.lastAttempt && attempt.phase !== "idle") {
      S.attempt = attempt.id;
    } else {
      fail(null, "The player didn't get the request. Check your phone is on " + deviceName() + " and try again.");
      return;
    }
  }
  // A newer attempt than the one followed (a Connect from another page of this phone): the player says no more of
  // the old one, so the newest is the news.
  if (attempt.id > S.attempt) S.attempt = attempt.id;
  if (attempt.id !== S.attempt) {
    setTimeout(poll, POLL_MS);
    return;
  }
  track(attempt);
}

function track(attempt) {
  S.lastAttempt = attempt.id;
  if (attempt.ssid) S.joining = attempt.ssid;
  renderPhase(attempt);
  if (attempt.phase === "done") finish();
  else if (attempt.phase === "failed") fail(attempt.field, attempt.message || "Setup didn't finish. Try again.");
  // Back to idle: setup was entered again (BOOT held, or CONFIG) before this page saw how the Connect ended, and the
  // player has forgotten it. Nothing more will come of asking.
  else if (attempt.phase === "idle") fail(null, "The player started setup again. Check the settings and press Connect.");
  else setTimeout(poll, POLL_MS);
}

var STEPS = ["wifi", "ip", "plugin", "saved"];

// `stopped`: the Connect ended without the player's word on a step (refused at the door, never received, forgotten),
// so none is in progress any more.
function renderPhase(attempt, stopped) {
  S.shown = attempt;
  var wifiFailed = attempt.field === "ssid" || attempt.field === "password";
  var marks = { joining: ["active"], probing: ["done", "done", "active"], done: ["done", "done", "done", "done"] };
  var states = attempt.phase === "failed"
    ? wifiFailed ? ["failed"] : ["done", attempt.ip ? "done" : "", "failed"]
    : marks[attempt.phase] || marks.joining;
  if (stopped) {
    states = states.map(function (state) {
      return state === "active" ? "" : state;
    });
  }
  var network = S.joining || "your Wi-Fi";
  var labels = [
    states[0] === "done" ? "Joined " + network : "Joining " + network,
    states[1] === "done" && attempt.ip ? "Got " + attempt.ip : "Getting an address",
    states[2] === "done" ? "Plugin answered" : "Reaching the plugin",
    states[3] === "done" ? "Saved" : "Saving"
  ];
  var words = { active: "in progress", done: "done", failed: "failed" };
  STEPS.forEach(function (step, index) {
    var item = $("step-" + step);
    var state = states[index] || "";
    item.className = state;
    item.textContent = labels[index];
    if (state) item.appendChild(make("span", "sr", ", " + words[state]));
  });
}

function fail(field, message) {
  lock(false);
  if (S.shown) renderPhase(S.shown, true);
  var target = errorTarget(field);
  if (target) setError(target, message);
  say("note", message);
}

function finish() {
  lock(false);
  show("form", false);
  show("done", true);
  $("done").focus();
}

// Advanced: leave setup, or erase everything.

// Whether the player did it. If not, why: its own refusal, or what to check when nothing came back.
async function act(path, fields, what) {
  try {
    var result = await post(path, fields);
    if (result.status === 200) return true;
    say("advanced-status", result.body.error || "Couldn't " + what + " (error " + result.status + "). Try again.");
  } catch (error) {
    say("advanced-status", "Couldn't " + what + ". Check your phone is on " + deviceName() + " and try again.");
  }
  return false;
}

async function leaveSetup() {
  lock(true, "Leaving setup…");
  if (!(await act("/api/exit", {}, "leave setup mode"))) {
    lock(false);
    return;
  }
  // The player's network is gone, so nothing on this page can reach it any more.
  lock(true, "Setup closed");
  say("advanced-status", "The player left setup mode. You can close this page.");
}

function armReset(armed) {
  show("reset", !armed);
  show("reset-confirm", armed);
  if (armed) $("reset-cancel").focus();
  else $("reset").focus();
}

async function reset() {
  lock(true, "Erasing…");
  if (!(await act("/api/reset", { confirm: "erase" }, "erase the settings"))) {
    lock(false);
    return;
  }
  armReset(false);
  forget();
  lock(true, "Restarting…");
  say("advanced-status", "Erased. The player is restarting and will open " + deviceName() + " again for setup.");
  S.erased = S.token;
  loadState();
}

// The page as it is for a player with nothing saved: no prefill, no kept secrets, no earlier attempt.
function forget() {
  S.saved = null;
  S.ssid = "";
  S.secure = true;
  S.other = false;
  S.attempt = null;
  S.lastAttempt = 0;
  ["ssid", "password", "code", "host", "base", "key"].forEach(function (id) {
    $(id).value = "";
  });
  $("port").value = "9001";
  show("exit", false);
  show("done", false);
  show("progress", false);
  show("form", true);
  FIELDS.forEach(clearError);
  setManual(false);
  renderNetworks();
  updateNetwork();
}

function start() {
  $("form").addEventListener("submit", connect);
  $("rescan").addEventListener("click", scan);
  $("other").addEventListener("click", chooseOther);
  $("ssid").addEventListener("input", function () {
    clearError("ssid");
    updateNetwork();
  });
  $("password").addEventListener("input", function () {
    clearError("password");
    updateKey();
  });
  $("password-toggle").addEventListener("click", togglePassword);
  $("code").addEventListener("input", updateCode);
  $("paste").addEventListener("click", paste);
  $("key").addEventListener("input", function () {
    clearError("key");
  });
  ["host", "port", "base"].forEach(function (field) {
    $(field).addEventListener("input", function () {
      clearError(field);
      updateCode();
    });
  });
  $("mode").addEventListener("click", function () {
    setManual(!S.manual);
  });
  $("exit").addEventListener("click", leaveSetup);
  $("reset").addEventListener("click", function () {
    armReset(true);
  });
  $("reset-cancel").addEventListener("click", function () {
    armReset(false);
  });
  $("reset-go").addEventListener("click", reset);
  setManual(false);
  // The list is asked for once the player has answered with its token (loadState); it is on its way from the start.
  S.scanning = true;
  $("rescan").disabled = true;
  renderNetworks();
  loadState();
}

start();
