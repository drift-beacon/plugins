// The stage's phase, derived the way the interface derives it: raw storage as main writes it, read through the
// shared readers (the live model's own path), plus live sessions and activities as plain rows. Each test names the
// rule of ours it protects (DESIGN.md "Interface" and "The slot state machine").
import assert from "node:assert/strict";
import { test } from "node:test";
import { readMappings, readPlayerRecord } from "../shared/storage.ts";
import {
  cartridgeLook,
  deriveStage,
  ENDING_HOLD_MS,
  endingOf,
  holdStage,
  nextChange,
  phaseKey,
  phaseSentence,
  phaseTag,
  READING_MAX_MS,
  READING_MIN_MS,
  readingShows,
  SAVED_MS,
  slotKey,
} from "../ui/src/view/phase.ts";
import { byId } from "../ui/src/view/types.ts";

const NOW = Date.parse("2026-10-03T10:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const TAG = "04:A2:3B:1C:7F:5D:80";
const OTHER = "04:C4:58:2E:61:0B:80";

const activity = (id, name, extra = {}) => ({
  id,
  name,
  color: "#60a5fa",
  iconPath: "M0 0",
  categoryId: "work",
  categoryName: "Work",
  archived: false,
  point: false,
  ...extra,
});
const ACTIVITIES = byId([
  activity("deep", "Deep work"),
  activity("gym", "Gym"),
  activity("old", "Old hobby", { archived: true }),
  activity("water", "Glass of water", { point: true }),
]);

/** Storage as main writes it: one device, its slot, history. */
function storage({ slot = null, history = [], devices } = {}) {
  return {
    v: 1,
    devices: devices ?? {
      "cp-a1b2c3": { name: "Cartridge-A1B2", fw: "2.0.0", boot: 1, seq: 3, slot, lastHeardAt: iso(NOW - 60_000), hubHost: "192.168.1.12:9001" },
    },
    active: "cp-a1b2c3",
    unknown: [],
    cartridges: {},
    history,
    nextId: history.length + 1,
  };
}

const slot = (extra = {}) => ({ tag: TAG, since: iso(NOW - 10 * 60_000), activityId: "deep", sessionId: "s1", outcome: "started", error: null, ...extra });

function stage({ player = storage(), mappings = { [TAG]: "deep" }, live = [], reading = null, parked = null, labelled = null, now = NOW } = {}) {
  const input = { record: readPlayerRecord(player), mappings: readMappings(mappings), activities: ACTIVITIES, live, reading, parked, labelled, now };
  return { input, ...deriveStage(input) };
}

test("phase: a slot plays only while the session it started is live, with that session's start and activity", () => {
  const live = [{ id: "s1", activityId: "deep", startedAt: NOW - 600_000 }];
  // Relabelled to Gym while it plays: the stage keeps showing what it started (main ends that session on eject).
  const { phase } = stage({ player: storage({ slot: slot() }), mappings: { [TAG]: "gym" }, live });
  assert.equal(phase.kind, "playing");
  assert.equal(phase.activity.name, "Deep work");
  assert.equal(phase.startedAt, NOW - 600_000);
});

test("phase: a live session of the same activity started elsewhere doesn't make the slot play (it isn't the slot's)", () => {
  const live = [{ id: "s-app", activityId: "deep", startedAt: NOW - 60_000 }];
  const { phase } = stage({ player: storage({ slot: slot() }), live });
  assert.equal(phase.kind, "ready");
  assert.equal(phase.reason, "ended");
});

test("phase: labelled while in is ready; 'Later' parks only that stay; the copy that labelled it says Labelled", () => {
  const idle = storage({ slot: slot({ outcome: "idle", sessionId: null }) });
  const key = slotKey(readPlayerRecord(idle).devices["cp-a1b2c3"].slot);
  assert.deepEqual(
    [stage({ player: idle }).phase.kind, stage({ player: idle }).phase.reason],
    ["ready", "idle"],
  );
  assert.equal(stage({ player: idle, labelled: key }).phase.reason, "labelled");
  assert.equal(stage({ player: idle, parked: key }).phase.kind, "parked");
  // Put in again: a new stay, so the old "Later" no longer applies.
  const again = storage({ slot: slot({ outcome: "idle", sessionId: null, since: iso(NOW - 1000) }) });
  assert.equal(stage({ player: again, parked: key }).phase.kind, "ready");
});

test("phase: an unlabelled cartridge is unknown; a deleted activity is orphan; an archived one is archived", () => {
  assert.equal(stage({ player: storage({ slot: slot({ activityId: null, sessionId: null, outcome: "unknown" }) }), mappings: {} }).phase.kind, "unknown");
  assert.equal(
    stage({ player: storage({ slot: slot({ activityId: "gone", sessionId: null, outcome: "orphan" }) }), mappings: { [TAG]: "gone" } }).phase.kind,
    "orphan",
  );
  const archived = stage({ player: storage({ slot: slot({ activityId: "old", sessionId: null, outcome: "archived" }) }), mappings: { [TAG]: "old" } }).phase;
  assert.equal(archived.kind, "archived");
  assert.equal(archived.activity.name, "Old hobby");
});

test("phase: a cartridge that isn't playing offers what Start would start, which is today's label", () => {
  // Deep work played, the cartridge was relabelled Gym meanwhile (main leaves a playing slot alone), then the session
  // was ended in the app. Main's `start` resolves the mapping, so the stage must offer Gym, and Gym's session never
  // ran, so it can't have "ended".
  const { phase } = stage({ player: storage({ slot: slot() }), mappings: { [TAG]: "gym" } });
  assert.deepEqual([phase.kind, phase.reason, phase.activity.name], ["ready", "idle", "Gym"]);
  assert.equal(cartridgeLook(TAG, phase, readMappings({ [TAG]: "gym" }), ACTIVITIES).activity.name, "Gym");
  // The label's activity was deleted since: Start would refuse, and the stage asks for a new label instead.
  assert.equal(stage({ player: storage({ slot: slot() }), mappings: { [TAG]: "gone" } }).phase.kind, "orphan");
  // Unchanged label: the same slot says its session ended.
  assert.equal(stage({ player: storage({ slot: slot() }) }).phase.reason, "ended");
});

test("phase: labelling an unknown cartridge from another copy shows here once main writes the slot's activity", () => {
  // Main sets the slot's activityId with the mapping; a copy a push behind still finds it through the mapping.
  const unknownSlot = storage({ slot: slot({ activityId: null, sessionId: null, outcome: "unknown" }) });
  assert.equal(stage({ player: unknownSlot, mappings: { [TAG]: "gym" } }).phase.kind, "ready");
});

test("phase: a failed start is an error with main's message, until the user says Later (which keeps the reason)", () => {
  const failed = storage({ slot: slot({ sessionId: null, outcome: "error", error: "The hub refused it" }) });
  const { phase, slotKey: key } = stage({ player: failed });
  assert.equal(phase.kind, "error");
  assert.equal(phase.message, "The hub refused it");
  // Parked, the note no longer shows the reason: the phase carries it so a retry that fails the same way can.
  const parked = stage({ player: failed, parked: key }).phase;
  assert.deepEqual([parked.kind, parked.error], ["parked", "The hub refused it"]);
  // "Later" on a cartridge that never failed has no reason to carry.
  const idle = storage({ slot: slot({ sessionId: null, outcome: "idle" }) });
  assert.equal(stage({ player: idle, parked: stage({ player: idle }).slotKey }).phase.error, null);
});

test("phase: a point activity's cartridge is marked while it stays in, at the time it was marked", () => {
  const water = { [TAG]: "water" };
  const since = NOW - 30 * 60_000;
  const marked = slot({ since: iso(since), activityId: "water", sessionId: "p1", outcome: "marked" });
  const entry = (kind, at) => ({ id: 1, at: iso(at), kind, tag: TAG, activityId: "water", deviceId: "cp-a1b2c3", sessionId: "p1", durationMs: null });
  // Marked by the insert: the entry and the slot agree.
  const onInsert = stage({ player: storage({ slot: marked, history: [entry("insert", since)] }), mappings: water }).phase;
  assert.deepEqual([onInsert.kind, onInsert.activity.point, onInsert.at], ["marked", true, since]);
  // Labelled while in, then "Mark now" half an hour later: main keeps the slot's `since` (the stay), so the time of
  // the mark is the `start` entry's, not when the cartridge went in.
  const later = stage({ player: storage({ slot: marked, history: [entry("start", NOW)] }), mappings: water }).phase;
  assert.equal(later.at, NOW);
  // Another cartridge's or another session's entry isn't this mark; with its own entry trimmed, the stay's start stands in.
  const other = { ...entry("start", NOW), sessionId: "p0" };
  assert.equal(stage({ player: storage({ slot: marked, history: [other] }), mappings: water }).phase.at, since);
});

/** A history entry as main writes it for the beat's cartridge on the stage's device. */
const moved = (id, kind, extra = {}) => ({ id, at: iso(NOW), kind, tag: OTHER, activityId: "gym", deviceId: "cp-a1b2c3", sessionId: null, durationMs: null, ...extra });
const GYM = { [OTHER]: "gym" };

test("phase: reading shows from main's message for its minimum, then until main writes the insert, never past its maximum", () => {
  const empty = storage();
  // The beat names the history entry its insert will get: 5.
  const beat = { tag: OTHER, deviceId: "cp-a1b2c3", at: NOW, entry: 5 };
  // Storage already resolved, but the beat still holds for its minimum so the insert reads as a beat.
  const resolved = storage({ slot: slot({ tag: OTHER, activityId: "gym", sessionId: null, outcome: "idle" }), history: [moved(5, "insert")] });
  assert.equal(stage({ player: resolved, mappings: GYM, reading: beat, now: NOW + READING_MIN_MS - 1 }).phase.kind, "reading");
  assert.equal(stage({ player: resolved, mappings: GYM, reading: beat, now: NOW + READING_MIN_MS }).phase.kind, "ready");
  // A blank cartridge's outcome is a `new` entry.
  const blank = storage({ slot: slot({ tag: OTHER, activityId: null, sessionId: null, outcome: "unknown" }), history: [moved(5, "new", { activityId: null })] });
  assert.equal(stage({ player: blank, mappings: {}, reading: beat, now: NOW + READING_MIN_MS }).phase.kind, "unknown");
  // Nothing written yet: the beat goes on, up to its maximum.
  assert.equal(stage({ player: empty, reading: beat, now: NOW + 3000 }).phase.kind, "reading");
  assert.equal(stage({ player: empty, reading: beat, now: NOW + READING_MAX_MS }).phase.kind, "empty");
  // An earlier stay of the same cartridge (entry 3) isn't this insert's outcome.
  assert.equal(stage({ player: storage({ history: [moved(4, "eject"), moved(3, "insert")] }), reading: beat, now: NOW + 3000 }).phase.kind, "reading");
  // Nor is another player's insert of it, or another cartridge's on this player.
  for (const not of [{ deviceId: "cp-other" }, { tag: TAG }]) {
    assert.equal(stage({ player: storage({ history: [moved(5, "insert", not)] }), reading: beat, now: NOW + 3000 }).phase.kind, "reading");
  }
  assert.equal(readingShows(null, readPlayerRecord(empty), NOW), false);
});

test("phase: the reading beat outlasts the 10 s the host waits for a session action, and the write after it", () => {
  // Main posts `reading`, awaits the start (the host gives up on it after 10 s) and only then writes the outcome. A
  // beat that ended sooner would show the slot as it was before the insert, then "Couldn't start" a moment later.
  const HOST_ACTION_WAIT_MS = 10_000;
  const beat = { tag: OTHER, deviceId: "cp-a1b2c3", at: NOW, entry: 5 };
  const before = readPlayerRecord(storage());
  assert.equal(readingShows(beat, before, NOW + HOST_ACTION_WAIT_MS), true);
  assert.equal(stage({ reading: beat, now: NOW + HOST_ACTION_WAIT_MS + 1000 }).phase.kind, "reading", "and while the outcome is written");
  // It still ends a beat whose outcome never arrives.
  assert.equal(readingShows(beat, before, NOW + READING_MAX_MS), false);
});

test("phase: a playing stage is held while its session has just stopped, so an eject never reads as 'session ended'", () => {
  const live = [{ id: "s1", activityId: "deep", startedAt: NOW - 600_000 }];
  const playing = stage({ player: storage({ slot: slot() }), live });
  // An eject reaches an open copy as two pushes: main ends the session, then writes the emptied slot. In between the
  // slot is one whose session isn't live, which derives as `ready` / "Session ended".
  const between = stage({ player: storage({ slot: slot() }) });
  assert.deepEqual([between.phase.kind, between.phase.reason], ["ready", "ended"]);
  assert.equal(endingOf(playing, between), true);
  const eject = { id: 1, at: iso(NOW), kind: "eject", tag: TAG, activityId: "deep", deviceId: "cp-a1b2c3", sessionId: "s1", durationMs: 600_000 };
  const emptied = stage({ player: storage({ history: [eject] }) });
  assert.equal(endingOf(playing, emptied), false);

  // The stage: held from the first push, and the emptied slot shows the moment it arrives.
  const shown = { stage: playing, heldSince: null };
  const held = holdStage(shown, between, NOW);
  assert.deepEqual([held.stage, held.heldSince], [playing, NOW]);
  assert.equal(holdStage(held, between, NOW + ENDING_HOLD_MS - 1), held, "nothing changes while it's held");
  const out = holdStage(held, emptied, NOW + 120);
  assert.deepEqual([out.stage.phase.kind, out.stage.phase.saved.durationMs, out.heldSince], ["empty", 600_000, null]);
  // A session ended in the app leaves the cartridge in: once the hold is over the stage says so.
  const ended = holdStage(held, between, NOW + ENDING_HOLD_MS);
  assert.deepEqual([ended.stage, ended.heldSince], [between, null]);
  assert.equal(holdStage(ended, between, NOW + ENDING_HOLD_MS + 1), ended);

  // The same gap for a cartridge relabelled while it played, or whose activity went meanwhile: also held.
  const relabelled = stage({ player: storage({ slot: slot() }), mappings: { [TAG]: "gym" } });
  const archived = stage({ player: storage({ slot: slot() }), mappings: { [TAG]: "old" } });
  assert.deepEqual([relabelled.phase.reason, archived.phase.kind], ["idle", "archived"]);
  for (const next of [relabelled, archived]) assert.equal(endingOf(playing, next), true);

  // Only a playing stage, and only the same stay of the same cartridge: everything else shows at once.
  assert.equal(endingOf(between, between), false);
  const again = stage({ player: storage({ slot: slot({ since: iso(NOW - 1000), sessionId: "s2" }) }) });
  assert.equal(endingOf(playing, again), false, "taken out and put in again is a new stay");
  const reading = stage({ player: storage({ slot: slot() }), reading: { tag: OTHER, deviceId: "cp-a1b2c3", at: NOW, entry: 9 } });
  assert.equal(endingOf(playing, reading), false);
  assert.equal(holdStage(shown, reading, NOW).stage, reading);
  // And a stage that hasn't changed is the same object, so nothing re-renders for it.
  assert.equal(holdStage(shown, playing, NOW + 5000), shown);
});

test("phase: a cartridge pulled straight out again doesn't bring the reading beat back", () => {
  // In at NOW (beat, entry 5), resolved at +2 s, out again at +3 s: the slot is empty, as it was before the insert.
  const beat = { tag: OTHER, deviceId: "cp-a1b2c3", at: NOW, entry: 5 };
  const eject = moved(6, "eject", { at: iso(NOW + 3000), sessionId: "s9", durationMs: 1000 });
  const out = storage({ history: [eject, moved(5, "insert", { sessionId: "s9" })] });
  for (const now of [NOW + 3100, NOW + 5000, NOW + READING_MAX_MS - 100]) {
    const { phase } = stage({ player: out, mappings: GYM, reading: beat, now });
    assert.equal(phase.kind, "empty", `at +${now - NOW} ms`);
    assert.equal(phase.saved.activity.name, "Gym");
    assert.equal(phaseTag(phase), null, "the scene draws no cartridge in the slot");
  }
});

test("phase: a swap reads the new cartridge until its own insert is written, through the old one's eject", () => {
  const beat = { tag: OTHER, deviceId: "cp-a1b2c3", at: NOW, entry: 6 };
  // Storage still holds the old cartridge.
  const holding = stage({ player: storage({ slot: slot() }), reading: beat, now: NOW + 2000 }).phase;
  assert.deepEqual([holding.kind, holding.tag], ["reading", OTHER]);
  // The old cartridge's eject lands first (a write of its own): still reading, not a flash of an empty slot.
  const ejected = storage({ history: [moved(5, "eject", { tag: TAG, activityId: "deep", sessionId: "s1", durationMs: 60_000 })] });
  assert.equal(stage({ player: ejected, reading: beat, now: NOW + 2000 }).phase.kind, "reading");
  // A copy that heard the beat before the eject reached it read `nextId` as 5: the eject (5) still isn't the insert.
  assert.equal(stage({ player: ejected, reading: { ...beat, entry: 5 }, now: NOW + 2000 }).phase.kind, "reading");
});

test("phase: an eject that saved time shows 'Saved' for 90 s, and only the latest move counts", () => {
  const eject = { id: 2, at: iso(NOW - 30_000), kind: "eject", tag: TAG, activityId: "deep", deviceId: "cp-a1b2c3", sessionId: "s1", durationMs: 52 * 60_000 };
  const saved = stage({ player: storage({ history: [eject] }) }).phase;
  assert.equal(saved.kind, "empty");
  assert.equal(saved.saved.durationMs, 52 * 60_000);
  assert.equal(saved.saved.activity.name, "Deep work");
  assert.equal(stage({ player: storage({ history: [eject] }), now: Date.parse(eject.at) + SAVED_MS + 1 }).phase.saved, null);
  // An unlabelled cartridge coming out saved nothing.
  assert.equal(stage({ player: storage({ history: [{ ...eject, activityId: null, durationMs: null }] }) }).phase.saved, null);
  // Something went in after it (and came out without time): no stale Saved.
  const insert = { ...eject, id: 3, kind: "insert", at: iso(NOW - 10_000) };
  assert.equal(stage({ player: storage({ history: [insert, eject] }) }).phase.saved, null);
});

test("phase: the stage re-derives when the clock alone changes it (beat ends, Saved fades)", () => {
  const eject = { id: 2, at: iso(NOW - 30_000), kind: "eject", tag: TAG, activityId: "deep", deviceId: "cp-a1b2c3", sessionId: "s1", durationMs: 60_000 };
  const s = stage({ player: storage({ history: [eject] }) });
  assert.equal(nextChange(s.input, s), Date.parse(eject.at) + SAVED_MS + 1);
  const r = stage({ reading: { tag: OTHER, deviceId: "cp-a1b2c3", at: NOW, entry: 1 } });
  assert.equal(nextChange(r.input, r), NOW + READING_MIN_MS);
  const idle = stage();
  assert.equal(nextChange(idle.input, idle), null);
});

test("phase: the cartridge drawn shows what the phase says, and a cartridge being read shows its mapping", () => {
  const playing = stage({ player: storage({ slot: slot() }), mappings: { [TAG]: "gym" }, live: [{ id: "s1", activityId: "deep", startedAt: NOW }] });
  const mappings = readMappings({ [TAG]: "gym" });
  assert.equal(cartridgeLook(TAG, playing.phase, mappings, ACTIVITIES).activity.name, "Deep work");
  assert.equal(cartridgeLook(OTHER, playing.phase, mappings, ACTIVITIES).kind, "blank");
  assert.equal(cartridgeLook(TAG, { kind: "reading", tag: TAG }, readMappings({ [TAG]: "gone" }), ACTIVITIES).kind, "orphan");
});

test("phase: the live region says each phase in words, never with the ticking clock, and keys change per cartridge", () => {
  const playing = stage({ player: storage({ slot: slot() }), live: [{ id: "s1", activityId: "deep", startedAt: NOW }] }).phase;
  assert.equal(phaseSentence(playing), "Deep work is tracking.");
  assert.doesNotMatch(phaseSentence(playing), /\d/);
  assert.notEqual(phaseKey({ kind: "unknown", tag: TAG }), phaseKey({ kind: "unknown", tag: OTHER }));
});
