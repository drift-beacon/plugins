import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PORT, parseAddress } from "../ui/src/components/setup/address.ts";

test("address: an IPv4 address takes the default port", () => {
  assert.deepEqual(parseAddress("192.168.1.40"), { ok: true, host: "192.168.1.40", port: DEFAULT_PORT });
  assert.equal(DEFAULT_PORT, 16021);
});

test("address: host:port, surrounding spaces and a pasted URL", () => {
  assert.deepEqual(parseAddress("  192.168.1.40:16022 "), { ok: true, host: "192.168.1.40", port: 16022 });
  assert.deepEqual(parseAddress("http://192.168.1.40:16021/api/v1/"), { ok: true, host: "192.168.1.40", port: 16021 });
  assert.deepEqual(parseAddress("HTTPS://nanoleaf.local"), { ok: true, host: "nanoleaf.local", port: 16021 });
});

test("address: host names", () => {
  assert.deepEqual(parseAddress("shapes-6297.local"), { ok: true, host: "shapes-6297.local", port: 16021 });
  assert.deepEqual(parseAddress("nanoleaf"), { ok: true, host: "nanoleaf", port: 16021 });
  assert.equal(parseAddress("-bad.local").ok, false);
  assert.equal(parseAddress("under_score.local").ok, false);
  assert.equal(parseAddress("a..b").ok, false);
});

test("address: bracketed IPv6, with or without a port", () => {
  assert.deepEqual(parseAddress("[fd00::40]"), { ok: true, host: "fd00::40", port: 16021 });
  assert.deepEqual(parseAddress("[fd00::40]:16022"), { ok: true, host: "fd00::40", port: 16022 });
  assert.deepEqual(parseAddress("[fd12:3456::1f]"), { ok: true, host: "fd12:3456::1f", port: 16021 });
  assert.deepEqual(parseAddress("[::ffff:192.168.1.40]"), { ok: true, host: "::ffff:192.168.1.40", port: 16021 });
  assert.deepEqual(parseAddress("http://[fd00::40]:16021/api/v1"), { ok: true, host: "fd00::40", port: 16021 });
  assert.match(errorOf("fd00::40"), /brackets, like \[fd00::40\]/);
  for (const input of ["[1:2:3]", "[1::2::3]", "[12345::1]", "[::ffff:300.1.1.1]", "[g::1]", "[1:2:3:4:5:6:7:8:9]"]) {
    assert.match(errorOf(input), /doesn't look like an IPv6 address/, input);
  }
});

// The server can't reach them: a WHATWG URL (so fetch) can't carry a zone, and fe80:: is useless without one.
test("address: link-local IPv6, with a zone or without, is refused and IPv4 suggested", () => {
  for (const input of [
    "[fe80::1]",
    "[fe80::1]:16021",
    "fe80::1",
    "[FE80::abcd:1]",
    "[febf::1]",
    "fe80::1%en0",
    "[fe80::1%en0]:16021",
    "http://[fe80::1%25en0]:16021/",
  ]) {
    const error = errorOf(input);
    assert.match(error, /Link-local IPv6/, input);
    assert.match(error, /IPv4 address, like 192\.168\.1\.40/, input);
    assert.doesNotMatch(error, /\[fe80/, input);
  }
  // fec0:: is outside fe80::/10: refused too, but for not being on the local network.
  assert.doesNotMatch(errorOf("[fec0::1]"), /Link-local/);
});

test("address: a zone on another address is refused for the zone, and a % elsewhere isn't a host", () => {
  for (const input of ["fd00::40%eth0", "[fd00::40%eth0]:16021", "http://[fd00::40%25eth0]:16021/", "::1%lo0"]) {
    assert.match(errorOf(input), /without its zone/, input);
  }
  assert.match(errorOf("[2001:db8::40%eth0]"), /2001:db8::40 isn't on your network/);
  for (const input of ["10.0.0.1%2f", "10.0.0.1%2f:16021", "10.0.0.1%eth0", "wall.local%25"]) {
    assert.match(errorOf(input), /isn't an IP address or host name/, input);
  }
});

// Main pairs only with a private address on the local network (shared/lan.ts): the field says so before it asks.
test("address: addresses outside the local network are refused with what to enter instead", () => {
  for (const input of ["8.8.8.8", "8.8.8.8:16021", "http://203.0.113.9/", "172.32.0.1", "[2001:db8::40]", "0.0.0.0"]) {
    const error = errorOf(input);
    assert.match(error, /isn't on your network/, input);
    assert.match(error, /like 192\.168\.1\.40/, input);
  }
  assert.match(errorOf("[2001:db8::40]:16021"), /^2001:db8::40 isn't on your network/);
  assert.match(errorOf("[fec0::1]"), /isn't on your network/);
  assert.match(errorOf("169.254.10.20"), /self-assigned/);
  for (const input of ["10.0.0.2", "172.16.4.1", "172.31.255.254", "192.168.0.1", "[fc00::1]"]) {
    assert.equal(parseAddress(input).ok, true, input);
  }
  // Main decides about its own loopback (a development build pairs with the emulator there) and about names.
  assert.deepEqual(parseAddress("127.0.0.1:16021"), { ok: true, host: "127.0.0.1", port: 16021 });
  assert.equal(parseAddress("[::1]").ok, true);
  assert.equal(parseAddress("localhost").ok, true);
  assert.equal(parseAddress("nanoleaf.example.com").ok, true);
});

// Main reads an address the way `fetch` does, where a leading zero means octal: the field sends plain decimals.
test("address: an IPv4 address is sent without leading zeros", () => {
  assert.deepEqual(parseAddress("192.168.001.040"), { ok: true, host: "192.168.1.40", port: 16021 });
  assert.deepEqual(parseAddress("010.0.0.2:16022"), { ok: true, host: "10.0.0.2", port: 16022 });
});

test("address: incomplete or out-of-range IPs are refused with a reason", () => {
  for (const input of ["192.168.1", "192.168.1.256", "1.2.3.4.5", "999.1.1.1"]) {
    const parsed = parseAddress(input);
    assert.equal(parsed.ok, false, input);
    assert.match(parsed.ok ? "" : parsed.error, /four numbers/, input);
  }
});

test("address: empty input and bad ports", () => {
  assert.match(errorOf(""), /IP address or host name/);
  assert.match(errorOf("   "), /IP address or host name/);
  assert.match(errorOf("192.168.1.40:"), /port is a number/);
  assert.match(errorOf("192.168.1.40:abc"), /port is a number/);
  assert.match(errorOf("192.168.1.40:0"), /1 to 65535/);
  assert.match(errorOf("192.168.1.40:70000"), /1 to 65535/);
});

function errorOf(input) {
  const parsed = parseAddress(input);
  assert.equal(parsed.ok, false, input);
  return parsed.error;
}
