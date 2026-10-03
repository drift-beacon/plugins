import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeExtControlV2,
  encodeExtControlV2,
  EXT_CONTROL_V2_COMMAND,
  parseAnimData,
  staticAnimData,
  staticDisplay,
} from "../shared/protocol.ts";

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");

// The official doc's v2 example (nanoleaf-api.md §5).
const DOC_PANELS = [
  [374, [255, 0, 255], 12],
  [651, [255, 255, 0], 128],
  [235, [0, 255, 255], 451],
];
const DOC_BYTES = "00 03 01 76 FF 00 FF 00 00 0C 02 8B FF FF 00 00 00 80 00 EB 00 FF FF 00 01 C3";

test("extControl v2 encodes the doc's example byte for byte", () => {
  const bytes = encodeExtControlV2(DOC_PANELS);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.length, 2 + 8 * 3);
  assert.equal(hex(bytes), DOC_BYTES);
});

test("extControl v2 decodes the doc's example", () => {
  const bytes = Uint8Array.from(DOC_BYTES.split(" "), (pair) => parseInt(pair, 16));
  assert.deepEqual(decodeExtControlV2(bytes), [
    { id: 374, rgb: [255, 0, 255], transitionDs: 12 },
    { id: 651, rgb: [255, 255, 0], transitionDs: 128 },
    { id: 235, rgb: [0, 255, 255], transitionDs: 451 },
  ]);
});

test("extControl v2 round-trips a Map with the default transition", () => {
  const lights = new Map([
    [0, [0, 0, 0]],
    [36776, [12, 34, 56]],
    [65535, [255, 255, 255]],
  ]);
  const decoded = decodeExtControlV2(encodeExtControlV2(lights));
  assert.deepEqual(decoded, [
    { id: 0, rgb: [0, 0, 0], transitionDs: 1 },
    { id: 36776, rgb: [12, 34, 56], transitionDs: 1 },
    { id: 65535, rgb: [255, 255, 255], transitionDs: 1 },
  ]);
  assert.deepEqual(
    decodeExtControlV2(encodeExtControlV2(lights, 7)).map((panel) => panel.transitionDs),
    [7, 7, 7],
  );
});

test("extControl v2 clamps channels and transitions, and writes W as 0", () => {
  const bytes = encodeExtControlV2([[1, [300, -4, 127.6], 70000]]);
  assert.equal(hex(bytes), "00 01 00 01 FF 00 80 00 FF FF");
  assert.deepEqual(decodeExtControlV2(encodeExtControlV2([[2, [Number.NaN, 1, 2], -3]])), [
    { id: 2, rgb: [0, 1, 2], transitionDs: 0 },
  ]);
});

test("extControl v2 refuses ids it would have to wrap", () => {
  assert.throws(() => encodeExtControlV2([[65536, [1, 2, 3]]]), RangeError);
  assert.throws(() => encodeExtControlV2([[-1, [1, 2, 3]]]), RangeError);
  assert.throws(() => encodeExtControlV2([[1.5, [1, 2, 3]]]), RangeError);
});

test("extControl v2 encodes an empty frame as a zero count", () => {
  assert.equal(hex(encodeExtControlV2([])), "00 00");
  assert.deepEqual(decodeExtControlV2(new Uint8Array([0, 0])), []);
});

test("decoding throws on a malformed length, including a Buffer slice with an offset", () => {
  assert.throws(() => decodeExtControlV2(new Uint8Array([0])), RangeError);
  assert.throws(() => decodeExtControlV2(new Uint8Array([0, 1, 0, 1, 255, 0, 0, 0, 0])), /10 bytes, not 9/);
  assert.throws(() => decodeExtControlV2(new Uint8Array([0, 0, 1])), RangeError);
  const padded = new Uint8Array(40);
  padded.set(encodeExtControlV2([[9, [1, 2, 3], 4]]), 5);
  assert.deepEqual(decodeExtControlV2(padded.subarray(5, 15)), [{ id: 9, rgb: [1, 2, 3], transitionDs: 4 }]);
});

test("staticAnimData writes every panel with one frame", () => {
  assert.equal(
    staticAnimData([
      [82, [255, 0, 255]],
      [60, [0, 255, 255]],
      [118, [0, 0, 0]],
    ], 20),
    "3 82 1 255 0 255 0 20 60 1 0 255 255 0 20 118 1 0 0 0 0 20",
  );
  assert.equal(staticAnimData(new Map([[36776, [10.4, 20.6, 300]]])), "1 36776 1 10 21 255 0 5");
  assert.equal(staticAnimData([[5, [1, 2, 3], -1]]), "1 5 1 1 2 3 0 -1");
  assert.equal(staticAnimData([]), "0");
  assert.throws(() => staticAnimData([[70000, [1, 2, 3]]]), RangeError);
});

test("parseAnimData reads the doc's static example and round-trips staticAnimData", () => {
  const parsed = parseAnimData("3 82 1 255 0 255 0 20 60 1 0 255 255 0 20 118 1 0 0 0 0 20");
  assert.deepEqual([...parsed.keys()], [82, 60, 118]);
  assert.deepEqual(parsed.get(60), [{ r: 0, g: 255, b: 255, w: 0, t: 20 }]);
  const lights = new Map([
    [49632, [255, 214, 170]],
    [34671, [0, 0, 0]],
  ]);
  const back = parseAnimData(staticAnimData(lights, 10));
  assert.deepEqual(back.get(49632), [{ r: 255, g: 214, b: 170, w: 0, t: 10 }]);
  assert.deepEqual(back.get(34671), [{ r: 0, g: 0, b: 0, w: 0, t: 10 }]);
});

test("parseAnimData reads multi-frame custom data across line breaks", () => {
  const data = `2 224 2 0 0 0 0 5 255 0 0 0 10
    89 3 0 0 0 0 -1 0 255 0 0 10 0 0 255 0 10`;
  const parsed = parseAnimData(data);
  assert.equal(parsed.get(224).length, 2);
  assert.deepEqual(parsed.get(89)[0], { r: 0, g: 0, b: 0, w: 0, t: -1 });
  assert.deepEqual(parsed.get(89)[2], { r: 0, g: 0, b: 255, w: 0, t: 10 });
});

test("parseAnimData throws on malformed data", () => {
  assert.throws(() => parseAnimData(""), SyntaxError);
  assert.throws(() => parseAnimData("2 1 1 0 0 0 0 1"), SyntaxError);
  assert.throws(() => parseAnimData("1 1 1 0 0 0 0 1 99"), /trailing/);
  assert.throws(() => parseAnimData("1 1 1 0 x 0 0 1"), SyntaxError);
  assert.throws(() => parseAnimData("1 1 0"), SyntaxError);
});

test("the write bodies match the official examples", () => {
  assert.deepEqual(EXT_CONTROL_V2_COMMAND, { command: "display", animType: "extControl", extControlVersion: "v2" });
  assert.deepEqual(staticDisplay("1 5 1 1 2 3 0 5"), {
    command: "display",
    animType: "static",
    animData: "1 5 1 1 2 3 0 5",
    loop: false,
    palette: [],
    colorType: "HSB",
  });
});
