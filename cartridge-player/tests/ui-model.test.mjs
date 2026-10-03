// The shelf, the picker, and what the interface says about the player and main: the pure view layer the live model
// and the simulator both feed (ui/src/view). Storage goes through the shared readers, as in the live model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSetupCode } from "../shared/setup-code.ts";
import { readMappings, readPlayerRecord } from "../shared/storage.ts";
import { SAVE_REFUSED } from "../shared/ui-channel.ts";
import { stableReader, stableRows } from "../ui/src/lib/stable.ts";
import { contrast, inkOn, INK_DARK, INK_LIGHT, mixed, parseColor, shaded, sticker, STICKER_FADE, STICKER_SHADE, stickerPaint } from "../ui/src/view/color.ts";
import { recordedByMain, requestError } from "../ui/src/view/errors.ts";
import { clock, duration, durationPhrase, relative, since } from "../ui/src/view/format.ts";
import {
  buildLibrary,
  FORGET_CLEARS_SLOT,
  FORGET_HOLDER_ONLINE,
  forgetBlockedNote,
  forgetRefusal,
  forgetState,
  itemLabel,
  sameItem,
  sortLibrary,
  suggestions,
  trackingNote,
  unknownItems,
} from "../ui/src/view/library.ts";
import { canChange, mainNotice, mainStatusOf } from "../ui/src/view/main-status.ts";
import { pickerGroups } from "../ui/src/view/picker.ts";
import { everHeard, presenceView, readPresence } from "../ui/src/view/presence.ts";
import { guideSteps, heardMark, heardSince, hubDefaults, setupCodeFor, splitHost } from "../ui/src/view/setup.ts";
import { byId } from "../ui/src/view/types.ts";

const NOW = Date.parse("2026-10-03T10:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const A = "04:A2:3B:1C:7F:5D:80";
const B = "04:C4:58:2E:61:0B:80";
const C = "04:19:E6:52:33:71:80";
const D = "04:7B:0C:D1:9A:22:81";

const activity = (id, name, categoryId, extra = {}) => ({
  id,
  name,
  color: "#60a5fa",
  iconPath: null,
  categoryId,
  categoryName: categoryId ? categoryId[0].toUpperCase() + categoryId.slice(1) : null,
  archived: false,
  point: false,
  ...extra,
});
const ACTIVITIES = [
  activity("deep", "Deep work", "work"),
  activity("cafe", "Café time", "home"),
  activity("gym", "Gym", "health"),
  activity("old", "Old hobby", "health", { archived: true }),
  activity("tax", "Tax return", null),
];
const CATEGORIES = [
  { id: "work", name: "Work", color: "#60a5fa", iconPath: null },
  { id: "health", name: "Health", color: "#34d399", iconPath: null },
  { id: "home", name: "Home", color: "#fb923c", iconPath: null },
];
const LOOKUP = byId(ACTIVITIES);

function record({ slot = null, cartridges = {}, unknown = [] } = {}) {
  return readPlayerRecord({
    v: 1,
    devices: { "cp-a1b2c3": { slot, lastHeardAt: iso(NOW - MIN), hubHost: "192.168.1.12:9001" } },
    active: "cp-a1b2c3",
    unknown,
    cartridges,
    history: [],
    nextId: 1,
  });
}

test("shelf: stats are per cartridge, so two cartridges on one activity keep their own numbers", () => {
  const mappings = readMappings({ [A]: "deep", [B]: "deep" });
  const cartridges = {
    [A]: { seenAt: iso(NOW - HOUR), plays: 12, playedMs: 5 * HOUR },
    [B]: { seenAt: null, plays: 0, playedMs: 0 },
  };
  const items = buildLibrary(mappings, record({ cartridges }), LOOKUP, []);
  const byTag = Object.fromEntries(items.map((item) => [item.tag, item]));
  assert.deepEqual([byTag[A].plays, byTag[A].playedMs, byTag[A].seenAt], [12, 5 * HOUR, NOW - HOUR]);
  assert.deepEqual([byTag[B].plays, byTag[B].seenAt], [0, null]);
});

test("shelf: the cartridge in the player is marked in it, and live only while its own session is", () => {
  const slot = { tag: A, since: iso(NOW - MIN), activityId: "deep", sessionId: "s1", outcome: "started", error: null };
  const items = buildLibrary(readMappings({ [A]: "deep", [B]: "gym" }), record({ slot }), LOOKUP, [{ id: "s1", activityId: "deep", startedAt: NOW }]);
  const [inSlot] = items.filter((item) => item.inSlot);
  assert.equal(inSlot.tag, A);
  assert.equal(inSlot.live, true);
  const ended = buildLibrary(readMappings({ [A]: "deep" }), record({ slot }), LOOKUP, [{ id: "s-other", activityId: "deep", startedAt: NOW }]);
  assert.equal(ended[0].live, false);
});

test("shelf: relabelled while playing, a cartridge says which activity is tracking, not that its new label is", () => {
  // Deep work is playing; the cartridge was relabelled Gym from its details. Main leaves the slot and its session.
  const slot = { tag: A, since: iso(NOW - MIN), activityId: "deep", sessionId: "s1", outcome: "started", error: null };
  const live = [{ id: "s1", activityId: "deep", startedAt: NOW - MIN }];
  const [item] = buildLibrary(readMappings({ [A]: "gym" }), record({ slot }), LOOKUP, live);
  assert.deepEqual([item.activity.name, item.live, item.tracking.name], ["Gym", true, "Deep work"]);
  assert.equal(itemLabel(item, null, "0m"), "Gym, in the player, tracking Deep work");
  assert.equal(trackingNote(item), "Deep work keeps tracking until you take it out; Gym starts next time it goes in.");
  // Not relabelled: the session is the label's own, and the note is about a relabel still to come.
  const [same] = buildLibrary(readMappings({ [A]: "deep" }), record({ slot }), LOOKUP, live);
  assert.equal(same.tracking, same.activity);
  assert.equal(itemLabel(same, null, "0m"), "Deep work, in the player, tracking");
  assert.match(trackingNote(same), /A new label applies next time it goes in; Deep work keeps tracking/);
  // Nothing tracking: no note, and the card redraws when what it tracks changes.
  const [idle] = buildLibrary(readMappings({ [A]: "gym" }), record({ slot }), LOOKUP, []);
  assert.deepEqual([idle.tracking, trackingNote(idle)], [null, null]);
  assert.ok(!sameItem(item, { ...item, tracking: LOOKUP.get("gym") }));
});

test("shelf: a cartridge whose activity was deleted stays on the shelf with no activity, so it can be relabelled", () => {
  const [item] = buildLibrary(readMappings({ [A]: "gone" }), record(), LOOKUP, []);
  assert.equal(item.activity, null);
  assert.match(itemLabel(item, null, "0m"), /deleted/);
});

test("shelf: Recent puts the cartridge in the player first, then the latest; never-played ones last", () => {
  const slot = { tag: C, since: iso(NOW - MIN), activityId: "tax", sessionId: null, outcome: "idle", error: null };
  const cartridges = {
    [A]: { seenAt: iso(NOW - 5 * HOUR), plays: 40, playedMs: 2 * HOUR },
    [B]: { seenAt: iso(NOW - HOUR), plays: 3, playedMs: 9 * HOUR },
    [C]: { seenAt: iso(NOW - 9 * HOUR), plays: 40, playedMs: 1 * HOUR },
    [D]: { seenAt: null, plays: 0, playedMs: 0 },
  };
  const items = buildLibrary(readMappings({ [A]: "deep", [B]: "gym", [C]: "tax", [D]: "gone" }), record({ slot, cartridges }), LOOKUP, []);
  assert.deepEqual(sortLibrary(items, "recent").map((i) => i.tag), [C, B, A, D]);
  // Most played orders by plays (the stat it names), then by time.
  assert.deepEqual(sortLibrary(items, "played").map((i) => i.tag), [A, C, B, D]);
  // A–Z by activity name, ignoring case; the one with no activity goes last.
  assert.deepEqual(sortLibrary(items, "name").map((i) => i.tag), [A, B, C, D]);
});

test("shelf: a card redraws only when what it shows changed, not on every rebuild", () => {
  const mappings = readMappings({ [A]: "deep" });
  const cartridges = { [A]: { seenAt: iso(NOW - HOUR), plays: 2, playedMs: HOUR } };
  const [first] = buildLibrary(mappings, record({ cartridges }), LOOKUP, []);
  const [again] = buildLibrary(mappings, record({ cartridges }), LOOKUP, []);
  assert.notEqual(first, again);
  assert.ok(sameItem(first, again));
  const [played] = buildLibrary(mappings, record({ cartridges: { [A]: { ...cartridges[A], plays: 3 } } }), LOOKUP, []);
  assert.ok(!sameItem(first, played));
});

test("shelf: 'seen, not labelled' leaves out the one on the stage and any labelled since", () => {
  const unknown = [A, B, C].map((tag, i) => ({ tag, firstSeenAt: iso(NOW - i * HOUR), lastSeenAt: iso(NOW - i * HOUR) }));
  const items = unknownItems(record({ unknown }), readMappings({ [C]: "gym" }), A);
  assert.deepEqual(items.map((i) => i.tag), [B]);
  assert.equal(items[0].lastSeenAt, NOW - HOUR);
});

test("shelf: one-tap labels are activities without a cartridge, never archived ones", () => {
  const offered = suggestions(ACTIVITIES, readMappings({ [A]: "deep" }));
  assert.deepEqual(offered.map((a) => a.id), ["cafe", "gym", "tax"]);
});

test("picker: grouped by category in the app's order, uncategorised last, archived left out", () => {
  const groups = pickerGroups(ACTIVITIES, CATEGORIES);
  assert.deepEqual(
    groups.map((g) => [g.category.name, g.activities.map((a) => a.id)]),
    [
      ["Work", ["deep"]],
      ["Health", ["gym"]],
      ["Home", ["cafe"]],
      ["Uncategorised", ["tax"]],
    ],
  );
});

test("picker: search matches name or category, ignores case and accents, and drops empty groups", () => {
  assert.deepEqual(pickerGroups(ACTIVITIES, CATEGORIES, "CAFE").flatMap((g) => g.activities.map((a) => a.id)), ["cafe"]);
  assert.deepEqual(pickerGroups(ACTIVITIES, CATEGORIES, "health").flatMap((g) => g.activities.map((a) => a.id)), ["gym"]);
  assert.deepEqual(pickerGroups(ACTIVITIES, CATEGORIES, "nothing like it"), []);
});

test("format: the clock ticks in whole seconds; tracked time is compact; short spans read as words", () => {
  assert.equal(clock(23 * MIN + 14_000), "00:23:14");
  assert.equal(clock(-5), "00:00:00");
  assert.equal(duration(45 * MIN), "45m");
  assert.equal(duration(3 * HOUR + 5 * MIN), "3h 05m");
  assert.equal(duration(52 * HOUR), "52h");
  assert.equal(durationPhrase(20_000), "Under a minute");
  assert.equal(durationPhrase(52 * MIN), "52m");
});

test("format: relative times never read as the future, even when the hub's clock is ahead", () => {
  assert.equal(relative(NOW + 5000, NOW, "en-GB"), "just now");
  assert.equal(relative(NOW - 4 * MIN, NOW, "en-GB"), "4 minutes ago");
  assert.equal(relative(NOW - 6 * HOUR, NOW, "en-GB"), "6 hours ago");
  assert.equal(relative(NOW - 26 * HOUR, NOW, "en-GB"), "yesterday");
  assert.equal(since(NOW - 6 * HOUR, NOW), "6h");
  assert.equal(since(NOW + MIN, NOW), "now");
});

test("presence: what the pill says for no player, online, offline, and main not running", () => {
  const device = readPlayerRecord({ v: 1, devices: { "cp-a1b2c3": { lastHeardAt: iso(NOW - 3 * HOUR) } } }).devices["cp-a1b2c3"];
  const presence = (extra) => readPresence({ online: true, lastHeardAt: iso(NOW - 3 * HOUR), reader: "ok", ...extra });
  assert.equal(presenceView(readPresence(undefined), null, NOW).label, "No player yet");
  assert.equal(presenceView(presence({}), device, NOW).label, "Player online");
  assert.equal(presenceView(presence({ reader: "fault" }), device, NOW).label, "Reader fault");
  const offline = presenceView(presence({ online: false }), device, NOW, "en-GB");
  assert.equal(offline.label, "Player offline");
  assert.match(offline.detail, /3 hours ago/);
  assert.equal(presenceView(null, device, NOW).health, "unknown");
  assert.equal(everHeard(readPlayerRecord(null)), false);
  assert.equal(everHeard(readPlayerRecord({ v: 1, devices: { "cp-a1b2c3": { lastHeardAt: iso(NOW) } } })), true);
});

test("presence: a player main hasn't heard yet since it started is waited for, not called offline", () => {
  const device = readPlayerRecord({ v: 1, devices: { "cp-a1b2c3": { lastHeardAt: iso(NOW - 3 * HOUR) } } }).devices["cp-a1b2c3"];
  const published = (extra) => readPresence({ online: null, lastHeardAt: iso(NOW - 3 * HOUR), reader: null, ...extra });
  const waiting = presenceView(published({}), device, NOW, "en-GB");
  assert.deepEqual([waiting.health, waiting.label], ["waiting", "Waiting for player"]);
  assert.match(waiting.detail, /^Last heard 3 hours ago\. The plugin has just started and is waiting to hear from the player again/);
  // It reads as neither verdict.
  assert.doesNotMatch(`${waiting.label} ${waiting.detail}`, /offline|online/i);
  // Main's verdict, once it has one, wins.
  assert.equal(presenceView(published({ online: false }), device, NOW).health, "offline");
});

test("setup: the guide starts from where a player reached the hub, else this page's host on 9001", () => {
  assert.deepEqual(splitHost("192.168.1.12:9001"), { host: "192.168.1.12", port: 9001 });
  assert.deepEqual(splitHost("hub.local"), { host: "hub.local", port: 80 });
  assert.equal(splitHost("[::1]:9001"), null);
  const known = readPlayerRecord({ v: 1, devices: { "cp-a1b2c3": { hubHost: "hub.local:8123" } }, active: "cp-a1b2c3" });
  assert.deepEqual(hubDefaults(known, "app.example"), { host: "hub.local", port: 8123 });
  assert.deepEqual(hubDefaults(readPlayerRecord(null), "192.168.1.5"), { host: "192.168.1.5", port: 9001 });
  // Opened on the hub's own machine: a player can't reach that address, so the guide offers none (and no error for
  // a value the user never typed) rather than prefilling one it must refuse.
  for (const local of ["localhost", "127.0.0.1"]) assert.deepEqual(hubDefaults(readPlayerRecord(null), local), { host: "", port: 9001 });
  assert.deepEqual(hubDefaults(known, "localhost"), { host: "hub.local", port: 8123 });
});

test("setup: the code the guide builds is one the player accepts, key or not", () => {
  const base = "/api/plugins/github.12.cartridge-player/api";
  const withKey = setupCodeFor({ host: " 192.168.1.12 ", port: "9001", base, key: " db_abcdefgh123 " });
  assert.deepEqual(decodeSetupCode(withKey.code), { host: "192.168.1.12", port: 9001, base, key: "db_abcdefgh123" });
  const noKey = setupCodeFor({ host: "hub.local", port: "80", base, key: "" });
  assert.equal(decodeSetupCode(noKey.code).key, null);
});

test("setup: no code while a field is wrong, and each field says why (localhost can't be reached by a player)", () => {
  const base = "/api/plugins/x/api";
  const local = setupCodeFor({ host: "localhost", port: "9001", base, key: "" });
  assert.equal(local.code, null);
  assert.match(local.problems.host, /only works on this computer/);
  const bad = setupCodeFor({ host: "http://hub", port: "70000", base, key: "has space" });
  assert.deepEqual(Object.keys(bad.problems).sort(), ["host", "key", "port"]);
});

test("setup: the guide asks for the hub's address only when the page couldn't work it out", () => {
  assert.deepEqual(guideSteps(true), ["key", "code", "phone"]);
  assert.deepEqual(guideSteps(false), ["hub", "key", "code", "phone"]);
});

test("setup: the guide is done when a player reports after it opened, not for one heard before", () => {
  const at = (ms) => new Date(ms).toISOString();
  const record = (devices) => readPlayerRecord({ v: 1, devices, active: Object.keys(devices)[0] ?? null });
  const player = (lastHeardAt, name = "Cartridge-A1B2") => ({ name, fw: "2.0.0", slot: null, lastHeardAt });
  const presence = (online) => ({ online, lastHeardAt: null, deviceId: "cp-a1b2c3", name: "Cartridge-A1B2", firmware: "2.0.0", reader: "ok" });

  // First run: nobody has reported, so the first player to do so is the one just set up.
  const empty = record({});
  const first = heardMark(empty, null);
  assert.equal(heardSince(first, empty, null), null);
  assert.deepEqual(heardSince(first, record({ "cp-a1b2c3": player(at(NOW)) }), presence(true)), { name: "Cartridge-A1B2" });

  // Opened from the Player panel with a player already there: its old report doesn't count, a newer one does,
  // and so does another player turning up.
  const known = record({ "cp-a1b2c3": player(at(NOW - 3_600_000)) });
  const later = heardMark(known, presence(false));
  assert.equal(heardSince(later, known, presence(false)), null);
  assert.deepEqual(heardSince(later, record({ "cp-a1b2c3": player(at(NOW)) }), presence(false)), { name: "Cartridge-A1B2" });
  const two = record({ "cp-a1b2c3": player(at(NOW - 3_600_000)), "cp-d4e5f6": player(at(NOW), "Cartridge-D4E5") });
  assert.deepEqual(heardSince(later, two, presence(false)), { name: "Cartridge-D4E5" });
  // Main doesn't write every heartbeat: the shown player coming online says the same.
  assert.deepEqual(heardSince(later, known, presence(true)), { name: "Cartridge-A1B2" });
  // One that was already online when the guide opened proves nothing.
  assert.equal(heardSince(heardMark(known, presence(true)), known, presence(true)), null);
});

test("main: an 'unavailable' the page opened with is 'connecting' until confirmed; changes need it running", () => {
  assert.equal(mainStatusOf({ state: "unavailable" }, false).state, "connecting");
  assert.equal(mainStatusOf({ state: "unavailable", reason: " Crashed " }, true).reason, "Crashed");
  assert.equal(mainNotice("connecting", null), null);
  assert.equal(mainNotice("running", null), null);
  assert.match(mainNotice("disabled", null).body, /labels can't change/);
  // The second sentence stands by itself, whatever reason the app gave in the first.
  assert.equal(
    mainNotice("unavailable", "It crashed.").body,
    "It crashed. Until it's running again, the player can't start anything and labels can't change.",
  );
  assert.equal(canChange("running"), true);
  assert.equal(canChange("starting"), false);
});

test("requests: main's refusals read as its own sentence; the platform's codes say whether it may have happened", () => {
  const refusal = Object.assign(new Error("take it out of the player first"), { code: "invalid" });
  assert.equal(requestError(refusal), "Take it out of the player first.");
  assert.match(requestError(Object.assign(new Error("x"), { code: "timeout" })), /may still have happened/);
  assert.match(requestError(Object.assign(new Error("x"), { code: "unavailable" })), /nothing changed/);
});

test("requests: a save storage refused says to try again; the platform's own 'failed' still says to look before repeating", () => {
  // Main's sentence for a label, forget or dismiss whose write was rolled back: nothing is in doubt, and retrying is safe.
  const notSaved = Object.assign(new Error(SAVE_REFUSED), { code: "failed" });
  assert.equal(requestError(notSaved), `${SAVE_REFUSED}.`);
  assert.match(requestError(notSaved), /try again\.$/);
  // A handler that threw has the same code, and there the change may be half done.
  const threw = requestError(Object.assign(new Error("Cannot read properties of undefined"), { code: "failed" }));
  assert.match(threw, /may still have happened/);
  assert.doesNotMatch(threw, /Cannot read/);
});

test("requests: a failed start that main recorded on the slot is told apart from one that never reached it", () => {
  // Main writes the action's message on the slot (300 characters at most) and rethrows the action's own error, whose
  // code reads as "the plugin isn't running" although it ran.
  const refused = Object.assign(new Error("Drift Beacon is restarting"), { code: "unavailable" });
  assert.equal(recordedByMain(refused, "Drift Beacon is restarting"), true);
  const long = "x".repeat(400);
  assert.equal(recordedByMain(new Error(long), long.slice(0, 300)), true);
  // The platform's own failures leave nothing on the slot, or something else.
  assert.equal(recordedByMain(Object.assign(new Error("Timed out"), { code: "timeout" }), "Drift Beacon is restarting"), false);
  assert.equal(recordedByMain(refused, null), false);
  assert.equal(recordedByMain("Drift Beacon is restarting", "Drift Beacon is restarting"), false);
  assert.equal(recordedByMain(new Error(""), ""), false);
});

test("shelf: Forget is off only while the cartridge tracks or its player is online; a slot held by a quiet player doesn't block it", () => {
  const slot = { tag: A, since: iso(NOW - 5 * HOUR), activityId: "deep", sessionId: "s1", outcome: "started" };
  const LIVE = [{ id: "s1", activityId: "deep", startedAt: NOW - 5 * HOUR }];
  const players = (devices, active) => readPlayerRecord({ v: 1, devices, active });
  const published = (extra) => readPresence({ online: true, lastHeardAt: iso(NOW - 3 * HOUR), deviceId: "cp-a1b2c3", reader: "ok", ...extra });
  const state = (record, presence, live = []) => forgetState(record, A, live, presence);
  const shown = players({ "cp-a1b2c3": { slot, lastHeardAt: iso(NOW - 3 * HOUR) } }, "cp-a1b2c3");
  const out = players({ "cp-a1b2c3": { slot: null, lastHeardAt: iso(NOW - MIN) } }, "cp-a1b2c3");

  // Out of every player: nothing in the way, whatever the player's status.
  for (const online of [true, false, null]) assert.equal(state(out, published({ online })), "free");
  // In the shown player, which is online: it will say when the cartridge leaves, so that is what Forget waits for.
  assert.equal(state(shown, published({})), "in-player");
  assert.equal(state(shown, published({}), LIVE), "in-player");
  assert.equal(forgetBlockedNote("in-player"), null, "the button's own words say it");
  // Its player is offline, or main has just started and hasn't heard it yet: the record may be all that keeps the
  // cartridge "in", so Forget is on (and clears the slot), unless the session it started is still live.
  for (const online of [false, null]) {
    assert.equal(state(shown, published({ online })), "held");
    assert.equal(state(shown, published({ online }), LIVE), "tracking");
  }
  assert.match(forgetBlockedNote("tracking"), /end the session in Drift Beacon; then it can be forgotten\.$/);
  // A session of the same activity that isn't the slot's own doesn't count.
  assert.equal(state(shown, published({ online: false }), [{ id: "s-app", activityId: "deep", startedAt: NOW }]), "held");

  // A stored player that isn't the shown one: its status isn't published, so this copy can't call it online.
  const other = players({ "cp-a1b2c3": { slot: null, lastHeardAt: iso(NOW - MIN) }, "cp-d4e5f6": { slot, lastHeardAt: iso(NOW - MIN) } }, "cp-a1b2c3");
  assert.equal(state(other, published({})), "held");
  assert.equal(state(other, published({}), LIVE), "tracking");
  // The published status says whose it is: a record a push behind on `active` doesn't lend it to another player.
  assert.equal(state(other, published({ deviceId: "cp-d4e5f6" })), "in-player");

  // Main isn't running: nothing is known to be online (and nothing can change: the details are read-only).
  assert.equal(state(shown, null), "held");

  // What the confirmation adds for a held cartridge, and what a refusal after it says: main knows of players this
  // copy can't see, and its own "Take it out of the player first" would contradict the confirmation.
  assert.equal(FORGET_CLEARS_SLOT, "The player last reported this cartridge in its slot. Forgetting it also clears that.");
  const refused = Object.assign(new Error("Take it out of the player first"), { code: "invalid" });
  assert.equal(forgetRefusal(refused, "held"), FORGET_HOLDER_ONLINE);
  assert.match(FORGET_HOLDER_ONLINE, /^Its player is online after all.* Take it out of the player first\.$/);
  // Any other failure, or a refusal of a cartridge that wasn't held here, keeps its usual sentence.
  assert.equal(forgetRefusal(refused, "free"), null);
  assert.equal(forgetRefusal(Object.assign(new Error("Timed out"), { code: "timeout" }), "held"), null);
  assert.equal(forgetRefusal(Object.assign(new Error(SAVE_REFUSED), { code: "failed" }), "held"), null);
});

test("colour: text on an activity's sticker is whichever ink reads, so a pale colour gets dark text", () => {
  assert.equal(inkOn("#ffffff"), INK_DARK);
  assert.equal(inkOn("#fbbf24", 0.16), INK_DARK);
  assert.equal(inkOn("#1e3a8a"), INK_LIGHT);
  assert.equal(inkOn("hsl(10 50% 50%)"), INK_LIGHT);
});

test("colour: a sticker's ink is chosen where its title sits, on the faded part, not on the solid colour", () => {
  const SHELL = [0x45, 0x42, 0x3e];
  // What's painted: the colour mixed toward the shell (all of it at the solid corner, STICKER_FADE at the faded one),
  // then the black overlay.
  assert.deepEqual(stickerPaint("#ffffff", 0), shaded([255, 255, 255], STICKER_SHADE));
  assert.deepEqual(stickerPaint("#ffffff", 1), shaded(mixed([255, 255, 255], SHELL, STICKER_FADE), STICKER_SHADE));
  assert.equal(stickerPaint("not-a-colour", 1), null);
  // Mid-tones: the solid colour alone would take dark ink, but the title sits where the sticker is darker.
  for (const color of ["#a78bfa", "#60a5fa"]) {
    assert.equal(inkOn(color, STICKER_SHADE), INK_DARK, `${color}: dark on the solid colour`);
    assert.equal(sticker(color).ink, INK_LIGHT, `${color}: white where the title is`);
  }
  // Pale colours keep dark ink, a deep one white.
  for (const color of ["#fef08a", "#fafafa"]) assert.equal(sticker(color).ink, INK_DARK, color);
  assert.equal(sticker("#1e3a8a").ink, INK_LIGHT);
  // The chosen ink reads (4.5:1) along the title's stretch of the fade for each of them.
  for (const color of ["#a78bfa", "#60a5fa", "#fef08a", "#fafafa", "#1e3a8a"]) {
    const ink = parseColor(sticker(color).ink);
    for (const at of [0.75, 1]) assert.ok(contrast(stickerPaint(color, at), ink) >= 4.5, `${color} at ${at}`);
  }
  // The gradient is opaque: it ends on the colour mixed with the shell, so the page behind never changes the ink's ground.
  assert.deepEqual(sticker("#a78bfa"), { from: "#a78bfa", to: "color-mix(in srgb, #a78bfa 80%, #45423e)", ink: INK_LIGHT });
  // A colour this can't parse still gets a sticker, with white ink.
  assert.equal(sticker("hsl(10 50% 50%)").ink, INK_LIGHT);
});

test("live model: a stored value read again keeps its object while it's equal, so views below don't recompute", () => {
  const read = stableReader(readMappings);
  const first = read({ [A]: "deep" });
  assert.equal(read(structuredClone({ [A]: "deep" })), first);
  assert.notEqual(read({ [A]: "gym" }), first);
});

test("live model: workspace rows keep their objects through a rebuild, so one session doesn't redraw every card", () => {
  const rows = stableRows();
  const build = (extra = {}) => [
    { id: "deep", name: "Deep work", archived: false },
    { id: "gym", name: "Gym", archived: false, ...extra },
  ];
  const first = rows(build());
  // The SDK hands out a new list (and the model new rows) whenever any collection changes; nothing here did.
  assert.equal(rows(build()), first);
  // One row changed: a new list, the unchanged row still the same object.
  const renamed = rows(build({ name: "Gym class" }));
  assert.notEqual(renamed, first);
  assert.equal(renamed[0], first[0]);
  assert.deepEqual(renamed[1], { id: "gym", name: "Gym class", archived: false });
  // Order is part of the list; a row that left and came back equal is kept too.
  const swapped = rows([...build({ name: "Gym class" })].reverse());
  assert.notEqual(swapped, renamed);
  assert.equal(swapped[1], renamed[0]);
  assert.deepEqual(rows([]), []);
});
