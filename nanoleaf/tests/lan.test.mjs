import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLanHost } from "../main/src/lan.ts";
import { addressKind, isHostOnly, lanProblem, parseIPv4, parseIPv6 } from "../shared/lan.ts";

test("lan: private IPv4 ranges and IPv6 unique local addresses are the local network", () => {
  const lan = ["10.0.0.2", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.1.40", "192.168.0.0"];
  for (const host of [...lan, "fd12:3456::1f", "fc00::1", "FDFF::1", "::ffff:192.168.1.40", "::ffff:c0a8:128"]) {
    assert.equal(addressKind(host), "lan", host);
  }
});

test("lan: loopback, link-local and everything else are told apart", () => {
  for (const host of ["127.0.0.1", "127.255.0.9", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) {
    assert.equal(addressKind(host), "loopback", host);
  }
  for (const host of ["169.254.169.254", "169.254.0.1", "fe80::1", "FE80::abcd:1", "febf::1", "::ffff:169.254.1.1"]) {
    assert.equal(addressKind(host), "link-local", host);
  }
  const outside = ["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.167.1.1", "192.169.1.1", "11.0.0.1", "100.64.0.1"];
  // Neither the unspecified addresses (which reach the server itself on some systems) nor deprecated site-local ones.
  outside.push("0.0.0.0", "0.1.2.3", "::", "fec0::1", "2001:db8::40", "2001:4860:4860::8888", "::ffff:8.8.8.8");
  outside.push("255.255.255.255", "224.0.0.251", "ff02::fb", "64:ff9b::808:808");
  for (const host of outside) assert.equal(addressKind(host), "outside", host);
});

test("lan: a host name is not an address, and neither is anything malformed", () => {
  const names = ["nanoleaf", "shapes-6297.local", "localhost", "", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.-4"];
  for (const host of [...names, "0x7f.1", "[fd00::1]", "fe80::1%en0", "1:2:3", "1::2::3", "g::1", "12345::1"]) {
    assert.equal(addressKind(host), null, host);
  }
  assert.deepEqual(parseIPv4("192.168.001.040"), [192, 168, 1, 40]);
  assert.deepEqual(parseIPv6("fd00::40"), [0xfd00, 0, 0, 0, 0, 0, 0, 0x40]);
  assert.deepEqual(parseIPv6("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(parseIPv6("::ffff:10.0.0.2"), [0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0002]);
  assert.deepEqual(parseIPv6("1:2:3:4:5:6:10.0.0.2"), [1, 2, 3, 4, 5, 6, 0x0a00, 0x0002]);
  for (const bad of ["1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7::8:9", "10.0.0.2::1", "::1.2.3", ":::", "1:2:3:4:5:6:7"]) {
    assert.equal(parseIPv6(bad), null, bad);
  }
});

test("lan: a host is a name or an address, with nothing a URL would read as a port, a path or a login", () => {
  const hosts = ["192.168.1.40", "nanoleaf.lan", "Shapes-6297.local", "a", "0x7f.1", "fd00::40", "::1"];
  for (const host of [...hosts, "::ffff:10.0.0.2"]) assert.equal(isHostOnly(host), true, host);
  const more = ["10.0.0.2/x", "10.0.0.2?x", "10.0.0.2#x", "10.0.0.2:80", "user@10.0.0.2", "10.0.0.2 ", " 10.0.0.2"];
  for (const host of [...more, "", ".", "a.", "-a", "a_b", "a\\b", "[fd00::40]", "fe80::1%en0", "fd00::40/x", "a\n"]) {
    assert.equal(isHostOnly(host), false, JSON.stringify(host));
  }
});

test("lan: each refusal says what to enter instead, in the words the address field uses", () => {
  assert.match(lanProblem("8.8.8.8", "outside"), /^8\.8\.8\.8 isn't on your network\. .*like 192\.168\.1\.40\.$/);
  assert.match(lanProblem("127.0.0.1", "loopback"), /^127\.0\.0\.1 is the Drift Beacon server itself\./);
  assert.match(lanProblem("169.254.1.1", "link-local"), /self-assigned.*your router gives it/);
  assert.match(lanProblem("fe80::1", "link-local"), /^Link-local IPv6 addresses .* IPv4 address, like 192\.168\.1\.40/);
});

/* ---- What main checks before `pair` connects (main/src/lan.ts) ---- */

const NAMES = {
  "shapes-6297.local": ["192.168.1.40", "fe80::255:daff:fe5e:6297%en0"],
  "nanoleaf.lan": ["10.0.0.7"],
  "wall.home.arpa": ["fd12:3456::1f"],
  localhost: ["127.0.0.1", "::1"],
  "public.example.com": ["203.0.113.9"],
  "two-faced.example.com": ["192.168.1.40", "203.0.113.9"],
  "metadata.example.com": ["169.254.169.254"],
  "only-link-local.local": ["fe80::1%en0"],
  "empty.example.com": [],
};
const asked = [];
const lookup = async (host) => {
  asked.push(host);
  if (!NAMES[host]) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return NAMES[host];
};
const refusal = async (host, options = {}) => {
  try {
    await assertLanHost(host, { lookup, ...options });
  } catch (error) {
    assert.equal(error.name, "PluginError", `${host}: ${error}`);
    return error;
  }
  return null;
};

test("pair's host check: private addresses pass without a lookup, and names by where they lead", async () => {
  asked.length = 0;
  for (const host of ["192.168.1.40", "10.0.0.2", "172.20.1.1", "fd12:3456::1f", "::ffff:192.168.1.40"]) {
    assert.equal(await refusal(host), null, host);
  }
  assert.deepEqual(asked, []);
  // A controller's mDNS name leads to its IPv4 address and a link-local IPv6 one, which is skipped, not refused.
  for (const host of ["shapes-6297.local", "nanoleaf.lan", "wall.home.arpa"]) {
    assert.equal(await refusal(host), null, host);
  }
  assert.deepEqual(asked, ["shapes-6297.local", "nanoleaf.lan", "wall.home.arpa"]);
});

test("pair's host check: public, loopback and link-local addresses are refused as invalid", async () => {
  const cases = [
    ["8.8.8.8", /isn't on your network/],
    ["2001:db8::40", /isn't on your network/],
    ["0.0.0.0", /isn't on your network/],
    ["public.example.com", /public\.example\.com isn't on your network/],
    ["two-faced.example.com", /isn't on your network/],
    ["127.0.0.1", /the Drift Beacon server itself/],
    ["::1", /the Drift Beacon server itself/],
    ["localhost", /localhost is the Drift Beacon server itself/],
    ["169.254.169.254", /self-assigned/],
    ["metadata.example.com", /self-assigned/],
    ["fe80::1", /Link-local IPv6/],
    ["fe80::1%en0", /Link-local IPv6/],
  ];
  for (const [host, message] of cases) {
    const error = await refusal(host);
    assert.equal(error?.code, "invalid", host);
    assert.match(error.message, message, host);
  }
});

test("pair's host check: the address is judged as fetch reads it, and nothing but a host gets through", async () => {
  // The forms a URL turns into an IPv4 address: hex, a single number, octal, missing octets.
  for (const host of ["0x7f.0.0.1", "0x7f.1", "2130706433", "017700000001", "127.1"]) {
    const error = await refusal(host);
    assert.equal(error?.code, "invalid", host);
    assert.match(error.message, /the Drift Beacon server itself/, host);
  }
  assert.match((await refusal("010.0.0.1")).message, /isn't on your network/, "010 is octal 8 to fetch");
  assert.equal(await refusal("0xc0.0xa8.1.40"), null, "192.168.1.40 in hex is still the local network");
  // A path, a query, a fragment, a port, a login, a space, brackets, a backslash: `http.ts` would build another URL.
  const smuggled = ["10.0.0.2/x", "10.0.0.2?x", "10.0.0.2#x", "10.0.0.2:80", "user@10.0.0.2", "10.0.0.2 ", "a b"];
  for (const host of [...smuggled, "[fd00::1]", "10.0.0.2\\x", "", ".", "-a.local", "evil.example.com/..", "a_b"]) {
    const error = await refusal(host, { allowLoopback: true });
    assert.equal(error?.code, "invalid", JSON.stringify(host));
    assert.match(error.message, /isn't an IP address or host name/, JSON.stringify(host));
  }
});

test("pair's host check: a zone is refused as its address would be, else for the zone; another % isn't a host", async () => {
  const cases = [
    ["fe80::1%en0", /Link-local IPv6/],
    ["2001:db8::1%eth0", /2001:db8::1%eth0 isn't on your network/],
    ["::1%lo0", /the Drift Beacon server itself/],
    ["fd00::1%eth0", /Enter fd00::1 without its zone/],
    // Not zones: only an IPv6 address has one.
    ["10.0.0.1%2f", /isn't an IP address or host name/],
    ["10.0.0.1%eth0", /isn't an IP address or host name/],
    ["wall.local%25", /isn't an IP address or host name/],
    ["%", /isn't an IP address or host name/],
    ["1:2:3%en0", /isn't an IP address or host name/],
  ];
  for (const [host, message] of cases) {
    const error = await refusal(host);
    assert.equal(error?.code, "invalid", host);
    assert.match(error.message, message, host);
  }
  // A development build accepts loopback, but still nothing with a zone: the URL can't carry it.
  const error = await refusal("::1%lo0", { allowLoopback: true });
  assert.equal(error?.code, "invalid");
  assert.match(error.message, /Enter ::1 without its zone/);
});

test("pair's host check: a development build may use the server's loopback, and nothing else more", async () => {
  for (const host of ["127.0.0.1", "::1", "localhost", "0x7f.1", "::ffff:127.0.0.1"]) {
    assert.equal(await refusal(host, { allowLoopback: true }), null, host);
  }
  for (const host of ["8.8.8.8", "169.254.169.254", "public.example.com", "fe80::1", "0.0.0.0"]) {
    assert.equal((await refusal(host, { allowLoopback: true }))?.code, "invalid", host);
  }
});

test("pair's host check: a name nothing answers to is unavailable, and an abort ends the lookup", async () => {
  for (const host of ["nowhere.local", "empty.example.com", "only-link-local.local"]) {
    const error = await refusal(host);
    assert.equal(error?.code, "unavailable", host);
    assert.match(error.message, /192\.168\.1\.40/, host);
  }
  const leaving = new AbortController();
  const reason = new DOMException("The interface gave up", "AbortError");
  const never = () => new Promise(() => {});
  const check = assertLanHost("slow.local", { lookup: never, signal: leaving.signal });
  leaving.abort(reason);
  await assert.rejects(check, (error) => error === reason);
  await assert.rejects(
    assertLanHost("slow.local", { lookup: never, signal: leaving.signal }),
    (error) => error === reason,
  );
  // The real resolver: loopback by name.
  await assert.rejects(assertLanHost("localhost"), { code: "invalid" });
  await assertLanHost("localhost", { allowLoopback: true });
});

test("pair's host check: a name is judged by where it leads when asked, and nothing is remembered", async () => {
  // The check guards against wrong entries, not attackers: it looks the name up each time it is asked and pins
  // nothing, and the connections that follow look it up again themselves (DESIGN.md "Which hosts `pair` accepts").
  const answers = [["192.168.1.40"], ["192.168.1.77"], ["203.0.113.9"], ["192.168.1.40"]];
  const lookups = [];
  const lookup = async (host) => {
    lookups.push(host);
    return answers[lookups.length - 1];
  };
  assert.equal(await assertLanHost("wall.lan", { lookup }), undefined, "a host name works");
  assert.equal(await assertLanHost("wall.lan", { lookup }), undefined, "and still does when its address changed");
  await assert.rejects(assertLanHost("wall.lan", { lookup }), {
    code: "invalid",
    message: /wall\.lan isn't on your network/,
  });
  assert.equal(await assertLanHost("wall.lan", { lookup }), undefined, "a refusal isn't remembered either");
  assert.deepEqual(lookups, ["wall.lan", "wall.lan", "wall.lan", "wall.lan"]);
});
