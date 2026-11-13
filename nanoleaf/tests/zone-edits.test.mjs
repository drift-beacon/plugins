import assert from "node:assert/strict";
import { test } from "node:test";
import { mulberry32 } from "../shared/order.ts";
import {
  addZone,
  DEFAULT_ORDER,
  freeMembers,
  giveZone,
  movePanels,
  nextZoneId,
  readZones,
  removeZone,
  setZoneOrder,
  WALL_ZONE_ID,
  ZONE_REFUSALS,
  zonesFollowing,
} from "../shared/storage.ts";
import { resolveZones } from "../shared/zones.ts";

const OWNER = { id: "sam", name: "Sam", role: "OWNER" };
const JO = { id: "jo", name: "Jo", role: "MEMBER" };
const RILEY = { id: "riley", name: "Riley", role: "MEMBER" };
const MEMBERS = [OWNER, JO, RILEY];
const PANELS = [1, 2, 3, 4, 5, 6];
const ORDER = { mode: "auto", auto: "left-right", ids: [3, 1], seed: 7, sweepFill: "panels" };

const ok = (edit) => {
  assert.equal(edit.ok, true, edit.ok ? "" : edit.reason);
  return edit.zones;
};
const refused = (edit, refusal) => {
  assert.equal(edit.ok, false, "refused");
  assert.equal(edit.refusal, refusal);
  assert.equal(edit.reason, ZONE_REFUSALS[refusal]);
};
/** Who has which panels once resolved, as `{ zoneId: [member, panel ids] }`. */
const split = (zones, members = MEMBERS) =>
  Object.fromEntries(resolveZones(zones, PANELS, members, DEFAULT_ORDER).map((z) => [z.id, [z.member, z.panels]]));
/** Through storage and back, as the screens would write it. */
const stored = (zones) => readZones(JSON.parse(JSON.stringify(zones)));

/* ---- Reading ---- */

test("readZones keeps a zone's panels (valid ids, first copy) and order; a missing or bad one leaves the key out", () => {
  assert.deepEqual(readZones([{ id: "wall", member: "sam", panels: [3, 1, 3, -1, 2.5, "4", 0], order: ORDER }]), [
    { id: "wall", member: "sam", panels: [3, 1, 0], order: ORDER },
  ]);
  const [zone] = readZones([{ id: "wall", member: "sam", panels: "1,2", order: "auto" }]);
  assert.deepEqual(zone, { id: "wall", member: "sam" });
  assert.equal("panels" in zone || "order" in zone, false, "no undefined keys");
  assert.deepEqual(readZones([{ id: "z1", member: null, panels: [] }]), [{ id: "z1", member: null, panels: [] }]);
  // An order object is read field by field, as storage `order` is.
  assert.deepEqual(readZones([{ id: "z1", member: null, order: { mode: "nope" } }])[0].order, DEFAULT_ORDER);
});

test("readZones: a later entry without an id, or repeating one, is left out", () => {
  assert.deepEqual(
    readZones([{ member: "sam" }, { member: "jo" }, { id: "wall", member: "riley" }, { id: "z1", member: "jo" }]),
    [
      { id: WALL_ZONE_ID, member: "sam" },
      { id: "z1", member: "jo" },
    ],
  );
});

/* ---- The picker ---- */

test("the picker without the roster: at most one stored entry as before zones; a split list comes back unchanged", () => {
  assert.deepEqual(zonesFollowing(undefined, "jo"), [{ id: WALL_ZONE_ID, member: "jo" }]);
  assert.deepEqual(zonesFollowing([{ id: "z1", member: "sam", order: ORDER }], "jo"), [
    { id: "z1", member: "jo", order: ORDER },
  ]);
  const splitList = [
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: [2] },
  ];
  assert.deepEqual(zonesFollowing(splitList, "jo"), splitList, "never two zones for Jo");
  assert.deepEqual(zonesFollowing(splitList, "riley"), splitList);
});

test("the picker with the roster gives the one standing zone, keeping its id, panels and order", () => {
  assert.deepEqual(ok(zonesFollowing(undefined, "jo", MEMBERS)), [{ id: WALL_ZONE_ID, member: "jo" }]);
  assert.deepEqual(ok(zonesFollowing([{ id: "wall", member: "gone", order: ORDER }], "jo", MEMBERS)), [
    { id: "wall", member: "jo", order: ORDER },
  ]);
  // Nobody stored: the wall follows the owner, so picking the owner stores them.
  assert.deepEqual(ok(zonesFollowing([{ id: "wall", member: null }], "sam", MEMBERS)), [{ id: "wall", member: "sam" }]);
  refused(zonesFollowing([{ id: "wall", member: "sam" }], "sam", MEMBERS), "no-change");
  refused(zonesFollowing([], "gone", MEMBERS), "not-a-member");
  refused(zonesFollowing([], "sam", []), "no-roster");
  // Two zones whose members left beside one that stands: one zone stands, and the stale ones go.
  assert.deepEqual(
    ok(zonesFollowing([{ id: "z1", member: "gone", panels: [1] }, { id: "z2", member: "riley", panels: [2] }], "jo", MEMBERS)),
    [{ id: "z2", member: "jo", panels: [2] }],
  );
});

test("the picker on a split wall refuses: the zone screens give zones", () => {
  const zones = [
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: [2] },
  ];
  refused(zonesFollowing(zones, "riley", MEMBERS), "split-wall");
  refused(zonesFollowing(zones, "jo", MEMBERS), "split-wall");
});

/* ---- Adding ---- */

test("nextZoneId is the lowest z<n> no zone uses", () => {
  assert.equal(nextZoneId([]), "z1");
  assert.equal(nextZoneId([{ id: "wall", member: null }]), "z1");
  assert.equal(nextZoneId([{ id: "z1", member: null }, { id: "z3", member: null }]), "z2");
});

test("splitting today's one-zone wall: the first zone is stored with who it acts for and keeps every panel", () => {
  for (const before of [undefined, [], [{ id: "wall", member: null }], [{ id: "wall", member: "gone" }]]) {
    const zones = ok(addZone(readZones(before), "jo", MEMBERS));
    assert.deepEqual(zones, [
      { id: "wall", member: "sam" },
      { id: "z1", member: "jo", panels: [] },
    ], `from ${JSON.stringify(before)}`);
    assert.deepEqual(split(stored(zones)), { wall: ["sam", PANELS], z1: ["jo", []] });
  }
  const zones = ok(addZone([{ id: "wall", member: "riley", order: ORDER }], "jo", MEMBERS));
  assert.deepEqual(zones, [
    { id: "wall", member: "riley", order: ORDER },
    { id: "z1", member: "jo", panels: [] },
  ]);
});

test("adding refuses someone outside the workspace, someone with a zone, anyone once everyone has one, and no roster", () => {
  refused(addZone([], "gone", MEMBERS), "not-a-member");
  refused(addZone([], "sam", MEMBERS), "has-zone");
  refused(addZone([{ id: "wall", member: "gone" }], "sam", MEMBERS), "has-zone");
  const two = ok(addZone([{ id: "wall", member: "sam" }], "jo", MEMBERS));
  refused(addZone(two, "jo", MEMBERS), "has-zone");
  const three = ok(addZone(two, "riley", MEMBERS));
  assert.deepEqual(three.map((z) => z.id), ["wall", "z1", "z2"]);
  refused(addZone(three, "riley", MEMBERS), "everyone-has-zone");
  refused(addZone([], "sam", [OWNER]), "everyone-has-zone");
  refused(addZone([], "sam", []), "no-roster");
});

test("freeMembers: who has no standing zone, in the roster's order", () => {
  assert.deepEqual(freeMembers([], MEMBERS), [JO, RILEY]);
  assert.deepEqual(freeMembers([{ id: "wall", member: "jo" }], MEMBERS), [OWNER, RILEY]);
  assert.deepEqual(freeMembers([{ id: "wall", member: "jo" }, { id: "z1", member: "gone" }], MEMBERS), [OWNER, RILEY]);
  assert.deepEqual(freeMembers([{ id: "wall", member: "jo" }, { id: "z1", member: "sam" }], MEMBERS), [RILEY]);
  assert.deepEqual(freeMembers([{ id: "a", member: "gone" }, { id: "b", member: "gone2" }], MEMBERS), [JO, RILEY]);
  assert.deepEqual(freeMembers([], []), []);
});

/* ---- Every edit writes only the zones that stand ---- */

test("edits drop what doesn't stand: zones whose member left, a second zone for a member, a repeated id", () => {
  const messy = [
    { id: "wall", member: "sam" },
    { id: "z1", member: "gone", panels: [3] },
    { id: "z2", member: "sam", panels: [4] },
    { id: "wall", member: "jo" },
    { id: "z3", member: "jo", panels: [5] },
  ];
  assert.deepEqual(ok(addZone(messy, "riley", MEMBERS)), [
    { id: "wall", member: "sam" },
    { id: "z3", member: "jo", panels: [5] },
    { id: "z1", member: "riley", panels: [] },
  ]);
});

test("two or more stored zones of which none stands: every edit acts on the made-up \"wall\" zone and stores it", () => {
  const stale = [
    { id: "a", member: "gone", panels: [1, 2], order: ORDER },
    { id: "b", member: "gone2", panels: [3] },
  ];
  assert.deepEqual(split(stale), { wall: ["sam", PANELS] });
  refused(addZone(stale, "sam", MEMBERS), "has-zone");
  assert.deepEqual(ok(addZone(stale, "jo", MEMBERS)), [
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: [] },
  ]);
  assert.deepEqual(ok(giveZone(stale, "wall", "riley", MEMBERS)), [{ id: "wall", member: "riley" }]);
  refused(giveZone(stale, "a", "riley", MEMBERS), "no-zone");
  assert.deepEqual(ok(setZoneOrder(stale, "wall", ORDER, MEMBERS)), [{ id: "wall", member: "sam", order: ORDER }]);
  assert.deepEqual(ok(movePanels(stale, "wall", [2], MEMBERS)), [{ id: "wall", member: "sam", panels: [2] }]);
  refused(removeZone(stale, "wall", MEMBERS), "last-zone");
  assert.deepEqual(ok(zonesFollowing(stale, "jo", MEMBERS)), [{ id: "wall", member: "jo" }]);
});

test("with an empty roster every edit refuses: there is nobody to give a zone to", () => {
  const zones = [
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: [2] },
  ];
  assert.deepEqual(split(zones, []), { wall: [null, PANELS] });
  refused(addZone(zones, "riley", []), "no-roster");
  refused(removeZone(zones, "z1", []), "no-roster");
  refused(giveZone(zones, "z1", "riley", []), "no-roster");
  refused(movePanels(zones, "z1", [3], []), "no-roster");
  refused(setZoneOrder(zones, "z1", ORDER, []), "no-roster");
  refused(zonesFollowing(zones, "riley", []), "no-roster");
});

/* ---- Removing ---- */

test("removing a zone gives its panels to the first zone that remains; never the last standing zone", () => {
  const zones = [
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: [2, 3] },
    { id: "z2", member: "riley", panels: [4] },
  ];
  const without = ok(removeZone(zones, "z1", MEMBERS));
  assert.deepEqual(without, [zones[0], zones[2]]);
  assert.deepEqual(split(without), { wall: ["sam", [1, 2, 3, 5, 6]], z2: ["riley", [4]] });
  assert.deepEqual(split(ok(removeZone(zones, "wall", MEMBERS))), { z1: ["jo", [1, 2, 3, 5, 6]], z2: ["riley", [4]] });
  refused(removeZone([{ id: "wall", member: "sam" }], "wall", MEMBERS), "last-zone");
  refused(removeZone(zones, "z9", MEMBERS), "no-zone");
  refused(removeZone([], "wall", MEMBERS), "last-zone");
  // A zone whose member left beside the one that stands: removing the standing one would hand the wall to a zone
  // nobody sees, so it is refused.
  const stale = [
    { id: "wall", member: "sam" },
    { id: "z1", member: "gone", panels: [3] },
  ];
  refused(removeZone(stale, "wall", MEMBERS), "last-zone");
  refused(removeZone(stale, "z1", MEMBERS), "no-zone");
});

test("removing a zone can give its panels to a zone named for them", () => {
  const zones = [
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: [2, 3] },
    { id: "z2", member: "riley", panels: [4] },
  ];
  const to = (id) => ({ to: id, panelIds: PANELS });
  assert.deepEqual(split(ok(removeZone(zones, "z1", MEMBERS, to("z2")))), { wall: ["sam", [1, 5, 6]], z2: ["riley", [2, 3, 4]] });
  // The first zone holds every panel nobody lists: they all go to the zone named.
  assert.deepEqual(split(ok(removeZone(zones, "wall", MEMBERS, to("z2")))), { z1: ["jo", [2, 3]], z2: ["riley", [1, 4, 5, 6]] });
  // A panel the removed zone lists but an earlier zone holds stays where it is.
  const shared = [
    { id: "wall", member: "sam", panels: [1] },
    { id: "z1", member: "jo", panels: [1, 2] },
    { id: "z2", member: "riley", panels: [] },
  ];
  assert.deepEqual(split(ok(removeZone(shared, "z1", MEMBERS, to("z2")))), { wall: ["sam", [1, 3, 4, 5, 6]], z2: ["riley", [2]] });
  refused(removeZone(zones, "z1", MEMBERS, to("z1")), "no-zone");
  refused(removeZone(zones, "z1", MEMBERS, to("z9")), "no-zone");
});

/* ---- Giving ---- */

test("giving a zone to someone with none keeps its panels and order", () => {
  const zones = [
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: [2], order: ORDER },
  ];
  assert.deepEqual(ok(giveZone(zones, "z1", "riley", MEMBERS)), [
    { id: "wall", member: "sam" },
    { id: "z1", member: "riley", panels: [2], order: ORDER },
  ]);
  refused(giveZone(zones, "z1", "sam", MEMBERS), "has-zone");
  refused(giveZone(zones, "z1", "jo", MEMBERS), "has-zone");
  refused(giveZone(zones, "z1", "gone", MEMBERS), "not-a-member");
  refused(giveZone(zones, "z9", "riley", MEMBERS), "no-zone");
  assert.deepEqual(ok(giveZone([{ id: "wall", member: null }], "wall", "jo", MEMBERS)), [{ id: "wall", member: "jo" }]);
});

/* ---- Moving panels ---- */

test("moving panels lists them in the zone and takes them off every other list", () => {
  let zones = ok(addZone([], "jo", MEMBERS));
  zones = ok(addZone(zones, "riley", MEMBERS));
  zones = ok(movePanels(zones, "z1", [2, 3], MEMBERS));
  assert.deepEqual(zones, [
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: [2, 3] },
    { id: "z2", member: "riley", panels: [] },
  ]);
  assert.deepEqual(split(stored(zones)), { wall: ["sam", [1, 4, 5, 6]], z1: ["jo", [2, 3]], z2: ["riley", []] });
  zones = ok(movePanels(zones, "z2", [4, 3, 4, -1], MEMBERS));
  assert.deepEqual(zones.map((z) => z.panels), [undefined, [2], [4, 3]]);
  zones = ok(movePanels(zones, "wall", [2], MEMBERS));
  assert.deepEqual(zones.map((z) => z.panels), [[2], [], [4, 3]]);
  assert.deepEqual(split(stored(zones)), { wall: ["sam", [1, 2, 5, 6]], z1: ["jo", []], z2: ["riley", [3, 4]] });
  refused(movePanels(zones, "z9", [1], MEMBERS), "no-zone");
  refused(movePanels(zones, "z2", [3], MEMBERS), "no-change");
  refused(movePanels(zones, "z2", [], MEMBERS), "no-change");
});

test("a zone that loses nothing keeps its own object", () => {
  const zones = [
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: [2] },
    { id: "z2", member: "riley", panels: [5] },
  ];
  const moved = ok(movePanels(zones, "z1", [3], MEMBERS));
  assert.equal(moved[0], zones[0]);
  assert.equal(moved[2], zones[2]);
});

/* ---- Order ---- */

test("setting a zone's order stores it on that zone; null takes it away", () => {
  const zones = [
    { id: "wall", member: "sam" },
    { id: "z1", member: "jo", panels: [2] },
  ];
  const ordered = ok(setZoneOrder(zones, "z1", ORDER, MEMBERS));
  assert.deepEqual(ordered, [zones[0], { id: "z1", member: "jo", panels: [2], order: ORDER }]);
  const [, zone] = resolveZones(stored(ordered), PANELS, MEMBERS, DEFAULT_ORDER);
  assert.deepEqual(zone.order, ORDER);
  const cleared = ok(setZoneOrder(ordered, "z1", null, MEMBERS));
  assert.deepEqual(cleared, zones);
  assert.equal("order" in cleared[1], false);
  refused(setZoneOrder(zones, "z9", ORDER, MEMBERS), "no-zone");
  refused(setZoneOrder(ordered, "z1", ORDER, MEMBERS), "no-change");
  refused(setZoneOrder(zones, "z1", null, MEMBERS), "no-change");
});

/* ---- Any sequence of edits ---- */

test("seeded runs of edits and roster changes keep the wall whole and each edit reads back as made", () => {
  const POOL = [OWNER, JO, RILEY, { id: "alex", name: "Alex", role: "MEMBER" }];
  const WALL = [1, 2, 3, 4, 5, 6, 7, 8];
  const OWN = { mode: "random", auto: "path", ids: [], seed: 5, sweepFill: "line" };
  let successes = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const random = mulberry32(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    let members = [...POOL];
    let zones = [];
    const resolve = (list) => resolveZones(list, WALL, members, ORDER);
    const check = (label) => {
      const shown = resolve(zones);
      assert.ok(shown.length >= 1, `${label}: a zone stands`);
      assert.ok(shown.length <= Math.max(1, members.length), `${label}: no more zones than members`);
      const people = shown.map((z) => z.member).filter((m) => m !== null);
      assert.equal(new Set(people).size, people.length, `${label}: nobody has two zones`);
      const all = shown.flatMap((z) => z.panels).sort((a, b) => a - b);
      assert.deepEqual(all, WALL, `${label}: every panel in exactly one zone`);
      return shown;
    };
    for (let step = 0; step < 40; step++) {
      const label = `seed ${seed}, step ${step}`;
      const before = check(label);
      const x = random();
      if (x < 0.15) {
        // Someone leaves or comes back; the owner stays (and, rarely, the app sends no roster at all).
        const other = pick(POOL.slice(1));
        if (members.length === 0) members = [OWNER];
        members = members.includes(other) ? members.filter((m) => m !== other) : POOL.filter((m) => m === other || members.includes(m));
        if (random() < 0.1) members = [];
        check(`${label}, roster`);
        continue;
      }
      const ids = [...before.map((z) => z.id), "z9"];
      const member = pick([...POOL.map((m) => m.id), "gone"]);
      const id = pick(ids);
      const kind = pick(["add", "remove", "give", "move", "order", "follow"]);
      let edit;
      let to = null;
      let moving = null;
      let order = null;
      if (kind === "add") edit = addZone(zones, member, members);
      else if (kind === "remove") {
        to = random() < 0.5 ? pick(ids) : null;
        edit = removeZone(zones, id, members, to ? { to, panelIds: WALL } : undefined);
      } else if (kind === "give") edit = giveZone(zones, id, member, members);
      else if (kind === "move") {
        moving = [...WALL, 99].filter(() => random() < 0.3);
        edit = movePanels(zones, id, moving, members);
      } else if (kind === "order") {
        order = pick([OWN, null]);
        edit = setZoneOrder(zones, id, order, members);
      } else edit = zonesFollowing(zones, member, members);
      if (!edit.ok) {
        assert.equal(edit.reason, ZONE_REFUSALS[edit.refusal]);
        if (members.length === 0) assert.equal(edit.refusal, "no-roster", label);
        continue;
      }
      successes++;
      assert.notEqual(JSON.stringify(edit.zones), JSON.stringify(zones), `${label}: ${kind} changed something`);
      const next = readZones(JSON.parse(JSON.stringify(edit.zones)));
      zones = next;
      const after = check(`${label}, ${kind}`);
      // What was written is exactly what stands.
      assert.deepEqual(after.map((z) => [z.id, z.member]), next.map((z) => [z.id, z.member]), `${label}: ${kind} writes what stands`);
      const zone = (zid) => after.find((z) => z.id === zid);
      if (kind === "add") {
        assert.deepEqual(zone(next[next.length - 1].id).member, member);
        assert.deepEqual(zone(next[next.length - 1].id).panels, []);
        for (const z of before) assert.equal(zone(z.id)?.member, z.member, `${label}: add keeps ${z.id}`);
      } else if (kind === "remove") {
        assert.equal(zone(id), undefined);
        const held = before.find((z) => z.id === id).panels;
        const receiver = to ? zone(to) : after[0];
        for (const panel of held) assert.ok(receiver.panels.includes(panel), `${label}: panel ${panel} to ${receiver.id}`);
        for (const z of before) if (z.id !== id) assert.equal(zone(z.id)?.member, z.member);
      } else if (kind === "give") {
        assert.equal(zone(id).member, member);
      } else if (kind === "move") {
        for (const panel of moving) if (WALL.includes(panel)) assert.ok(zone(id).panels.includes(panel), `${label}: ${panel}`);
      } else if (kind === "order") {
        assert.deepEqual(zone(id).order, order ?? ORDER);
      } else {
        assert.deepEqual(after.map((z) => z.member), [member]);
      }
    }
  }
  assert.ok(successes > 1000, `enough edits succeeded (${successes})`);
});
