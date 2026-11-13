// Main's rules for whose a cartridge's session is: the pure policy, and what the real plugin (createPlugin with a
// test clock and timers, over a small fake ctx) asks the workspace to do when a cartridge goes in, comes out, is
// labelled or given its members, or Start is pressed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlugin } from "../main/src/index.ts";
import { isOwnLiveSpan, lateFor, lateSession, mayHaveRun, resolveCartridge } from "../main/src/policy.ts";
import { actingFor } from "../shared/acting-for.ts";
import { PROTOCOL, ROUTES } from "../shared/protocol.ts";
import { STORAGE_KEYS } from "../shared/storage.ts";

const SAM = "member-sam";
const JO = "member-jo";
const KIM = "member-kim";
const GONE = "member-gone";
const TAG = "04:A2:3B:1C";
const NEW_TAG = "04:11:22:33";
const T0 = Date.parse("2026-11-13T09:00:00.000Z");

const roster = (ids, owner = ids[0]) =>
  ids.map((id) => ({ id, name: id, role: id === owner ? "OWNER" : "MEMBER", avatar: null }));

/**
 * A workspace and the plugin running in it. `members` is the roster (its first is the owner), `chosen` whom TAG tracks
 * for (undefined: nobody picked), and the activity's kind and refusals are what each test sets.
 */
function harness({ members = [SAM, JO], chosen, point = false, refuse = null } = {}) {
  let clock = T0;
  const sessions = new Map();
  const calls = [];
  const warnings = [];
  let nextId = 1;

  /** A session started now; `memberIds` (who took part) defaults to whom it started with. */
  const session = (fields) => {
    const row = {
      id: `s${nextId++}`,
      activityId: "reading",
      exists: true,
      isSpan: !point,
      isLive: !point,
      currentMemberIds: [],
      startedAt: new Date(clock),
      endedAt: null,
      ...fields,
    };
    row.memberIds = fields.memberIds ?? row.currentMemberIds;
    sessions.set(row.id, row);
    return row;
  };
  const action = (kind) => async (options) => {
    calls.push({ kind, options });
    if (refuse) return refuse(session, options, (ms) => (clock += ms));
    return session({ currentMemberIds: point ? [] : (options?.members ?? []) });
  };
  const activity = {
    id: "reading",
    name: "Reading",
    exists: true,
    archived: false,
    isPoint: point,
    live: () =>
      [...sessions.values()].filter((s) => s.exists && s.isLive).sort((a, b) => b.startedAt - a.startedAt),
    mark: action("mark"),
    track: action("track"),
  };

  const record = { v: 1, cartridges: chosen === undefined ? {} : { [TAG]: { members: chosen } } };
  const store = new Map([
    [STORAGE_KEYS.mappings, { [TAG]: "reading" }],
    [STORAGE_KEYS.player, record],
  ]);
  /** Keys whose next write storage refuses. */
  const refuseWrite = new Set();
  const routes = new Map();
  const handlers = new Map();
  const ctx = {
    members: roster(members),
    log: { info() {}, warn: (...line) => void warnings.push(line.join(" ")), error() {} },
    activities: { get: (id) => (id === "reading" ? activity : undefined) },
    sessions: {
      get: (id) => sessions.get(id),
      async end(id) {
        calls.push({ kind: "end", id });
        Object.assign(sessions.get(id), { isLive: false, currentMemberIds: [], endedAt: new Date(clock) });
      },
    },
    storage: {
      get: (key) => store.get(key),
      async set(key, value) {
        if (refuseWrite.delete(key)) throw new Error("refused");
        store.set(key, value);
      },
      onChange() {},
    },
    state: { set() {} },
    events: { emit() {} },
    ui: { post() {}, handle: (name, handler) => void handlers.set(name, handler) },
    routes: { get() {}, post: (name, handler) => void routes.set(name, handler) },
    plugins: { get() {} },
    onDataChange() {},
    onStop() {},
  };
  const timers = { setTimeout: () => ({}), clearTimeout() {} };
  createPlugin({ now: () => clock, timers }).onStart(ctx);

  let seq = 0;
  /** The player reports `tag` in its slot (null: empty), with an API key of `keyOwner`'s. */
  const report = async (tag, keyOwner = SAM) => {
    seq += 1;
    const body = { v: PROTOCOL, device: { id: "cp-a1" }, boot: 1, seq, reason: "change", tag, reader: "ok" };
    const request = { body, headers: {}, query: {}, method: "POST", memberId: keyOwner };
    const response = await routes.get(ROUTES.report)(request);
    return response.body;
  };
  /** A request from the interface, viewed by `viewer`. */
  const request = (name, input, viewer = SAM) => handlers.get(name)(input, { memberId: viewer });
  const player = () => store.get(STORAGE_KEYS.player);
  return {
    activity,
    calls,
    warnings,
    ctx,
    refuseWrite,
    report,
    request,
    start: (viewer) => request("start", {}, viewer),
    label: (tag, viewer, members) =>
      request("label", { tag, activityId: "reading", ...(members ? { members } : {}) }, viewer),
    members: (tag, members) => request("members", { tag, members }),
    chosen: (tag = TAG) => player().cartridges[tag]?.members,
    slot: () => player().devices["cp-a1"]?.slot ?? null,
    session,
    sessions,
    tick: (ms) => (clock += ms),
  };
}

/* ---- The policy ---- */

const lookup = (activity) => ({
  activity: (id) => (id === activity.id ? activity : undefined),
  session: () => undefined,
});
const spanActivity = (live) => ({ id: "a", name: "A", exists: true, archived: false, isPoint: false, live: () => live });
const span = (id, currentMemberIds, startedAt = new Date(T0), memberIds = currentMemberIds) => ({
  id,
  memberIds,
  currentMemberIds,
  startedAt,
});
const refusal = (code) => Object.assign(new Error(code), { name: "PluginError", code });

test("who a cartridge acts for: its chosen members still here, in order, else the owner, else nobody", () => {
  const members = roster([SAM, JO, KIM]);
  assert.deepEqual(actingFor([KIM, JO, KIM], members), [KIM, JO]);
  assert.deepEqual(actingFor([GONE, JO], members), [JO]);
  assert.deepEqual(actingFor([GONE], members), [SAM]);
  assert.deepEqual(actingFor([], members), [SAM]);
  assert.deepEqual(actingFor(undefined, roster([JO, SAM], SAM)), [SAM]);
  assert.deepEqual(actingFor([SAM], []), []);
});

test("an insert adopts a live span only when every one of its members is in it", () => {
  const theirs = span("theirs", [JO]);
  const nobodys = span("nobodys", []);
  const shared = span("shared", [KIM, JO, SAM]);
  const adopted = resolveCartridge("a", lookup(spanActivity([theirs, nobodys, shared])), [SAM, JO]);
  assert.equal(adopted.kind, "adopt");
  assert.equal(adopted.sessionId, "shared");
  const started = resolveCartridge("a", lookup(spanActivity([theirs, nobodys])), [SAM, JO]);
  assert.equal(started.kind, "start");
  assert.deepEqual(started.members, [SAM, JO]);
  const point = { ...spanActivity([shared]), isPoint: true };
  const marked = resolveCartridge("a", lookup(point), [SAM, JO]);
  assert.deepEqual(marked, { kind: "mark", activity: point, members: [SAM, JO] });
});

test("with nobody to name, a cartridge neither starts, marks nor takes over anything", () => {
  const activity = spanActivity([span("theirs", [JO])]);
  assert.equal(resolveCartridge("a", lookup(activity), []).kind, "nobody");
  assert.equal(resolveCartridge("a", lookup({ ...activity, isPoint: true }), []).kind, "nobody");
  assert.equal(resolveCartridge(null, lookup(activity), []).kind, "unknown");
});

test("the slot's own session is ended on eject whoever is in it, nobody included", () => {
  const base = { id: "s", exists: true, isLive: true, isSpan: true, startedAt: new Date(T0), endedAt: null };
  assert.equal(isOwnLiveSpan({ ...base, currentMemberIds: [] }), true);
  assert.equal(isOwnLiveSpan({ ...base, currentMemberIds: [JO] }), true);
  assert.equal(isOwnLiveSpan({ ...base, isLive: false, currentMemberIds: [] }), false);
  assert.equal(isOwnLiveSpan({ ...base, isSpan: false, currentMemberIds: [] }), false);
  assert.equal(isOwnLiveSpan(undefined), false);
});

test("only a refusal that may have run, of a start, can leave a late session, for the members it named", () => {
  for (const code of ["invalid", "not-found", "unsupported"]) assert.equal(mayHaveRun(refusal(code)), false, code);
  // `unavailable` is how the host gives up waiting for an action; `stopped`, how it drops one while stopping.
  for (const code of ["unavailable", "stopped", "failed", "timeout"]) assert.equal(mayHaveRun(refusal(code)), true);
  assert.equal(mayHaveRun(new Error("thrown")), true);
  const activity = spanActivity([]);
  assert.deepEqual(lateFor({ kind: "start", activity, members: [SAM, JO] }, refusal("unavailable")), [SAM, JO]);
  assert.equal(lateFor({ kind: "start", activity, members: [SAM] }, refusal("invalid")), null);
  assert.equal(lateFor({ kind: "mark", activity, members: [SAM] }, refusal("unavailable")), null);
});

test("a refused start's late session is the newest live span since the insert, its members in the first seats", () => {
  const since = new Date(T0).toISOString();
  const before = span("before", [SAM], new Date(T0 - 1));
  const older = span("older", [SAM], new Date(T0 + 5000));
  // Started for Sam, who has left it since: still the one his start began.
  const newer = span("newer", [], new Date(T0 + 9000), [SAM]);
  const jos = span("jos", [JO, SAM], new Date(T0 + 20_000), [JO, SAM]);
  // `live()` is newest first.
  assert.equal(lateSession(spanActivity([newer, older, before]), since, [SAM]), "newer");
  assert.equal(lateSession(spanActivity([older, before]), since, [SAM]), "older");
  assert.equal(lateSession(spanActivity([before]), since, [SAM]), null);
  assert.equal(lateSession(spanActivity([span("jo", [JO], new Date(T0 + 1))]), since, [SAM]), null);
  assert.equal(lateSession(spanActivity([jos]), since, [SAM]), null, "Jo started it; Sam only joined");
  assert.equal(lateSession(undefined, since, [SAM]), null);
  // A set: its members in the first seats, in any order; seated later, they only joined.
  const pair = span("pair", [JO, SAM, KIM], new Date(T0 + 1), [JO, SAM, KIM]);
  assert.equal(lateSession(spanActivity([pair]), since, [SAM, JO]), "pair");
  assert.equal(lateSession(spanActivity([pair]), since, [SAM, KIM]), null, "Kim joined after the start");
  assert.equal(lateSession(spanActivity([pair]), since, []), null);
});

/* ---- The plugin ---- */

test("an insert starts the activity for the cartridge's members", async () => {
  const h = harness({ members: [SAM, JO, KIM], chosen: [JO, KIM] });
  assert.equal((await h.report(TAG)).result, "started");
  assert.deepEqual(h.calls, [{ kind: "track", options: { members: [JO, KIM] } }]);
});

test("a cartridge nobody picked for, or picked only for people who left, starts for the owner", async () => {
  const unset = harness({ members: [SAM, JO] });
  await unset.report(TAG, JO);
  assert.deepEqual(unset.calls, [{ kind: "track", options: { members: [SAM] } }]);
  const stale = harness({ members: [SAM, JO], chosen: [GONE, JO] });
  await stale.report(TAG);
  assert.deepEqual(stale.calls, [{ kind: "track", options: { members: [JO] } }]);
  const gone = harness({ members: [SAM, JO], chosen: [GONE] });
  await gone.report(TAG);
  assert.deepEqual(gone.calls, [{ kind: "track", options: { members: [SAM] } }]);
});

test("whose API key the player reports with doesn't change whom a cartridge starts for", async () => {
  const h = harness({ members: [SAM, JO], chosen: [JO] });
  await h.report(TAG, SAM);
  assert.deepEqual(h.calls, [{ kind: "track", options: { members: [JO] } }]);
});

test("an insert takes over a session only when all its members are in it; eject ends it for everyone", async () => {
  const h = harness({ members: [SAM, JO, KIM], chosen: [SAM, JO] });
  const jos = h.session({ currentMemberIds: [JO] });
  // Only Jo is in it: a new session for both of them.
  assert.equal((await h.report(TAG)).result, "started");
  assert.deepEqual(h.calls, [{ kind: "track", options: { members: [SAM, JO] } }]);
  await h.report(null);
  h.calls.length = 0;
  const all = h.session({ currentMemberIds: [KIM, SAM, JO] });
  assert.equal((await h.report(TAG)).result, "resumed");
  assert.deepEqual(h.calls, []);
  // Out: the adopted session ends, Kim's place in it too. Jo's own runs on.
  await h.report(null);
  assert.deepEqual(h.calls, [{ kind: "end", id: all.id }]);
  assert.equal(jos.isLive, true);
});

test("a point activity is marked for the cartridge's members", async () => {
  const h = harness({ point: true, chosen: [SAM, JO] });
  assert.equal((await h.report(TAG)).result, "marked");
  assert.deepEqual(h.calls, [{ kind: "mark", options: { members: [SAM, JO] } }]);
});

test("pulling the cartridge out ends its session even once nobody is in it", async () => {
  const h = harness();
  await h.report(TAG);
  const [started] = h.sessions.values();
  started.currentMemberIds = [];
  assert.equal((await h.report(null)).result, "ended");
  assert.deepEqual(h.calls.at(-1), { kind: "end", id: started.id });
});

/** Refuses the first action outright, then starts for whom it names. */
const refuseOnce = () => {
  let refusals = 1;
  return (session, options) => {
    if (refusals-- > 0) throw Object.assign(new Error("Couldn't start"), { name: "PluginError", code: "failed" });
    return session({ currentMemberIds: options?.members ?? [] });
  };
};

test("Start in the interface starts it for the cartridge's members, not the member who pressed it", async () => {
  const h = harness({ members: [SAM, JO, KIM], chosen: [JO, KIM], refuse: refuseOnce() });
  assert.equal((await h.report(TAG)).result, "error");
  const result = await h.start(SAM);
  assert.equal(result.result, "started");
  assert.deepEqual(h.calls.at(-1), { kind: "track", options: { members: [JO, KIM] } });
});

test("Start never takes over a session its members aren't all in, even one begun since the insert", async () => {
  const h = harness({ chosen: [SAM, JO], refuse: refuseOnce() });
  await h.report(TAG);
  h.tick(60_000);
  const jos = h.session({ currentMemberIds: [JO] });
  const result = await h.start(JO);
  assert.equal(result.result, "started");
  assert.notEqual(result.sessionId, jos.id);
  assert.deepEqual(h.calls.at(-1), { kind: "track", options: { members: [SAM, JO] } });
});

/** A start the host gave up waiting for after 10 s (`unavailable`), which ran all the same, from when it was asked. */
const lateStart = (session, options, advance) => {
  session({ currentMemberIds: options?.members ?? [] });
  advance(10_000);
  throw Object.assign(new Error('Action "track" timed out'), { name: "PluginError", code: "unavailable" });
};

test("a start refused but run late is the slot's: Start takes it over and eject ends it", async () => {
  const h = harness({ chosen: [SAM, JO], refuse: lateStart });
  assert.equal((await h.report(TAG)).result, "error");
  assert.deepEqual(h.slot().lateFor, [SAM, JO]);
  const [late] = h.sessions.values();
  assert.deepEqual(await h.start(KIM), { activityId: "reading", sessionId: late.id, result: "resumed" });
  assert.equal(h.calls.filter((call) => call.kind === "track").length, 1);
  await h.report(null);
  assert.deepEqual(h.calls.at(-1), { kind: "end", id: late.id });
});

test("a start refused but run late ends on eject even without Start", async () => {
  const h = harness({ chosen: [SAM, JO], refuse: lateStart });
  await h.report(TAG);
  const [late] = h.sessions.values();
  assert.equal((await h.report(null)).result, "ended");
  assert.deepEqual(h.calls.at(-1), { kind: "end", id: late.id });
});

test("eject after a start refused outright leaves later sessions running, its members' own too", async () => {
  const h = harness({
    refuse: () => {
      throw refusal("invalid");
    },
  });
  assert.equal((await h.report(TAG)).result, "error");
  assert.equal(h.slot().lateFor, null);
  h.tick(3_600_000);
  const jos = h.session({ currentMemberIds: [JO] });
  const sams = h.session({ currentMemberIds: [SAM] });
  assert.equal((await h.report(null)).result, "empty");
  assert.deepEqual(
    h.calls.filter((call) => call.kind === "end"),
    [],
  );
  assert.equal(jos.isLive, true);
  assert.equal(sams.isLive, true);
});

test("eject after a start that may have run ends only a late session started for its members", async () => {
  const h = harness({
    members: [SAM, JO, KIM],
    chosen: [SAM, JO],
    refuse: (_session, _options, advance) => {
      advance(10_000);
      throw refusal("unavailable");
    },
  });
  assert.equal((await h.report(TAG)).result, "error");
  h.tick(60_000);
  const jos = h.session({ currentMemberIds: [JO] });
  const joined = h.session({ currentMemberIds: [JO, KIM, SAM] });
  assert.equal((await h.report(null)).result, "empty");
  assert.deepEqual(
    h.calls.filter((call) => call.kind === "end"),
    [],
  );
  assert.equal(jos.isLive, true);
  assert.equal(joined.isLive, true, "Jo and Kim started it; Sam joined");
});

test("with no members known, an insert and Start send nothing, and say why once each", async () => {
  const h = harness({ chosen: [SAM] });
  h.ctx.members = [];
  assert.equal((await h.report(TAG)).result, "error");
  assert.deepEqual(h.calls, []);
  assert.equal(h.slot().outcome, "error");
  assert.equal(h.slot().error, "Nothing started: this Drift Beacon doesn't say who's in the workspace");
  assert.equal(h.slot().lateFor, null);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /^Didn't start Reading: the workspace's members aren't known/);
  await assert.rejects(h.start(SAM), {
    code: "invalid",
    message: "Nothing started: this Drift Beacon doesn't say who's in the workspace",
  });
  assert.deepEqual(h.calls, []);
  assert.equal(h.warnings.length, 2);
  // A live session of the activity is never taken over for nobody.
  h.session({ currentMemberIds: [JO] });
  await h.report(null);
  await h.report(TAG);
  assert.equal(h.slot().sessionId, null);
  assert.deepEqual(h.calls, []);
});

test("a hub that sends no roster at all is the same: nothing is sent", async () => {
  const h = harness({ chosen: [SAM] });
  h.ctx.members = undefined;
  assert.equal((await h.report(TAG)).result, "error");
  await assert.rejects(h.start(SAM), { code: "invalid" });
  assert.deepEqual(h.calls, []);
  assert.equal(h.warnings.length, 2);
});

/* ---- Labels and members ---- */

test("a cartridge labelled for the first time tracks for the member who labels it", async () => {
  const h = harness({ members: [SAM, JO] });
  await h.label(NEW_TAG, JO);
  assert.deepEqual(h.chosen(NEW_TAG), [JO]);
  // A label the request picks for wins.
  await h.label("04:44:55:66", JO, [SAM, SAM]);
  assert.deepEqual(h.chosen("04:44:55:66"), [SAM]);
  // Labelled by someone the hub has no longer as a member: nobody is picked, so it tracks for the owner.
  await h.label("04:77:88:99", GONE);
  assert.deepEqual(h.chosen("04:77:88:99"), []);
});

test("a first label whose record write storage refused still picks the labeller when asked again", async () => {
  const h = harness({ members: [SAM, JO] });
  await h.report(NEW_TAG);
  assert.equal(h.slot().outcome, "unknown");
  h.refuseWrite.add(STORAGE_KEYS.player);
  await assert.rejects(h.label(NEW_TAG, JO), { code: "failed" });
  await h.label(NEW_TAG, JO);
  assert.deepEqual(h.chosen(NEW_TAG), [JO]);
});

test("a cartridge labelled again keeps whom it tracks for", async () => {
  const h = harness({ members: [SAM, JO, KIM], chosen: [SAM, KIM] });
  h.ctx.activities.get = (id) => (id === "reading" || id === "gym" ? { ...h.activity, id } : undefined);
  const result = await h.request("label", { tag: TAG, activityId: "gym" }, JO);
  assert.equal(result.previous, "reading");
  assert.deepEqual(h.chosen(), [SAM, KIM]);
});

test("members: picked people replace the cartridge's, repeats and non-members dropped, never nobody", async () => {
  const h = harness({ members: [SAM, JO, KIM] });
  assert.deepEqual(await h.members(TAG, [KIM, JO, KIM, GONE]), { tag: TAG, members: [KIM, JO] });
  assert.deepEqual(h.chosen(), [KIM, JO]);
  await assert.rejects(h.members(TAG, []), { code: "invalid", message: "Pick at least one person in this workspace" });
  await assert.rejects(h.members(TAG, [GONE]), { code: "invalid" });
  await assert.rejects(h.members(NEW_TAG, [SAM]), { code: "not-found", message: "Label this cartridge first" });
  assert.deepEqual(h.chosen(), [KIM, JO]);
});

test("members picked while the cartridge plays leave its session alone and apply the next time it goes in", async () => {
  const h = harness({ members: [SAM, JO, KIM], chosen: [SAM] });
  await h.report(TAG);
  const [playing] = h.sessions.values();
  await h.members(TAG, [JO, KIM]);
  assert.deepEqual(h.calls, [{ kind: "track", options: { members: [SAM] } }]);
  assert.deepEqual(playing.currentMemberIds, [SAM]);
  await h.report(null);
  await h.report(TAG);
  assert.deepEqual(h.calls.at(-1), { kind: "track", options: { members: [JO, KIM] } });
});
