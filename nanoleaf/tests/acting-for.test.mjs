import assert from "node:assert/strict";
import { test } from "node:test";
import { listen } from "../main/src/index.ts";
import { actingFor, choiceAfterPress, speaksTo } from "../shared/acting-for.ts";

const OWNER = { id: "owner", name: "Rich", role: "OWNER" };
const SAM = { id: "sam", name: "Sam", role: "MEMBER" };
const ALEX = { id: "alex", name: "Alex", role: "MEMBER" };
const ROSTER = [SAM, OWNER, ALEX];

test("the wall acts for its stored member while they are in the workspace", () => {
  assert.deepEqual(actingFor("alex", ROSTER), ["alex"]);
  assert.deepEqual(actingFor("owner", ROSTER), ["owner"]);
});

test("with nothing stored, or the stored member gone, it acts for the owner", () => {
  assert.deepEqual(actingFor(undefined, ROSTER), ["owner"]);
  assert.deepEqual(actingFor(null, ROSTER), ["owner"]);
  assert.deepEqual(actingFor("gone", ROSTER), ["owner"]);
  assert.deepEqual(actingFor(undefined, [OWNER]), ["owner"], "a workspace of one");
});

test("with no roster it acts for nobody", () => {
  assert.deepEqual(actingFor("sam", []), []);
  assert.deepEqual(actingFor(undefined, []), []);
});

test("a press in the picker writes the member pressed, and nothing for the one already followed", () => {
  assert.equal(choiceAfterPress(["sam"], "alex"), "alex", "another member replaces the one chosen");
  assert.equal(choiceAfterPress(["sam"], "sam"), null);
  // Nothing stored: the owner is followed, so pressing them writes nothing and the fallback stays unstored.
  assert.equal(choiceAfterPress(actingFor(undefined, ROSTER), "owner"), null);
  assert.equal(choiceAfterPress(actingFor(undefined, ROSTER), "sam"), "sam");
  assert.equal(choiceAfterPress([], "sam"), "sam");
});

test("a schedule flashes the wall when it speaks to the member it follows", () => {
  assert.equal(speaksTo(["sam"], ["sam"]), true);
  assert.equal(speaksTo(["owner"], ["sam"]), false, "made by someone the wall doesn't follow");
  assert.equal(speaksTo(["owner", "sam", "alex"], ["alex"]), true, "one that tells everyone");
  assert.equal(speaksTo(["sam"], []), false, "following nobody");
  assert.equal(speaksTo([], ["sam"]), false);
});

/* ---- Main's listeners (main/src/index.ts) ---- */

function listening(following) {
  const calls = [];
  const handlers = {};
  const ctx = {
    onDataChange: (fn) => void (handlers.data = fn),
    schedules: { onTriggered: (fn) => void (handlers.schedule = fn) },
    storage: { onChange: (fn) => void (handlers.storage = fn) },
  };
  const director = { alert: (id) => calls.push(["alert", id]), update: () => calls.push(["update"]) };
  const on = { controller: () => calls.push(["controller"]), settings: () => calls.push(["settings"]) };
  listen(ctx, director, () => following.now, on);
  return { calls, handlers };
}

test("main flashes the wall only for a schedule that speaks to the member it follows, read when it fires", () => {
  const following = { now: ["sam"] };
  const { calls, handlers } = listening(following);
  handlers.schedule({ activityId: "a1", members: ["owner"] });
  handlers.schedule({ activityId: "a2", members: ["sam"] });
  handlers.schedule({ activityId: "a3", members: ["owner", "sam", "alex"] });
  handlers.schedule({ activityId: "a4" });
  following.now = ["owner"];
  handlers.schedule({ activityId: "a5", members: ["owner"] });
  assert.deepEqual(calls, [
    ["alert", "a2"],
    ["alert", "a3"],
    ["alert", "a5"],
  ]);
});

test("main re-decides the scene when who the wall follows, the settings, the order or the layout change", () => {
  const { calls, handlers } = listening({ now: ["sam"] });
  for (const key of ["zones", "order", "layout", "settings", "controller", "handback"]) handlers.storage(key);
  handlers.data();
  assert.deepEqual(calls, [
    ["update"],
    ["update"],
    ["update"],
    ["settings"],
    ["update"],
    ["controller"],
    ["update"],
  ]);
});

test("main hands a schedule's members to the Director, which picks the zones they speak to", () => {
  const calls = [];
  const handlers = {};
  const ctx = {
    onDataChange() {},
    schedules: { onTriggered: (fn) => void (handlers.schedule = fn) },
    storage: { onChange() {} },
  };
  const director = { alert: (...args) => calls.push(args), update() {} };
  listen(ctx, director, () => ["sam", "alex"], { controller() {}, settings() {} });
  handlers.schedule({ activityId: "a1", members: ["alex"] });
  handlers.schedule({ activityId: "a2", members: ["owner"] });
  assert.deepEqual(calls, [["a1", ["alex"]]]);
});
