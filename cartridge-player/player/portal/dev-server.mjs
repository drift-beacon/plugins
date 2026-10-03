// A stand-in for the player in setup mode, for working on the setup page in a desktop browser. Development only.
//
//   node player/portal/dev-server.mjs [--port 5391] [--saved] [--scan-fails]
//
// It serves the page built fresh from the sources on every load (gzipped, as the player does) and fakes the setup API
// from DESIGN.md. What you type picks the outcome of Connect:
//   - Wi-Fi password "wrongpass1": fails while joining, on the password field
//   - network "Flaky" (Other network…): stops answering for 12 s while joining, as if the phone left the network
//   - an API key containing "bad": fails at the plugin, on the key field
//   - anything else: joins, gets an address, the plugin answers, saved
// It keeps the player's rules about saved secrets: a kept password only for the saved network, a kept key only for
// the saved hub on the saved network with its password kept, not typed again (--saved has "home-password", which
// typed beside keepKey is refused like any other). tests/portal.test.mjs holds `refusal` against the player's own
// planConnect. A second Connect while one runs is refused, and so is Leave setup then, or before anything is saved.
// Leave setup answers and closes 0.8 s later: silent for 8 s, then back in setup mode as if BOOT was held. Erase
// restarts the "player": silent for 4 s, then back with a new token and nothing saved. With --scan-fails the first
// scan gives up after 12 s and says so; Scan again then works.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { buildPage, gzipPage } from "./build.mjs";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]) || 5391;

const device = { id: "cp-a1b2c3", name: "Cartridge-A1B2", fw: "2.0.0", reader: "ok" };
let token = randomBytes(8).toString("hex");
const BASE = "/api/plugins/cartridge-player/api";
let saved = args.includes("--saved")
  ? { ssid: "Home", hasPassword: true, host: "192.168.1.12", port: 9001, base: BASE, hasKey: true }
  : null;
/** The password behind `saved.hasPassword`. Never sent: only compared, as the player does for a kept key. */
let savedPassword = saved ? "home-password" : "";
const IDLE = { phase: "idle", message: "", field: null, ip: null, ssid: null };
let attempt = { id: 0, ...IDLE };
let silentUntil = 0;
/** The close that follows Leave setup, while it is still on its way. */
let leaving = null;
const scan = { endsAt: 0, listedAt: -Infinity, listed: [], failing: args.includes("--scan-fails") };

const networks = [
  { ssid: "Home", rssi: -48, secure: true },
  { ssid: "Home", rssi: -71, secure: true },
  { ssid: "<img src=x onerror=alert(1)>", rssi: -60, secure: true },
  { ssid: "Kitchen Speaker Setup", rssi: -66, secure: false },
  { ssid: "Neighbour's 2.4 GHz with a long name that goes on", rssi: -79, secure: true },
  { ssid: "Café guest", rssi: -84, secure: false },
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readForm(req) {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(text))));
  });
}

/** The next step of this attempt, unless another attempt or an erase came first. */
function later(ms, step) {
  const current = attempt;
  setTimeout(() => {
    if (attempt === current) step();
  }, ms);
}

const running = () => attempt.phase === "joining" || attempt.phase === "probing";

/**
 * /api/scan: a list older than 15 s starts a scan, which takes 2 s. One that fails is tried for 12 s, then `failed`
 * says once that there is no new list, and the request after that starts over.
 */
function scanAnswer(now) {
  if (scan.endsAt && now >= scan.endsAt) {
    scan.endsAt = 0;
    if (scan.failing) {
      scan.failing = false;
      return { scanning: false, failed: true, networks: scan.listed };
    }
    scan.listed = networks;
    scan.listedAt = now;
  }
  if (!scan.endsAt && now > scan.listedAt + 15000) scan.endsAt = now + (scan.failing ? 12000 : 2000);
  return { scanning: scan.endsAt !== 0, failed: false, networks: scan.listed };
}

/**
 * What the player refuses before it starts, as [field, sentence]: the rules about kept secrets from planConnect in
 * src/core/setup.h, for a player with `saved` (as /api/state shows it) and `savedPassword` behind it. The page
 * checks everything else itself.
 */
export function refusal(form, saved, savedPassword) {
  if (!form.ssid) return ["ssid", "Choose a network, or type its name"];
  if (!form.code && !form.host) return ["code", "Paste the setup code"];
  const savedNetwork = saved?.ssid === form.ssid;
  if (form.keepPassword === "1" && !savedNetwork) {
    return ["password", "Type the password: a saved one is only kept for its own network"];
  }
  if (form.code || form.key) return null;
  if (form.keepKey !== "1") return ["key", "Paste the whole API key, without spaces"];
  const savedHub = saved?.hasKey && saved.host === form.host && saved.port === Number(form.port) && saved.base === form.base;
  if (!savedHub) return ["key", "Paste the API key: the saved one is only kept for the same hub address"];
  // The saved password kept, not typed again: a typed one held against it would say whether a guess was right. An
  // open network has none to guess.
  const passwordKept = form.keepPassword === "1" || savedPassword === "";
  if (!savedNetwork || !passwordKept || passwordOf(form, savedPassword) !== savedPassword) {
    return ["key", "Paste the API key: the saved one is only kept on the saved Wi-Fi network"];
  }
  return null;
}

const passwordOf = (form, savedPassword) => (form.keepPassword === "1" ? savedPassword : (form.password ?? ""));

function run(form) {
  attempt = { id: attempt.id + 1, ...IDLE, phase: "joining", ssid: form.ssid };
  const fail = (field, message) => Object.assign(attempt, { phase: "failed", field, message });
  if (form.password === "wrongpass1") {
    later(3000, () => fail("password", `${form.ssid} didn't accept this password`));
    return;
  }
  if (form.ssid === "Flaky") silentUntil = Date.now() + 12000;
  const password = passwordOf(form, savedPassword);
  const wifi = { ssid: form.ssid, hasPassword: password !== "" };
  const key = form.key ?? (form.code ? "from-code" : "");
  later(2500, () => {
    Object.assign(attempt, { phase: "probing", ip: "192.168.1.57" });
    // As the player does: a network is saved as soon as it's joined only while no key is saved.
    if (!saved?.hasKey) {
      saved = { ...saved, ...wifi };
      savedPassword = password;
    }
  });
  later(5000, () => {
    if (key.includes("bad")) return fail("key", "The hub didn't accept this API key");
    const { host = "192.168.1.12", port: hubPort = "9001", base = BASE } = form;
    saved = { ...wifi, host, port: Number(hubPort), base, hasKey: true };
    savedPassword = password;
    attempt.phase = "done";
  });
}

/** As the player does: the answer goes out first and the network closes 0.8 s later, unless a Connect comes first. */
function leave() {
  leaving = setTimeout(() => {
    leaving = null;
    // Setup entered again forgets the last Connect's result; the id carries on.
    attempt = { id: attempt.id, ...IDLE };
    silentUntil = Date.now() + 8000;
  }, 800);
}

function restart() {
  clearTimeout(leaving);
  leaving = null;
  saved = null;
  savedPassword = "";
  attempt = { id: 0, ...IDLE };
  token = randomBytes(8).toString("hex");
  silentUntil = Date.now() + 4000;
}

async function serve(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/") && Date.now() < silentUntil) {
    req.socket.destroy();
    return;
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Encoding": "gzip", "Cache-Control": "no-store" });
    res.end(gzipPage(buildPage()));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    send(res, 200, { device, token, configured: saved?.hasKey === true, saved, attempt });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/scan") {
    // As the player does: a scan is only for the page itself, which is the one that can send the token.
    if (req.headers["x-setup-token"] !== token) {
      send(res, 403, { error: "Reload the setup page and try again", field: null });
      return;
    }
    send(res, 200, scanAnswer(Date.now()));
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    const formEncoded = String(req.headers["content-type"]).startsWith("application/x-www-form-urlencoded");
    if (req.headers["x-setup-token"] !== token || !formEncoded) {
      send(res, 403, { error: "Reload the setup page and try again", field: null });
      return;
    }
    const fields = await readForm(req);
    if (url.pathname === "/api/connect") {
      const refused = refusal(fields, saved, savedPassword);
      if (refused) return send(res, 400, { error: refused[1], field: refused[0] });
      if (running()) {
        return send(res, 400, { error: "The player is already connecting: wait for it to finish", field: null });
      }
      // A Connect in the moment after Leave setup calls the close off.
      clearTimeout(leaving);
      leaving = null;
      run(fields);
      send(res, 202, { attempt: attempt.id });
      return;
    }
    if (url.pathname === "/api/reset") {
      if (fields.confirm !== "erase") {
        return send(res, 400, { error: "Send confirm=erase to erase the player", field: null });
      }
      send(res, 200, { ok: true });
      restart();
      return;
    }
    if (url.pathname === "/api/exit") {
      if (running()) return send(res, 400, { error: "Wait for Connect to finish", field: null });
      if (!saved?.hasKey) return send(res, 400, { error: "Set the player up first", field: null });
      send(res, 200, { ok: true });
      leave();
      return;
    }
  }
  res.writeHead(302, { Location: "/" });
  res.end();
}

// Only when run, so the test can import `refusal` without a server starting.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  createServer(serve).listen(port, () => console.log(`Setup page mock on http://localhost:${port}/`));
}
