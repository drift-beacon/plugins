import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeTouchPacket,
  encodeTouchPacket,
  readTouchByte,
  SWIPE_WINDOW_MS,
  FILL_LIKE_PANEL_IDS,
  swipePanel,
  TOUCH_BUFFER_LIMIT,
  TOUCH_DOWN,
  TOUCH_HOLD,
  TOUCH_SWIPE,
  TOUCH_UP,
  TouchBuffer,
  touchByteReadings,
  touchTypeName,
} from "../shared/touch.ts";

const hex = (bytes) => Buffer.from(bytes).toString("hex");

test("a packet is a count, then id, byte 2 and from-id per panel, big-endian, in either byte-2 layout", () => {
  const records = [
    { panelId: 0x1234, type: TOUCH_DOWN, strength: 5 },
    { panelId: 42632, type: TOUCH_SWIPE, strength: 3, fromId: 7 },
  ];
  const table = encodeTouchPacket(records, { layout: "table" });
  assert.equal(hex(table), "0002" + "1234" + "0d" + "ffff" + "a688" + "23" + "0007");
  const text = encodeTouchPacket(records, { layout: "text", fill: 0x00ff });
  assert.equal(hex(text), "0002" + "1234" + "15" + "00ff" + "a688" + "43" + "0007");

  assert.deepEqual(decodeTouchPacket(table), {
    records: [
      { panelId: 0x1234, raw: 0x0d, fromId: 0xffff },
      { panelId: 42632, raw: 0x23, fromId: 7 },
    ],
    count: 2,
    malformed: false,
  });
  assert.deepEqual(
    decodeTouchPacket(text).records.map((record) => record.fromId),
    [0x00ff, 7],
  );
  assert.deepEqual(readTouchByte(0x0d, "table"), { type: TOUCH_DOWN, strength: 5 });
  assert.deepEqual(readTouchByte(0x15, "text"), { type: TOUCH_DOWN, strength: 5 });
  assert.deepEqual(touchByteReadings(0x23), { table: { type: 4, strength: 3 }, text: { type: 2, strength: 3 } });
  assert.equal(touchTypeName(TOUCH_UP), "up");
  assert.equal(touchTypeName(9), null);
  for (const layout of ["table", "text"]) {
    for (let type = 0; type <= 4; type++) {
      for (const strength of [0, 7]) {
        const [record] = decodeTouchPacket(encodeTouchPacket([{ panelId: 1, type, strength }], { layout })).records;
        assert.deepEqual(readTouchByte(record.raw, layout), { type, strength }, `${layout} ${type}/${strength}`);
      }
    }
  }
  assert.throws(() => encodeTouchPacket([{ panelId: 1, type: 8 }], { layout: "text" }), RangeError);
  assert.throws(() => encodeTouchPacket([{ panelId: 1, type: 1, strength: 8 }], { layout: "table" }), RangeError);
  assert.throws(() => encodeTouchPacket([{ panelId: 0x10000, type: 1 }]), RangeError);
});

test("zero panels, short and odd-length packets decode to the whole records that fit, never throwing", () => {
  assert.deepEqual(decodeTouchPacket(encodeTouchPacket([])), { records: [], count: 0, malformed: false });
  assert.deepEqual(decodeTouchPacket(new Uint8Array()), { records: [], count: 0, malformed: true });
  assert.deepEqual(decodeTouchPacket(Uint8Array.of(0)), { records: [], count: 0, malformed: true });
  const two = encodeTouchPacket([
    { panelId: 1, type: TOUCH_DOWN },
    { panelId: 2, type: TOUCH_HOLD },
  ]);
  const cut = decodeTouchPacket(two.subarray(0, two.length - 1));
  assert.equal(cut.malformed, true);
  assert.equal(cut.count, 2);
  assert.deepEqual(
    cut.records.map((record) => record.panelId),
    [1],
  );
  const extra = decodeTouchPacket(Uint8Array.from([...two, 0xaa]));
  assert.equal(extra.malformed, true);
  assert.equal(extra.records.length, 2);
  const overcount = Uint8Array.from(two);
  overcount[1] = 9;
  assert.deepEqual(decodeTouchPacket(overcount).records.length, 2);
  assert.equal(decodeTouchPacket(overcount).malformed, true);
  const undercount = Uint8Array.from(two);
  undercount[1] = 1;
  assert.deepEqual(decodeTouchPacket(undercount).records.length, 1);
  assert.equal(decodeTouchPacket(undercount).malformed, true);
});

const record = (panelId, fromId = 0xffff) => ({ panelId, raw: 0, fromId });
const at = (time, panelId, fromId) => ({ record: record(panelId, fromId), at: time });
const wall = [10, 20, 30, 255];

test("a swipe is placed on the earliest from-id that is a panel on the wall: where the finger started", () => {
  const recent = [at(1000, 10), at(1100, 20, 10), at(1200, 30, 10)];
  assert.equal(swipePanel(recent, 1300, wall), 10, "the start panel, not the end");
  const chained = [at(1000, 10), at(1100, 20, 10), at(1150, 30, 20), at(1200, 10, 30)];
  assert.equal(swipePanel(chained, 1300, wall), 10, "each record naming the panel before it still gives the start");
  const unordered = [at(1200, 30, 20), at(1100, 20, 10)];
  assert.equal(swipePanel(unordered, 1300, wall), 10, "by arrival time, not list order");
  assert.deepEqual(recent.map((touch) => touch.record.panelId), [10, 20, 30], "the list isn't changed");
});

test("without a usable from-id, a swipe is placed on the earliest touched panel on the wall", () => {
  assert.equal(swipePanel([at(1100, 30), at(1000, 20), at(1200, 10)], 1300, wall), 20);
  assert.equal(swipePanel([at(1000, 99), at(1100, 30, 77)], 1300, wall), 30, "ids off the wall are ignored");
  for (const fill of [0xffff, 0x00ff]) {
    const placed = swipePanel([at(1000, 20, fill), at(1100, 30, fill)], 1300, [10, 20, 30]);
    assert.equal(placed, 20, `fill ${fill.toString(16)} isn't a panel`);
  }
});

test("the documented limit: a fill value that is also a panel id reads as the swipe's origin", () => {
  // Known wrong answer, pinned on purpose (nanoleaf-api.md §11): the down on panel 10 carries the fill 0x00FF, and
  // the wall has a panel 255, so the rule takes 255 for where the swipe started. The right answer would be 10, but
  // without trusting byte 2 a fill can't be told from a real from-id.
  const recent = [at(1000, 10, 0x00ff), at(1100, 20, 10)];
  assert.equal(swipePanel(recent, 1300, [10, 20, 255]), 255);
  assert.equal(swipePanel(recent, 1300, [10, 20]), 10, "without a panel 255 it is right");
  assert.deepEqual(FILL_LIKE_PANEL_IDS, [255, 65535]);
});

test("records outside the window, after the swipe or off the wall give null; so does nothing", () => {
  assert.equal(swipePanel([], 1000, wall), null);
  assert.equal(swipePanel([at(1000, 10, 20)], 1000 + SWIPE_WINDOW_MS + 1, wall), null);
  assert.equal(swipePanel([at(1000, 10, 20)], 1000 + SWIPE_WINDOW_MS, wall), 20, "the window's edge counts");
  assert.equal(swipePanel([at(2000, 10, 20)], 1999, wall), null);
  assert.equal(swipePanel([at(1000, 1, 2)], 1100, wall), null);
  assert.equal(swipePanel([at(1000, 10)], 1100, []), null);
  assert.equal(swipePanel([at(1000, 10)], 1100, new Set([10])), 10);
});

test("the buffer drops what ages out and places a swipe by the same rule; a peek uses nothing up", () => {
  const buffer = new TouchBuffer();
  assert.equal(buffer.swipePanel(0, wall), null);
  buffer.push([record(10)], 1000);
  buffer.push([record(20, 10), record(30, 10)], 1100);
  assert.equal(buffer.size, 3);
  assert.equal(buffer.swipePanel(1200, wall), 10);
  assert.equal(buffer.swipePanel(1200, wall), 10, "still there after a peek");
  assert.equal(buffer.recent(1000 + SWIPE_WINDOW_MS + 1).length, 2);
  assert.equal(buffer.swipePanel(1100 + SWIPE_WINDOW_MS + 1, wall), null);
  assert.equal(buffer.size, 2, "a peek drops nothing");
  assert.equal(buffer.recent(1100 + SWIPE_WINDOW_MS + 1).length, 0);
  assert.equal(buffer.size, 0);
  buffer.push([record(10)], 5000);
  buffer.clear();
  assert.equal(buffer.size, 0);
});

test("a swipe uses up the touches that placed it: the next swipe without touches of its own gives null", () => {
  const buffer = new TouchBuffer();
  buffer.push([record(10)], 1000);
  buffer.push([record(20, 10)], 1100);
  assert.equal(buffer.takeSwipePanel(1200, wall), 10);
  assert.equal(buffer.size, 0);
  assert.equal(buffer.takeSwipePanel(1400, wall), null, "the second swipe has no packets");

  buffer.push([record(99)], 2000);
  assert.equal(buffer.takeSwipePanel(2100, wall), null, "an unplaceable swipe uses its touches up too");
  assert.equal(buffer.size, 0);

  buffer.push([record(10)], 3000);
  buffer.push([record(30)], 3200);
  assert.equal(buffer.takeSwipePanel(3100, wall), 10, "only records at or before the swipe count and go");
  assert.deepEqual(buffer.recent(3200).map((touch) => touch.record.panelId), [30]);
});

test("a flood of hover or hold records can't push out where the swipe started", () => {
  const buffer = new TouchBuffer();
  buffer.push([record(10)], 0);
  for (let i = 0; i < 300; i++) buffer.push([record(20)], (i * 400) / 300);
  assert.equal(buffer.size, 2, "a repeated (panel, from-id) pair is kept once, at its first time");
  assert.equal(buffer.takeSwipePanel(400, wall), 10);

  const full = new TouchBuffer();
  full.push([record(10)], 0);
  for (let id = 1000; id < 1000 + TOUCH_BUFFER_LIMIT + 50; id++) full.push([record(id)], 100);
  assert.equal(full.size, TOUCH_BUFFER_LIMIT, "past the limit, new pairs are dropped");
  assert.equal(full.recent(100)[0].record.panelId, 10, "the oldest stays");
  assert.equal(full.takeSwipePanel(200, wall), 10);
});
