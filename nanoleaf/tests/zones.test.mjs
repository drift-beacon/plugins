import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { speaksTo } from "../shared/acting-for.ts";
import { layoutFromPanelLayout, placeLayout } from "../shared/geometry.ts";
import { resolveGesture, touchZone } from "../shared/gestures.ts";
import { fillSpans, resolveOrder } from "../shared/order.ts";
import { decideScene, decideZoneScenes, OFF_SCENE, outputScene, wallSceneKey } from "../shared/scene.ts";
import { DEFAULT_ORDER, DEFAULT_SETTINGS } from "../shared/storage.ts";
import {
  combinedOrder,
  drawnZones,
  isSplit,
  resolveZones,
  ZONE_TAG_LEVEL,
  ZONE_TAGS,
  zoneFills,
  zoneOfPanel,
  zoneTag,
  zoneTagLights,
} from "../shared/zones.ts";

const OWNER = { id: "sam", name: "Sam", role: "OWNER" };
const JO = { id: "jo", name: "Jo", role: "MEMBER" };
const RILEY = { id: "riley", name: "Riley", role: "MEMBER" };
const MEMBERS = [OWNER, JO, RILEY];
const PANELS = [1, 2, 3, 4, 5, 6];
const ORDER = { mode: "auto", auto: "left-right", ids: [], seed: 1, sweepFill: "panels" };
const OWN = { mode: "random", auto: "path", ids: [], seed: 9, sweepFill: "line" };

const resolve = (stored, members = MEMBERS, panels = PANELS) => resolveZones(stored, panels, members, ORDER);
/** `[id, member, panels]` per resolved zone. */
const shape = (zones) => zones.map((z) => [z.id, z.member, z.panels]);

const layoutOf = (name) => {
  const data = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
  return layoutFromPanelLayout(data.panelLayout, data.serialNo, "2026-09-30T12:00:00.000Z");
};

/* ---- resolveZones ---- */

test("an unsplit wall is one zone over every panel, for its member, filling by the wall's order", () => {
  const [zone, ...rest] = resolve([{ id: "wall", member: "jo" }]);
  assert.deepEqual(rest, []);
  assert.deepEqual(zone, {
    id: "wall",
    member: "jo",
    following: ["jo"],
    panels: PANELS,
    order: ORDER,
    position: 0,
  });
  // Nothing stored yet: the wall, for the owner.
  assert.deepEqual(shape(resolve([])), [["wall", "sam", PANELS]]);
  assert.deepEqual(shape(resolve([{ id: "wall", member: null }])), [["wall", "sam", PANELS]]);
});

test("the only stored zone's member has left: it acts for the owner, keeping its id and order", () => {
  const [zone] = resolve([{ id: "wall", member: "gone", panels: [2], order: OWN }]);
  assert.deepEqual([zone.id, zone.member, zone.following, zone.panels, zone.order], [
    "wall",
    "sam",
    ["sam"],
    PANELS,
    OWN,
  ]);
});

test("one of two zones' members has left: that zone is dropped and its panels join the first remaining zone", () => {
  const stored = [
    { id: "wall", member: "gone", panels: [1, 2] },
    { id: "z1", member: "jo", panels: [3, 4] },
    { id: "z2", member: "riley", panels: [5] },
  ];
  const zones = resolve(stored);
  assert.deepEqual(shape(zones), [
    ["z1", "jo", [1, 2, 3, 4, 6]],
    ["z2", "riley", [5]],
  ]);
  // Positions stay the stored ones, so tag colours don't move.
  assert.deepEqual(zones.map((z) => z.position), [1, 2]);
});

test("both members have left: one zone (\"wall\") for the owner over every panel, by the wall's order", () => {
  const zones = resolve([
    { id: "z1", member: "gone", panels: [1], order: OWN },
    { id: "z2", member: null, panels: [2] },
  ]);
  assert.deepEqual(zones, [
    { id: "wall", member: "sam", following: ["sam"], panels: PANELS, order: ORDER, position: 0 },
  ]);
});

test("the same member stored twice: the first zone stands; so does the first of a repeated id", () => {
  const zones = resolve([
    { id: "wall", member: "jo", panels: [1] },
    { id: "z1", member: "jo", panels: [2, 3] },
    { id: "z2", member: "riley", panels: [4] },
    { id: "z2", member: "sam", panels: [5] },
  ]);
  assert.deepEqual(shape(zones), [
    ["wall", "jo", [1, 2, 3, 5, 6]],
    ["z2", "riley", [4]],
  ]);
});

test("a panel listed twice belongs to the first zone that stands, even past a dropped zone that listed it", () => {
  const zones = resolve([
    { id: "wall", member: "sam", panels: [] },
    { id: "z1", member: "gone", panels: [3] },
    { id: "z2", member: "jo", panels: [2, 3] },
    { id: "z3", member: "riley", panels: [3, 2, 4] },
  ]);
  assert.deepEqual(shape(zones), [
    ["wall", "sam", [1, 5, 6]],
    ["z2", "jo", [2, 3]],
    ["z3", "riley", [4]],
  ]);
});

test("a panel listed nowhere belongs to the first zone; ids not on the wall are ignored; panels ascend", () => {
  const zones = resolve(
    [
      { id: "wall", member: "sam", panels: [6, 99] },
      { id: "z1", member: "jo", panels: [5, 1, 77] },
    ],
    MEMBERS,
    [5, 3, 1, 6, 3],
  );
  assert.deepEqual(shape(zones), [
    ["wall", "sam", [3, 6]],
    ["z1", "jo", [1, 5]],
  ]);
});

test("a zone with no panels is kept; a zone without an order takes the wall's", () => {
  const zones = resolve([
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: [], order: OWN },
  ]);
  assert.deepEqual(shape(zones), [
    ["wall", "sam", PANELS],
    ["z1", "jo", []],
  ]);
  assert.deepEqual(zones.map((z) => z.order), [ORDER, OWN]);
});

test("an empty roster: one zone following nobody, with the first stored zone's id and order", () => {
  assert.deepEqual(resolve([{ id: "wall", member: "sam" }], []), [
    { id: "wall", member: null, following: [], panels: PANELS, order: ORDER, position: 0 },
  ]);
  const split = resolve(
    [
      { id: "z4", member: "sam", panels: [1], order: OWN },
      { id: "z1", member: "jo", panels: [2] },
    ],
    [],
  );
  assert.deepEqual(split, [{ id: "z4", member: null, following: [], panels: PANELS, order: OWN, position: 0 }]);
  assert.deepEqual(shape(resolve([], [])), [["wall", null, PANELS]]);
});

test("no layout yet: zones stand with no panels", () => {
  assert.deepEqual(shape(resolve([{ id: "wall", member: "sam" }, { id: "z1", member: "jo", panels: [1] }], MEMBERS, [])), [
    ["wall", "sam", []],
    ["z1", "jo", []],
  ]);
});

/* ---- Where a panel is ---- */

test("zoneOfPanel and isSplit", () => {
  const zones = resolve([
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: [2, 3] },
    { id: "z2", member: "riley", panels: [] },
  ]);
  assert.equal(zoneOfPanel(zones, 3).id, "z1");
  assert.equal(zoneOfPanel(zones, 1).id, "wall");
  assert.equal(zoneOfPanel(zones, 42), null);
  assert.equal(isSplit(zones), true);
  // A second zone with no panels yet doesn't split the wall.
  assert.equal(isSplit(resolve([{ id: "wall", member: "sam" }, { id: "z1", member: "jo", panels: [] }])), false);
  assert.equal(isSplit(resolve([{ id: "wall", member: "sam" }])), false);
});

/* ---- Fills and the wall's order ---- */

test("one zone fills exactly as the wall did: the same order and spans, at every rotation", () => {
  const layout = layoutOf("theduck");
  for (const rotation of [0, 90, 210]) {
    const placed = placeLayout(layout, rotation).panels;
    for (const order of [DEFAULT_ORDER, ORDER, OWN]) {
      const zones = resolveZones([{ id: "wall", member: "sam" }], placed.map((p) => p.id), MEMBERS, order);
      const [fill] = zoneFills(zones, placed);
      const today = resolveOrder(order, placed);
      assert.deepEqual(fill, { id: "wall", order: today, spans: fillSpans(order, placed, today), offset: 0 });
      assert.deepEqual(combinedOrder([fill]), today);
    }
  }
});

test("each zone resolves its order over its own panels; the wall's order is one zone after another", () => {
  const placed = placeLayout(layoutOf("theduck"), 0).panels;
  const ids = placed.map((p) => p.id);
  const mine = ids.slice(0, 4);
  const zones = resolveZones(
    [
      { id: "wall", member: "sam" },
      { id: "z1", member: "jo", panels: mine, order: DEFAULT_ORDER },
      { id: "z2", member: "riley", panels: [] },
    ],
    ids,
    MEMBERS,
    ORDER,
  );
  const fills = zoneFills(zones, placed);
  const rest = placed.filter((p) => !mine.includes(p.id));
  const first = resolveOrder(ORDER, rest);
  const own = placed.filter((p) => mine.includes(p.id));
  const second = resolveOrder(DEFAULT_ORDER, own);
  assert.deepEqual(fills, [
    { id: "wall", order: first, spans: fillSpans(ORDER, rest, first), offset: 0 },
    { id: "z1", order: second, spans: fillSpans(DEFAULT_ORDER, own, second), offset: first.length },
    { id: "z2", order: [], spans: fillSpans(ORDER, [], []), offset: ids.length },
  ]);
  assert.ok(fills[1].spans, "a line sweep over the zone's own extent");
  // A line covers the goal from 0 to 1 over the zone alone.
  const end = Math.max(...fills[1].spans.map((s) => s.start + s.span));
  assert.ok(Math.abs(end - 1) < 1e-9);
  assert.deepEqual(combinedOrder(fills), [...first, ...second]);
  assert.deepEqual([...combinedOrder(fills)].sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
});

/* ---- Tags ---- */

test("tag colours are distinct, picked by stored position, and repeat only past the palette", () => {
  const keys = new Set(ZONE_TAGS.map((rgb) => rgb.join(",")));
  assert.equal(keys.size, ZONE_TAGS.length);
  assert.ok(ZONE_TAGS.length >= 6);
  assert.equal(zoneTag(0), ZONE_TAGS[0]);
  assert.equal(zoneTag(2), ZONE_TAGS[2]);
  assert.equal(zoneTag(ZONE_TAGS.length), ZONE_TAGS[0]);
  // A dropped zone leaves the others' colours where they were.
  const zones = resolve([
    { id: "wall", member: "gone" },
    { id: "z1", member: "jo", panels: [1] },
    { id: "z2", member: "riley", panels: [2] },
  ]);
  assert.deepEqual(zones.map((z) => zoneTag(z.position)), [ZONE_TAGS[1], ZONE_TAGS[2]]);
});

test("the zone-editing preview lights every panel in its zone's tag colour", () => {
  const zones = resolve([
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: [2, 3] },
    { id: "z2", member: "riley", panels: [] },
  ]);
  const lights = zoneTagLights(zones);
  assert.deepEqual([...lights.keys()].sort(), PANELS);
  for (const id of [1, 4, 5, 6]) assert.deepEqual(lights.get(id), { rgb: ZONE_TAGS[0], level: ZONE_TAG_LEVEL });
  for (const id of [2, 3]) assert.deepEqual(lights.get(id), { rgb: ZONE_TAGS[1], level: ZONE_TAG_LEVEL });
});

/* ---- Touch ---- */

test("an unsplit wall: every touch acts in its one zone, placed or not, as before zones", () => {
  const zones = resolve([{ id: "wall", member: "sam" }]);
  for (const panel of [1, 6, 42, null, -1]) assert.equal(touchZone(zones, panel), zones[0]);
  // With a second zone that has no panels yet, the wall isn't split.
  const added = resolve([{ id: "wall", member: "sam" }, { id: "z1", member: "jo", panels: [] }]);
  for (const panel of [3, null]) assert.equal(touchZone(added, panel), added[0]);
  // No layout yet: the first zone.
  const bare = resolve([{ id: "wall", member: "sam" }, { id: "z1", member: "jo" }], MEMBERS, []);
  assert.equal(touchZone(bare, null), bare[0]);
});

test("a split wall: a touch acts in its panel's zone; one nothing places, or off the wall, acts nowhere", () => {
  const zones = resolve([
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: [2, 3] },
  ]);
  assert.equal(touchZone(zones, 2).id, "z1");
  assert.equal(touchZone(zones, 5).id, "wall");
  assert.equal(touchZone(zones, null), null, "a swipe the stream didn't place does nothing");
  assert.equal(touchZone(zones, 42), null);
  assert.equal(touchZone([], null), null);
});

/* ---- Scenes per zone ---- */

const NOW = new Date(2026, 8, 30, 10, 0);
const activity = (id, extra = {}) => ({
  id,
  name: id,
  trackingType: "span",
  color: "#7c3aed",
  iconPath: null,
  archived: false,
  goal: null,
  period: "day",
  pinned: false,
  placedBy: null,
  progress: { type: "duration", seconds: 0 },
  ...extra,
});
const live = (id, activityId, start, members) => ({
  id,
  activityId,
  type: "span",
  status: "live",
  memberIds: members,
  currentMemberIds: members,
  startedAt: start,
  endedAt: null,
});
const ACTIVITIES = [
  activity("read", { color: "#ff0000" }),
  activity("run", { color: "#00ff00" }),
  activity("pin", { pinned: true, color: "#0000ff" }),
];
const SESSIONS = [
  live("s-jo", "read", new Date(2026, 8, 30, 9, 0), ["jo"]),
  live("s-riley", "run", new Date(2026, 8, 30, 9, 30), ["riley"]),
];
const ZONES = resolve([
  { id: "wall", member: "sam" },
  { id: "z1", member: "jo", panels: [2] },
  { id: "z2", member: "riley", panels: [3] },
]);
const INPUT = { activities: ACTIVITIES, sessions: SESSIONS, settings: DEFAULT_SETTINGS, now: NOW };

test("each zone shows its member's newest running session, else the workspace's pin", () => {
  const scenes = decideZoneScenes(INPUT, ZONES);
  assert.deepEqual(scenes.map((z) => [z.id, z.scene.key]), [
    ["wall", "pinned:pin"],
    ["z1", "live:s-jo"],
    ["z2", "live:s-riley"],
  ]);
  ZONES.forEach((zone, i) => {
    assert.deepEqual(scenes[i].scene, decideScene({ ...INPUT, following: zone.following }));
  });
  // A shared session lights both members' zones.
  const shared = [live("s-both", "run", new Date(2026, 8, 30, 9, 45), ["jo", "riley"])];
  const both = decideZoneScenes({ ...INPUT, sessions: shared }, ZONES);
  assert.deepEqual(both.map((z) => z.scene.key), ["pinned:pin", "live:s-both", "live:s-both"]);
  // With no pin, a zone with nothing running is off.
  const unpinned = decideZoneScenes({ ...INPUT, activities: ACTIVITIES.slice(0, 2) }, ZONES);
  assert.equal(unpinned[0].scene, OFF_SCENE);
  // An empty roster follows nobody: no session shows, only the pin.
  const [nobody] = decideZoneScenes(INPUT, resolve([], []));
  assert.equal(nobody.scene.key, "pinned:pin");
});

test("another plugin holding the wall gives every zone the one control scene; switched off, every zone is off", () => {
  const effect = { id: "fx", type: "pulse", colors: [[255, 0, 0]], periodMs: 2000, color: null, startedAt: 0 };
  const control = { holder: "magic-cube", leaseId: "l1", effect };
  const scenes = decideZoneScenes({ ...INPUT, control }, ZONES);
  assert.ok(scenes.every((z) => z.scene === scenes[0].scene && z.scene.kind === "control"));
  assert.deepEqual(scenes[0].scene, decideScene({ ...INPUT, following: [], control }));
  const refused = decideZoneScenes({ ...INPUT, control, settings: { ...DEFAULT_SETTINGS, allowControl: false } }, ZONES);
  assert.equal(refused[1].scene.key, "live:s-jo");
  const off = decideZoneScenes({ ...INPUT, control, settings: { ...DEFAULT_SETTINGS, enabled: false } }, ZONES);
  assert.ok(off.every((z) => z.scene === OFF_SCENE));
});

test("the wall's scene key joins every zone's, and is the zone's own with one zone", () => {
  const scenes = decideZoneScenes(INPUT, ZONES);
  assert.equal(wallSceneKey(scenes), "pinned:pin|live:s-jo|live:s-riley");
  const [one] = decideZoneScenes(INPUT, resolve([{ id: "wall", member: "jo" }]));
  assert.equal(wallSceneKey([one]), "live:s-jo");
  // A change in any zone changes it.
  const later = decideZoneScenes({ ...INPUT, sessions: SESSIONS.slice(0, 1) }, ZONES);
  assert.notEqual(wallSceneKey(later), wallSceneKey(scenes));
});

test("output speaks for the zone showing the newest running session, else the pin", () => {
  const scenes = decideZoneScenes(INPUT, ZONES);
  assert.equal(outputScene(scenes, SESSIONS).key, "live:s-riley");
  const earlier = decideZoneScenes({ ...INPUT, sessions: SESSIONS.slice(0, 1) }, ZONES);
  assert.equal(outputScene(earlier, SESSIONS).key, "live:s-jo");
  const none = decideZoneScenes({ ...INPUT, sessions: [] }, ZONES);
  assert.equal(outputScene(none, []).key, "pinned:pin");
  const off = decideZoneScenes({ ...INPUT, sessions: [], activities: [] }, ZONES);
  assert.equal(outputScene(off, []), OFF_SCENE);
  assert.equal(outputScene([], []), OFF_SCENE);
  // One zone: its own scene.
  const [one] = decideZoneScenes(INPUT, resolve([{ id: "wall", member: "jo" }]));
  assert.equal(outputScene([one], SESSIONS), one.scene);
});

test("in a zone, a gesture and a schedule are its member's", () => {
  const [wall, jo] = ZONES;
  const pause = { kind: "pause-resume" };
  assert.deepEqual(resolveGesture(pause, ACTIVITIES, SESSIONS, jo.following), {
    kind: "pause",
    sessionId: "s-jo",
    activityId: "read",
    placedBy: "jo",
  });
  assert.deepEqual(resolveGesture(pause, ACTIVITIES, SESSIONS, wall.following), {
    kind: "track",
    activityId: "pin",
    members: ["sam"],
  });
  assert.equal(speaksTo(["jo"], jo.following), true);
  assert.equal(speaksTo(["jo"], wall.following), false);
});

test("drawnZones: the zones with panels, or every zone while none has any", () => {
  const a = { id: "wall", panels: [1, 2] };
  const empty = { id: "z1", panels: [] };
  const c = { id: "z2", panels: [3] };
  assert.deepEqual(drawnZones([a, empty, c]), [a, c]);
  assert.deepEqual(drawnZones([empty, a]), [a], "a zone with no panels never decides the wall, first or not");
  const none = [empty, { id: "z2", panels: [] }];
  assert.equal(drawnZones(none), none, "before the layout is known every zone counts");
  assert.deepEqual(drawnZones([]), []);
});
