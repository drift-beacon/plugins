import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cueFor,
  HEARTBEAT_S,
  OFFLINE_AFTER_MS,
  parseReport,
  playerReply,
  probeReply,
  REPLY_NAME_MAX,
} from "../shared/protocol.ts";
import { normalizeTag, shortTag } from "../shared/tags.ts";

/** A report as the firmware sends it. */
const body = (fields = {}) => ({
  v: 2,
  device: { id: "cp-a1b2c3", fw: "2.0.0", name: "Cartridge-A1B2" },
  boot: 3_141_592_653,
  seq: 4,
  reason: "change",
  tag: "04:A2:3B:1C",
  age_ms: 120.4,
  rssi: -61,
  uptime_s: 3600,
  reader: "ok",
  ...fields,
});

test("tags: every spelling of a UID gives the text tagMappings is keyed by, and anything else is no tag", () => {
  for (const spelling of ["04:A2:3B:1C", "04a23b1c", " 04-a2-3b-1c ", "04:a2:3B:1c"]) {
    assert.equal(normalizeTag(spelling), "04:A2:3B:1C");
  }
  assert.equal(normalizeTag("04A23B1C7F5D80"), "04:A2:3B:1C:7F:5D:80");
  for (const bad of ["", "04:A2:3B", "04:A2:3B:1G", "constructor", "__proto__", 42, null, undefined, {}]) {
    assert.equal(normalizeTag(bad), null, `${String(bad)} isn't a tag`);
  }
  assert.equal(shortTag("04:A2:3B:1C:7F:5D:80"), "04:A2:3B:1C…");
});

test("a report from the firmware parses, with its tag canonical and its fields named in camelCase", () => {
  const parsed = parseReport(
    body({ tag: "04a23b1c", device: { id: "cp-a1b2c3", fw: "2.0.0", name: "Cart\u0007ridge" } }),
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, {
    v: 2,
    device: { id: "cp-a1b2c3", fw: "2.0.0", name: "Cartridge" },
    boot: 3_141_592_653,
    seq: 4,
    reason: "change",
    tag: "04:A2:3B:1C",
    ageMs: 120,
    rssi: -61,
    uptimeS: 3600,
    reader: "ok",
  });
  assert.equal(parseReport(body({ tag: null })).value.tag, null, "an empty slot is null");
  assert.equal(parseReport(body({ later: { field: 1 } })).ok, true, "later firmware can add fields");
});

test("a report main can't order or trust is refused (400), never half-applied", () => {
  const refused = [
    ["no body", null],
    ["another protocol", body({ v: 3 })],
    ["no device", body({ device: undefined })],
    ["an upper-case device id", body({ device: { id: "CP-A1" } })],
    ["a negative boot", body({ boot: -1 })],
    ["a fractional seq", body({ seq: 1.5 })],
    ["a seq over 32 bits", body({ seq: 2 ** 32 })],
    ["an unknown reason", body({ reason: "because" })],
    ["a tag that isn't a UID", body({ tag: "hello" })],
  ];
  for (const [what, value] of refused) {
    const parsed = parseReport(value);
    assert.equal(parsed.ok, false, what);
    assert.equal(typeof parsed.error, "string", what);
  }
});

test("a reply fits the player's 512-byte buffer even with the longest name and seq, and carries the cue for its result", () => {
  const reply = playerReply(0xffff_ffff, "started", "Ж".repeat(200));
  assert.equal(reply.activity.length, REPLY_NAME_MAX);
  assert.ok(new TextEncoder().encode(JSON.stringify(reply)).length < 512);
  assert.equal(reply.heartbeat_s, HEARTBEAT_S);
  const cues = {
    started: "ok",
    marked: "ok",
    resumed: "ok",
    ended: "bye",
    empty: "bye",
    unknown: "unknown",
    orphan: "error",
    archived: "error",
    error: "error",
    unchanged: "none",
    stale: "none",
  };
  for (const [result, cue] of Object.entries(cues)) assert.equal(cueFor(result), cue, result);
});

test("a reply cuts the activity's name by character, never through the middle of an emoji", () => {
  const name = `${"a".repeat(REPLY_NAME_MAX - 1)}😀 and more`;
  const reply = playerReply(1, "started", name);
  assert.equal(reply.activity, `${"a".repeat(REPLY_NAME_MAX - 1)}😀`);
  assert.doesNotMatch(JSON.stringify(reply), /\\ud83d/i, "no lone surrogate reaches the player");
  assert.equal(Array.from(playerReply(1, "started", "😀".repeat(60)).activity).length, REPLY_NAME_MAX);
  assert.ok(Buffer.byteLength(JSON.stringify(playerReply(4_294_967_295, "unchanged", "😀".repeat(60)))) < 512);
});

test("the probe names the plugin and protocol, and offline means two missed heartbeats", () => {
  assert.deepEqual(probeReply(), { ok: true, player: "cartridge-player", protocol: 2, heartbeat_s: HEARTBEAT_S });
  assert.ok(OFFLINE_AFTER_MS > 2 * HEARTBEAT_S * 1000);
});
