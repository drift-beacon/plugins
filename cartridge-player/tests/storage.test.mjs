import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeDevice,
  emptyPlayerRecord,
  LIMITS,
  mappedActivity,
  readMappings,
  readPlayerRecord,
  slotHolding,
} from "../shared/storage.ts";

/** Values storage can hold instead of the right one: an older version, a JSON editor, another device. */
const GARBAGE = [undefined, null, 0, 1, "", "text", true, [], [1, 2], { v: 2 }];
const AT = "2026-10-03T08:00:00.000Z";

const device = (id, fields = {}) => ({
  id,
  name: "Cartridge-A1B2",
  fw: "2.0.0",
  boot: 7,
  seq: 3,
  slot: null,
  lastHeardAt: AT,
  hubHost: "192.168.1.12:9001",
  ...fields,
});

const slot = (tag, fields = {}) => ({
  tag,
  since: AT,
  activityId: "deep",
  sessionId: "s1",
  outcome: "started",
  error: null,
  ...fields,
});

test("tagMappings: garbage reads as no labels; keys come out canonical and only string activity ids stay", () => {
  for (const value of GARBAGE) assert.deepEqual(readMappings(value), {});
  assert.deepEqual(readMappings({ "04a23b1c": "deep", "04:11:22:33": "", "not a tag": "x", "04:44:55:66": 7 }), {
    "04:A2:3B:1C": "deep",
  });
  assert.equal(mappedActivity(readMappings({}), "constructor"), null, "never Object.prototype");
  assert.equal(mappedActivity(readMappings({ "04:A2:3B:1C": "deep" }), "04:A2:3B:1C"), "deep");
});

test("player record: garbage reads as an empty record, so main never sees a half-valid one", () => {
  for (const value of GARBAGE) assert.deepEqual(readPlayerRecord(value), emptyPlayerRecord());
});

test("player record: each bad field falls back on its own, and lists keep their caps", () => {
  const unknown = Array.from({ length: 30 }, (_, i) => ({
    tag: `04:00:00:${i.toString(16).padStart(2, "0")}`,
    lastSeenAt: AT,
  }));
  const history = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, at: AT, kind: "insert", tag: "04:A2:3B:1C" }));
  const record = readPlayerRecord({
    v: 1,
    devices: {
      "cp-1": device("cp-1", {
        boot: -1,
        seq: "3",
        lastHeardAt: "yesterday",
        slot: slot("04a23b1c", { outcome: "dancing" }),
      }),
      "CP-BAD": device("CP-BAD"),
      "cp-2": "nope",
      "cp-3": device("cp-3"),
      "cp-4": device("cp-4"),
      "cp-5": device("cp-5"),
      "cp-6": device("cp-6"),
    },
    active: "cp-9",
    unknown: [{ tag: "04:00:00:00", lastSeenAt: AT }, ...unknown, { tag: "bad", lastSeenAt: AT }],
    cartridges: { "04:a2:3b:1c": { seenAt: "never", plays: -2, playedMs: 1.7e3 }, nope: { plays: 1 } },
    history: [
      { id: 0, at: AT, kind: "insert", tag: "04:A2:3B:1C" },
      { id: 2, at: AT, kind: "explode", tag: "04:A2:3B:1C" },
      ...history,
    ],
    nextId: 3,
  });
  assert.deepEqual(Object.keys(record.devices), ["cp-1", "cp-3", "cp-4", "cp-5"], "valid ids only, at most four");
  assert.deepEqual(record.devices["cp-1"], {
    ...device("cp-1"),
    boot: null,
    seq: null,
    lastHeardAt: null,
    slot: slot("04:A2:3B:1C", { outcome: "idle" }),
  });
  assert.equal(record.active, null, "active points at a known device or nowhere");
  assert.equal(record.unknown.length, LIMITS.unknown);
  assert.equal(new Set(record.unknown.map((item) => item.tag)).size, record.unknown.length, "no duplicates");
  assert.deepEqual(record.cartridges, { "04:A2:3B:1C": { seenAt: null, plays: 0, playedMs: 1700 } });
  assert.equal(record.history.length, LIMITS.history);
  assert.ok(record.history.every((entry) => entry.kind === "insert" && entry.id > 0));
  assert.ok(record.nextId > Math.max(...record.history.map((entry) => entry.id)), "new entries never reuse an id");
});

test("player record: a valid record survives a JSON round trip unchanged", () => {
  const record = {
    v: 1,
    devices: {
      "cp-1": device("cp-1", { slot: slot("04:A2:3B:1C") }),
      "cp-2": device("cp-2", { boot: null, seq: null }),
    },
    active: "cp-1",
    unknown: [{ tag: "04:11:22:33", firstSeenAt: AT, lastSeenAt: AT }],
    cartridges: { "04:A2:3B:1C": { seenAt: AT, plays: 3, playedMs: 60_000 } },
    history: [
      {
        id: 2,
        at: AT,
        kind: "eject",
        tag: "04:A2:3B:1C",
        activityId: "deep",
        deviceId: "cp-1",
        sessionId: "s1",
        durationMs: 60_000,
      },
      {
        id: 1,
        at: AT,
        kind: "new",
        tag: "04:11:22:33",
        activityId: null,
        deviceId: "cp-1",
        sessionId: null,
        durationMs: null,
      },
    ],
    nextId: 3,
  };
  assert.deepEqual(readPlayerRecord(JSON.parse(JSON.stringify(record))), record);
  assert.equal(activeDevice(record).id, "cp-1");
  assert.equal(slotHolding(record, "04:A2:3B:1C").device.id, "cp-1");
  assert.equal(slotHolding(record, "04:11:22:33"), null);
});

test("the device shown without an active one is the one heard from last", () => {
  const record = readPlayerRecord({
    v: 1,
    devices: { "cp-1": device("cp-1"), "cp-2": device("cp-2", { lastHeardAt: "2026-10-03T09:00:00Z" }) },
  });
  assert.equal(activeDevice(record).id, "cp-2");
  assert.equal(activeDevice(emptyPlayerRecord()), null);
});

test("where a cartridge is: the slot holding it, whichever player is the one shown", () => {
  const held = slot("04:A2:3B:1C");
  const devices = { "cp-1": device("cp-1", { slot: held }), "cp-2": device("cp-2") };
  assert.equal(slotHolding(readPlayerRecord({ v: 1, devices, active: "cp-1" }), held.tag).device.id, "cp-1");
  assert.equal(slotHolding(readPlayerRecord({ v: 1, devices, active: "cp-2" }), held.tag).device.id, "cp-1");
});
