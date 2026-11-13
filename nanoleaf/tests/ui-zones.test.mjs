// The zone screens: the model's edits (shared rules, refusals, a write the app turns down), where the fill order
// editor writes, what Controls says, that a one-zone wall draws and shows exactly as before zones, and that a wall of
// one zone renders no zone UI.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { layoutFromPanelLayout, placeLayout } from "../shared/geometry.ts";
import { initialRenderState, renderFrame } from "../shared/render.ts";
import { decideScene } from "../shared/scene.ts";
import { DEFAULT_ORDER, DEFAULT_SETTINGS, readZones, ZONE_REFUSALS } from "../shared/storage.ts";
import { renderZones } from "../shared/zone-render.ts";
import { resolveZones, zoneFills } from "../shared/zones.ts";
import { splitWallLines } from "../ui/src/components/controls/zoneLines.ts";
import { ZONE_WORDS } from "../ui/src/components/zones/words.ts";
import { drawnLevel, wallBrightness } from "../ui/src/lib/brightness.ts";
import { stepRenderState } from "../ui/src/lib/renderState.ts";
import { createZoneActions, ZoneRefused, zoneErrorText } from "../ui/src/lib/zone-actions.ts";
import {
  orderTarget,
  saveEditorOrder,
  stepZoneStates,
  drawnScenes,
  wallFillOrder,
  wallScene,
  wallZones,
  zonedRequest,
  zoneLevels,
  zoneScenes,
} from "../ui/src/lib/zones.ts";
import { createMainChannel, watchTouchStream } from "../ui/src/live-model.ts";
import { CHOOSING_GRACE_MS, createChoosing } from "../ui/src/lib/choosing.ts";
import { createNumberingHold } from "../ui/src/lib/numbering.ts";
import { escapeEndsChoosing, focusIsLost, refocusAfterEnd } from "../ui/src/lib/choosingFocus.ts";
import { personKey } from "../ui/src/components/zones/personKeys.ts";
import { tileFollowing, tileStep } from "../ui/src/components/controls/tileJudge.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const T0 = Date.parse("2026-09-30T10:00:00.000Z");

const ROSTER = [
  { id: "rich", name: "Rich", role: "OWNER" },
  { id: "sam", name: "Sam", role: "MEMBER" },
  { id: "alex", name: "Alex", role: "MEMBER" },
];

const fixture = (name) => {
  const info = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
  return layoutFromPanelLayout(info.panelLayout ?? info, "S1", "");
};

/* ---- The model's zone edits ---- */

/** Storage `zones` as the SDK keeps it: a write applies at once, and one the app refuses is rolled back. */
function store({ refuse = null, members = ROSTER, initial = [] } = {}) {
  const writes = [];
  const box = { value: initial };
  const zones = createZoneActions({
    read: () => box.value,
    write(next) {
      const before = box.value;
      box.value = next;
      writes.push(next);
      if (!refuse) return Promise.resolve();
      box.value = before;
      return Promise.reject(new Error(refuse));
    },
    members: () => members,
  });
  return { zones, writes, box };
}

describe("the model's zone edits", () => {
  test("Split the wall: the wall stays the owner's and the new zone is the person's, with no panels yet", async () => {
    const { zones, box } = store();
    const id = await zones.addZone("sam");
    assert.equal(id, "z1");
    assert.deepEqual(box.value, [
      { id: "wall", member: "rich" },
      { id: "z1", member: "sam", panels: [] },
    ]);
  });

  test("each edit reads storage when it runs, so a drag's quick edits all land", async () => {
    const { zones, box } = store({ initial: [{ id: "wall", member: "rich" }, { id: "z1", member: "sam", panels: [] }] });
    await Promise.all([zones.movePanels("z1", [1]), zones.movePanels("z1", [2, 3])]);
    assert.deepEqual(readZones(box.value)[1].panels, [1, 2, 3]);
    await zones.movePanels("wall", [2]);
    assert.deepEqual(readZones(box.value).map((z) => z.panels), [[2], [1, 3]]);
  });

  test("a refusal writes nothing and says why in the shared words", async () => {
    const { zones, writes } = store({ initial: [{ id: "wall", member: "rich" }, { id: "z1", member: "sam" }] });
    const refused = await zones.giveZone("z1", "rich").then(
      () => assert.fail("should refuse"),
      (error) => error,
    );
    assert.ok(refused instanceof ZoneRefused);
    assert.equal(refused.refusal, "has-zone");
    assert.equal(zoneErrorText(refused), ZONE_REFUSALS["has-zone"]);
    await assert.rejects(zones.removeZone("gone"), { message: ZONE_REFUSALS["no-zone"] });
    assert.equal(writes.length, 0);
  });

  test("everyone zoned: adding another is refused, and the cards say so in the same words", async () => {
    const { zones } = store({
      initial: [{ id: "wall", member: "rich" }, { id: "z1", member: "sam" }, { id: "z2", member: "alex" }],
    });
    await assert.rejects(zones.addZone("sam"), { message: ZONE_REFUSALS["everyone-has-zone"] });
    assert.equal(ZONE_WORDS.everyoneHasOne, ZONE_REFUSALS["everyone-has-zone"]);
  });

  test("nothing to change (a panel crossed twice, a person picked again) is no refusal: it resolves, writing nothing", async () => {
    const { zones, writes } = store({ initial: [{ id: "wall", member: "rich" }, { id: "z1", member: "sam", panels: [4] }] });
    await zones.movePanels("z1", [4]);
    await zones.giveZone("z1", "alex");
    assert.equal(writes.length, 1, "only the give wrote");
  });

  test("a write the app refuses is rolled back and reads as the settings' refusals do", async () => {
    const { zones, box } = store({ refuse: "Storage is full" });
    const error = await zones.addZone("sam").then(
      () => assert.fail("should reject"),
      (e) => e,
    );
    assert.deepEqual(box.value, [], "rolled back");
    assert.equal(zoneErrorText(error), "Couldn't save that: Storage is full");
  });

  test("the unsplit wall's picker goes through the same rules: refused on a split wall", async () => {
    const { zones, box } = store({ initial: [] });
    await zones.saveZoneMember("sam");
    assert.deepEqual(box.value, [{ id: "wall", member: "sam" }]);
    const split = store({ initial: [{ id: "wall", member: "rich" }, { id: "z1", member: "sam" }] });
    await assert.rejects(split.zones.saveZoneMember("alex"), { message: ZONE_REFUSALS["split-wall"] });
  });

  test("no roster: nothing to edit zones for", async () => {
    const { zones } = store({ members: [] });
    await assert.rejects(zones.addZone("sam"), { message: ZONE_REFUSALS["no-roster"] });
  });
});

/* ---- Where the fill order editor writes ---- */

describe("the zone the fill order editor writes to", () => {
  test("an unsplit wall writes the wall's order, as before zones", () => {
    const zones = resolveZones([], [1, 2], ROSTER, DEFAULT_ORDER);
    assert.equal(orderTarget([], zones, zones[0].id), null);
    assert.equal(orderTarget([{ id: "wall", member: "sam" }], zones, "wall"), null);
  });

  test("a lone zone that kept its own order (from when the wall was split) writes that order", () => {
    const stored = [{ id: "wall", member: "rich", order: { ...DEFAULT_ORDER, auto: "top-down" } }];
    const zones = resolveZones(stored, [1, 2], ROSTER, DEFAULT_ORDER);
    assert.equal(orderTarget(stored, zones, "wall"), "wall");
  });

  test("a lone zone with its own order and no roster: the zone's order, refused in words the toast shows", async () => {
    const stored = [{ id: "wall", member: null, order: { ...DEFAULT_ORDER, auto: "top-down" } }];
    const zones = resolveZones(stored, [1, 2], [], DEFAULT_ORDER);
    assert.equal(zones[0].order.auto, "top-down", "the drawing shows the zone's own order");
    const to = orderTarget(stored, zones, "wall");
    assert.equal(to, "wall", "so the editor writes there, never the wall's order nothing would show");
    const { zones: edits, writes } = store({ members: [], initial: stored });
    const calls = [];
    const actions = { saveOrder: async () => void calls.push("saveOrder"), setZoneOrder: edits.setZoneOrder };
    const error = await saveEditorOrder(actions, to, { ...DEFAULT_ORDER, auto: "left-right" }).then(
      () => assert.fail("refused"),
      (e) => e,
    );
    assert.deepEqual(calls, []);
    assert.equal(writes.length, 0);
    // WallSection's toast: refusedText("the order", error).
    assert.equal(`Couldn't save the order: ${error.message}`, `Couldn't save the order: ${ZONE_REFUSALS["no-roster"]}`);
    // A lone zone with no order of its own, roster or not: the wall's order, as before zones.
    const plain = [{ id: "wall", member: null }];
    assert.equal(orderTarget(plain, resolveZones(plain, [1, 2], [], DEFAULT_ORDER), "wall"), null);
  });

  test("on a split wall, the selected zone's own order", () => {
    const stored = [{ id: "wall", member: "rich" }, { id: "z1", member: "sam", panels: [2] }];
    const zones = resolveZones(stored, [1, 2], ROSTER, DEFAULT_ORDER);
    assert.equal(orderTarget(stored, zones, "z1"), "z1");
    assert.equal(orderTarget(stored, zones, "wall"), "wall");
  });

  test("the editor's save and previews: an unsplit wall's go to saveOrder and carry no zone; a split wall's the reverse", async () => {
    const calls = [];
    const actions = {
      saveOrder: async (order) => void calls.push(["saveOrder", order.auto]),
      setZoneOrder: async (id, order) => void calls.push(["setZoneOrder", id, order.auto]),
    };
    const order = { ...DEFAULT_ORDER, auto: "left-right" };
    // Unsplit: the target is null (WallSection's `target` is null too), so the wall's order and bare requests.
    const one = resolveZones([], [1, 2], ROSTER, DEFAULT_ORDER);
    await saveEditorOrder(actions, orderTarget([], one, one[0].id), order);
    for (const mode of ["fill", "order", "draft", "identify"]) {
      assert.deepEqual(zonedRequest({ mode }, null), { mode });
    }
    // Split, the selected zone: its own order, and its id on a fill, a sweep and tap to order (identify stays bare).
    const stored = [{ id: "wall", member: "rich" }, { id: "z1", member: "sam", panels: [2] }];
    const two = resolveZones(stored, [1, 2], ROSTER, DEFAULT_ORDER);
    await saveEditorOrder(actions, orderTarget(stored, two, "z1"), order);
    assert.deepEqual(calls, [
      ["saveOrder", "left-right"],
      ["setZoneOrder", "z1", "left-right"],
    ]);
    for (const mode of ["fill", "order", "draft"]) assert.deepEqual(zonedRequest({ mode }, "z1"), { mode, zoneId: "z1" });
    assert.deepEqual(zonedRequest({ mode: "identify", panelIds: [2] }, "z1"), { mode: "identify", panelIds: [2] });
    // The source holds WallSection to these (a test can't press its buttons without a DOM).
    const source = readFileSync(new URL("../ui/src/components/wall/WallSection.tsx", import.meta.url), "utf8");
    assert.match(source, /saveEditorOrder\(actions, to, next\)/);
    assert.match(source, /zonedRequest\(request, target\)/);
    assert.match(source, /const target = split \? editZoneId : null;/);
  });

  test("every reader follows the order the editor writes: a lone zone's own, else the wall's", () => {
    const own = { ...DEFAULT_ORDER, auto: "top-down" };
    assert.equal(wallFillOrder({ zones: [], members: ROSTER, order: DEFAULT_ORDER, layout: null }), DEFAULT_ORDER);
    assert.deepEqual(
      wallFillOrder({ zones: [{ id: "wall", member: "rich", order: own }], members: ROSTER, order: DEFAULT_ORDER, layout: null }),
      own,
    );
  });
});

/* ---- Controls ---- */

describe("Controls on a split wall", () => {
  test("unsplit: nothing new is said and no row dims", () => {
    for (const heard of [false, true]) {
      assert.deepEqual(splitWallLines(false, false, heard), { touch: null, swipe: null, swipesDimmed: false });
    }
  });

  test("touch stream silent: swipes do nothing and their rows dim", () => {
    assert.deepEqual(splitWallLines(true, true, false), {
      touch: "A tap or double tap acts for the zone you touch.",
      swipe: "Swipes do nothing on a split wall until it reports where they happen.",
      swipesDimmed: true,
    });
  });

  test("touch stream heard: a swipe acts where it starts, and the rows read as normal", () => {
    assert.deepEqual(splitWallLines(true, true, true), {
      touch: "A tap or double tap acts for the zone you touch.",
      swipe: "A swipe acts for the zone it starts in.",
      swipesDimmed: false,
    });
  });

  test("a second zone with no panels yet: a swipe nothing places still acts in the one with panels", () => {
    assert.deepEqual(splitWallLines(true, false, false), {
      touch: "A tap or double tap acts for the zone you touch.",
      swipe: null,
      swipesDimmed: false,
    });
  });
});

/* ---- The channel: the touch stream ---- */

test("channel: the touch stream is asked for, heard from main's message, and false when main can't say", async () => {
  let listener = null;
  let answer = () => Promise.resolve({ heard: true });
  const main = {
    request: (name) => (name === "touchStream" ? answer() : Promise.reject(new Error(name))),
    onMessage: (name, cb) => {
      if (name === "touchStream") listener = cb;
      return () => {};
    },
    onResync: () => () => {},
  };
  const channel = createMainChannel(main);
  assert.equal(await channel.touchStream(), true);
  answer = () => Promise.reject(Object.assign(new Error("old main"), { code: "unavailable" }));
  assert.equal(await channel.touchStream(), false);
  const heard = [];
  channel.onTouchStream((h) => heard.push(h));
  listener({ heard: true });
  listener({ heard: false });
  assert.deepEqual(heard, [true, false]);
});

test("channel: a preview carries its zone to main, and an unsplit wall's carries none", async () => {
  const sent = [];
  const main = {
    request: async (name, input) => {
      sent.push(input);
      return { shown: true };
    },
    onMessage: () => () => {},
    onResync: () => () => {},
  };
  const channel = createMainChannel(main);
  await channel.preview({ mode: "fill", fraction: 0.4 });
  await channel.preview({ mode: "order", zoneId: "z1" });
  await channel.preview({ mode: "zones" });
  assert.deepEqual(sent, [{ mode: "fill", fraction: 0.4 }, { mode: "order", zoneId: "z1" }, { mode: "zones" }]);
});

/* ---- One zone draws exactly as the wall did before zones ---- */

describe("a one-zone wall draws as before zones", () => {
  const layout = fixture("theduck");
  const placed = placeLayout(layout, 0);
  const deepWork = {
    id: "deep-work",
    name: "Deep work",
    trackingType: "span",
    color: "#38bdf8",
    iconPath: null,
    archived: false,
    goal: { type: "duration", seconds: 7200 },
    period: null,
    pinned: false,
  };
  const reading = { ...deepWork, id: "reading", color: "#f472b6", goal: null, pinned: true };
  const live = {
    id: "s1",
    activityId: "deep-work",
    type: "span",
    status: "live",
    startedAt: new Date(T0 - 40 * 60_000),
    endedAt: null,
    memberIds: ["rich"],
    currentMemberIds: ["rich"],
  };
  const model = (sessions) => ({
    activities: [deepWork, reading],
    sessions,
    settings: DEFAULT_SETTINGS,
    control: null,
    zones: [],
    members: ROSTER,
    order: DEFAULT_ORDER,
    layout,
  });

  test("frames, step by step through a fill, a restarted sweep and a draft, are the engine's own", () => {
    const m = model([live]);
    const zones = wallZones(m);
    assert.equal(zones.length, 1);
    const fills = zoneFills(zones, placed.panels);
    assert.ok(fills[0].order.length >= 5, "a real wall");
    const scene = decideScene({ ...m, now: T0, following: ["rich"] });
    const previews = [
      null,
      { mode: "fill", fraction: 0.3, rgb: null },
      { mode: "order", rgb: null },
      { mode: "order", rgb: null },
      { mode: "draft", panelIds: [fills[0].order[0]], rgb: null },
      null,
    ];
    let before = initialRenderState(scene, T0);
    let after = null;
    let last = null;
    previews.forEach((preview, i) => {
      const t = T0 + i * 700;
      const scenes = zoneScenes(m, zones, t);
      assert.deepEqual(scenes[0].scene, decideScene({ ...m, now: t, following: ["rich"] }));
      const fresh = preview !== last;
      last = preview;
      before = stepRenderState(before, scenes[0].scene, preview, fresh, t);
      after = stepZoneStates(after, scenes, { preview, zoneId: null }, fresh, t);
      for (const dt of [0, 120, 450]) {
        const old = renderFrame(before, fills[0].order, t + dt, { spans: fills[0].spans });
        const now = renderZones(after, fills, t + dt);
        assert.deepEqual(now, old, `step ${i} at +${dt} ms`);
      }
    });
  });

  test("its brightness is the wall's: Session, Pinned, a preview, tap to order and a dragged slider", () => {
    for (const sessions of [[live], []]) {
      const m = model(sessions);
      const scenes = zoneScenes(m, wallZones(m), T0);
      const pinned = scenes[0].scene.kind === "pinned";
      const cases = [
        [null, null],
        [{ mode: "fill", fraction: 0.5, rgb: null }, null],
        [{ mode: "draft", panelIds: [], rgb: null }, null],
        [null, 42],
      ];
      for (const [preview, dragged] of cases) {
        const levels = zoneLevels(DEFAULT_SETTINGS, wallZones(m), scenes, { preview, zoneId: null }, dragged);
        assert.equal(levels.level, drawnLevel(wallBrightness(DEFAULT_SETTINGS, pinned, preview?.mode ?? null, dragged)));
        for (const scale of levels.scales?.values() ?? []) assert.equal(scale, 1);
      }
    }
  });

  test("split, a zone that needs less than the wall is scaled down against it", () => {
    const m = { ...model([live]), zones: [{ id: "wall", member: "rich" }, { id: "z1", member: "sam", panels: [placed.panels[0].id] }] };
    const zones = wallZones(m);
    const scenes = zoneScenes(m, zones, T0);
    assert.deepEqual(scenes.map((s) => s.scene.kind), ["live", "pinned"]);
    const levels = zoneLevels(DEFAULT_SETTINGS, zones, scenes, { preview: null, zoneId: null }, null);
    assert.equal(levels.brightness, DEFAULT_SETTINGS.maxBrightness);
    assert.equal(levels.scales.get("wall"), 1);
    assert.equal(levels.scales.get("z1"), DEFAULT_SETTINGS.pinnedBrightness / DEFAULT_SETTINGS.maxBrightness);
  });

  test("a second zone with no panels yet never decides what the wall shows or how bright it is drawn", () => {
    const sams = { ...live, id: "s2", activityId: "reading", startedAt: new Date(T0), memberIds: ["sam"], currentMemberIds: ["sam"] };
    const split = { ...model([live, sams]), zones: [{ id: "wall", member: "rich" }, { id: "z1", member: "sam", panels: [] }] };
    const zones = wallZones(split);
    const scenes = zoneScenes(split, zones, T0);
    // Sam's session is newer, but his zone has no panels: the wall still speaks for Rich's, as main's output does.
    assert.equal(scenes[1].scene.activityId, "reading");
    assert.equal(wallScene(zones, scenes, split.sessions).activityId, "deep-work");
    assert.deepEqual(drawnScenes(zones, scenes).map((z) => z.id), ["wall"]);
    const pinnedFirst = { ...split, sessions: [sams] };
    const pinnedScenes = zoneScenes(pinnedFirst, wallZones(pinnedFirst), T0);
    assert.equal(pinnedScenes[0].scene.kind, "pinned");
    for (const [m, s] of [
      [split, scenes],
      [pinnedFirst, pinnedScenes],
    ]) {
      const unsplit = zoneLevels(DEFAULT_SETTINGS, [wallZones(m)[0]], [s[0]], { preview: null, zoneId: null }, null);
      const levels = zoneLevels(DEFAULT_SETTINGS, wallZones(m), s, { preview: null, zoneId: null }, null);
      assert.equal(levels.level, unsplit.level, "drawn as if the empty zone weren't there");
      assert.equal(levels.brightness, s[0].scene.kind === "pinned" ? DEFAULT_SETTINGS.pinnedBrightness : DEFAULT_SETTINGS.maxBrightness);
    }
  });

  test("split, a preview plays in the zone it is for; the others keep showing their own", () => {
    const m = { ...model([live]), zones: [{ id: "wall", member: "rich" }, { id: "z1", member: "sam", panels: [placed.panels[0].id] }] };
    const zones = wallZones(m);
    const scenes = zoneScenes(m, zones, T0);
    const states = stepZoneStates(null, scenes, { preview: { mode: "fill", fraction: 1, rgb: null }, zoneId: "z1" }, true, T0);
    assert.equal(states.get("z1").preview?.mode, "fill");
    assert.equal(states.get("wall").preview, null);
  });
});

/* ---- What renders ---- */

let ui;
let dir;

before(async () => {
  const require = createRequire(join(ROOT, "package.json"));
  const esbuild = createRequire(require.resolve("vite"))("esbuild");
  const out = await esbuild.build({
    stdin: {
      contents: [
        'export { ControllerCard } from "./ui/src/components/ControllerCard.tsx";',
        'export { ControlsCard } from "./ui/src/components/controls/Controls.tsx";',
        'export { ZoneCards } from "./ui/src/components/zones/ZoneCards.tsx";',
        'export { ZoneEditingContext } from "./ui/src/components/zones/ZoneContext.ts";',
        'export { WallSection } from "./ui/src/components/wall/WallSection.tsx";',
        'export { Board } from "./ui/src/components/Board.tsx";',
        'export { PhoneTabs } from "./ui/src/components/phone/PhoneTabs.tsx";',
        'export { ModelProvider } from "./ui/src/model.ts";',
        'export { renderToStaticMarkup } from "react-dom/server";',
        'export { createElement } from "react";',
      ].join("\n"),
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    write: false,
    logLevel: "error",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await esbuild.stop();
  dir = mkdtempSync(join(tmpdir(), "nanoleaf-zones-"));
  const file = join(dir, "ui.cjs");
  writeFileSync(file, out.outputFiles[0].contents);
  ui = createRequire(import.meta.url)(file);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("what renders", () => {
  const layout = fixture("theduck");
  const ids = placeLayout(layout, 0).panels.map((p) => p.id);
  const noop = async () => {};
  const model = (patch = {}) => ({
    activities: [],
    sessions: [],
    settings: DEFAULT_SETTINGS,
    members: ROSTER,
    zones: [],
    order: DEFAULT_ORDER,
    layout,
    controller: { host: "192.168.1.40", port: 16021, name: "The Duck", model: "NL42" },
    connection: { status: "connected", name: "The Duck", host: "192.168.1.40", port: 16021, retryAt: null, events: true },
    output: { mode: "idle", activityId: null, fraction: null, inControl: false, detail: null, since: "" },
    control: null,
    mainStatus: "running",
    mainStatusReason: null,
    supportsGoals: true,
    touchStreamHeard: false,
    actions: new Proxy({}, { get: () => noop }),
    onTouch: () => () => {},
    onControllerChanged: () => () => {},
    onResync: () => () => {},
    ...patch,
  });
  /** Renders inside the wall section's zone context, as the layouts do. */
  const render = (value, component) => {
    const { createElement, ModelProvider, ZoneEditingContext, renderToStaticMarkup } = ui;
    const zones = wallZones(value);
    const editing = {
      zones,
      scenes: zoneScenes(value, zones, T0),
      split: zones.length > 1,
      choosing: null,
      choose() {},
    };
    return renderToStaticMarkup(
      createElement(
        ModelProvider,
        { value },
        createElement(ZoneEditingContext.Provider, { value: editing }, createElement(component)),
      ),
    );
  };
  const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  test("a one-zone wall renders no zone UI but Split the wall, beside This wall follows", (t) => {
    t.mock.method(Date, "now", () => T0);
    const one = model();
    const card = text(render(one, ui.ControllerCard));
    assert.match(card, /This wall follows/);
    assert.match(card, /Split the wall/);
    assert.equal(render(one, ui.ZoneCards), "");
    const controls = text(render(one, ui.ControlsCard));
    assert.doesNotMatch(controls, /zone|Swipes do nothing|A swipe acts/);
    assert.doesNotMatch(render(one, ui.ControlsCard), /opacity-45/);
  });

  test("a workspace of one, or no roster: nothing about zones at all", (t) => {
    t.mock.method(Date, "now", () => T0);
    for (const members of [ROSTER.slice(0, 1), []]) {
      const m = model({ members });
      const all = text(render(m, ui.ControllerCard) + render(m, ui.ZoneCards) + render(m, ui.ControlsCard));
      assert.doesNotMatch(all, /Split the wall|zone|This wall follows/);
    }
  });

  test("a split wall: zone cards in place of the picker, and Controls says how touches act", (t) => {
    t.mock.method(Date, "now", () => T0);
    const split = model({
      zones: [{ id: "wall", member: "rich" }, { id: "z1", member: "sam", panels: [ids[0]] }, { id: "z2", member: "alex", panels: [] }],
    });
    const card = text(render(split, ui.ControllerCard));
    assert.doesNotMatch(card, /This wall follows|Split the wall/);
    const cards = text(render(split, ui.ZoneCards));
    assert.match(cards, /Rich .*Sam .*1 panel .*Alex No panels yet/);
    assert.match(cards, /Everyone has a zone already\./);
    const controls = render(split, ui.ControlsCard);
    assert.match(text(controls), /A tap or double tap acts for the zone you touch\./);
    assert.match(text(controls), /Swipes do nothing on a split wall until it reports where they happen\./);
    assert.equal(controls.match(/opacity-45/g)?.length, 4);
    const heard = render({ ...split, touchStreamHeard: true }, ui.ControlsCard);
    assert.match(text(heard), /A swipe acts for the zone it starts in\./);
    assert.doesNotMatch(heard, /opacity-45/);
  });
});

/* ---- A zone's person, by keyboard ---- */

describe("a zone's person choice by keyboard", () => {
  const options = [{ id: "sam" }, { id: "alex" }];

  test("an arrow onto someone else gives them the zone", () => {
    assert.deepEqual(personKey("ArrowRight", 0, options, "sam"), { focus: 1, pick: "alex" });
    assert.deepEqual(personKey("End", 0, options, "sam"), { focus: 1, pick: "alex" });
  });

  test("landing on the person already chosen picks nobody, so nothing is refused", () => {
    assert.deepEqual(personKey("ArrowRight", 0, [{ id: "sam" }], "sam"), { focus: 0, pick: null }, "the only option");
    assert.deepEqual(personKey("Home", 0, options, "sam"), { focus: 0, pick: null });
    assert.deepEqual(personKey("End", 1, options, "alex"), { focus: 1, pick: null });
    assert.equal(personKey("a", 0, options, "sam"), null, "not a key it moves on");
  });
});

/* ---- The Controls tile on a split wall ---- */

describe("the Controls tile judges a split wall by the zone main acted in", () => {
  const deepWork = { id: "deep-work", name: "Deep work", trackingType: "span", color: "#38bdf8", archived: false, pinned: false };
  const guitar = { ...deepWork, id: "guitar", color: "#f472b6" };
  const live = (id, activityId, member) => ({
    id,
    activityId,
    type: "span",
    status: "live",
    startedAt: new Date(T0),
    endedAt: null,
    memberIds: [member],
    currentMemberIds: [member],
  });
  const base = {
    activities: [deepWork, guitar],
    sessions: [live("s1", "deep-work", "rich"), live("s2", "guitar", "sam")],
    settings: DEFAULT_SETTINGS,
    members: ROSTER,
    order: DEFAULT_ORDER,
    layout: fixture("theduck"),
  };
  const ids = placeLayout(base.layout, 0).panels.map((p) => p.id);

  test("unsplit: the touch, for the member the wall follows, as before zones; the zone message is not needed", () => {
    const m = { ...base, zones: [] };
    assert.deepEqual(tileFollowing(m, { via: "touch", panel: -1 }), ["rich"]);
    assert.equal(tileFollowing(m, { via: "zone", zoneId: "wall" }), undefined);
    assert.equal(tileStep(m, "swipe-down", ["rich"])?.activityId, "deep-work");
  });

  test("split: a swipe (-1 in the touch event) is judged in the zone main names, and nowhere when it names none", () => {
    const m = { ...base, zones: [{ id: "wall", member: "rich" }, { id: "z1", member: "sam", panels: [ids[0]] }] };
    assert.equal(tileFollowing(m, { via: "touch", panel: -1 }), undefined, "the touch event alone can't place it");
    assert.equal(tileFollowing(m, { via: "touch", panel: ids[0] }), undefined);
    const sam = tileFollowing(m, { via: "zone", zoneId: "z1" });
    assert.deepEqual(sam, ["sam"]);
    assert.deepEqual(tileStep(m, "swipe-down", sam), { kind: "stop", sessionId: "s2", activityId: "guitar" });
    assert.equal(tileFollowing(m, { via: "zone", zoneId: null }), null);
    assert.equal(tileStep(m, "swipe-down", null), null);
  });
});

/* ---- Choosing panels ---- */

describe("choosing panels for a zone", () => {
  const two = (sam) => [
    { id: "wall", member: "rich", following: ["rich"], panels: [1, 2, 3].filter((p) => !sam.includes(p)), order: DEFAULT_ORDER, position: 0 },
    { id: "z1", member: "sam", following: ["sam"], panels: sam, order: DEFAULT_ORDER, position: 1 },
  ];
  function setup({ canWall = true } = {}) {
    const log = [];
    const timers = [];
    const numbering = [];
    const hold = createNumberingHold((on) => numbering.push(on));
    const choosing = createChoosing({
      showWall: (request) => log.push(["wall", request]),
      hold: (on) => hold.set("choosing", on),
      changed: (state) => log.push(["state", state.zoneId, [...state.painting]]),
      movePanels: async (zoneId, panelIds) => void log.push(["move", zoneId, [...panelIds]]),
      refused: (error) => log.push(["refused", error.message]),
      pulse: () => {},
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      clearTimeout: () => {},
    });
    choosing.setCanWall(canWall);
    choosing.setZones(two([]));
    return { choosing, log, numbering, timers, hold };
  }
  const moves = (log) => log.filter((e) => e[0] === "move").map((e) => e.slice(1));

  test("it holds the zones preview and numbering from start to end", () => {
    const { choosing, log, numbering } = setup();
    choosing.start("z1");
    assert.deepEqual(log.slice(-1), [["wall", { mode: "zones" }]]);
    assert.deepEqual(numbering, [true]);
    choosing.end();
    assert.deepEqual(log.slice(-1), [["wall", null]]);
    assert.deepEqual(numbering, [true, false]);
    choosing.end();
    assert.deepEqual(numbering, [true, false], "ending twice says nothing more");
  });

  test("a tap brings a panel in; a tap on one of its own gives it back to the first other zone; a wall touch brings one in", async () => {
    const { choosing, log } = setup();
    choosing.start("z1");
    choosing.tap(2);
    choosing.setZones(two([2]));
    choosing.tap(2);
    choosing.touch(3);
    choosing.touch(2);
    choosing.tap(99);
    await Promise.resolve();
    assert.deepEqual(moves(log), [
      ["z1", [2]],
      ["wall", [2]],
      ["z1", [3]],
    ]);
  });

  test("a drag across panels shows them at once and saves them in one write; a press without a drag is a tap", async () => {
    const { choosing, log } = setup();
    choosing.start("z1");
    choosing.down(1);
    choosing.drag(2);
    choosing.drag(3);
    assert.deepEqual(choosing.state.painting, [1, 2, 3]);
    choosing.up(true);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(moves(log), [["z1", [1, 2, 3]]]);
    assert.deepEqual(choosing.state.painting, []);
    choosing.down(1);
    choosing.up(true);
    choosing.down(2);
    choosing.up(false);
    await Promise.resolve();
    assert.deepEqual(moves(log).slice(1), [["z1", [1]]], "the release outside the drawing does nothing");
  });

  const ends = (why, act) =>
    test(`it ends, letting go of the preview and numbering, when ${why}`, () => {
      const { choosing, log, numbering } = setup();
      choosing.start("z1");
      act(choosing);
      assert.equal(choosing.state.zoneId, null);
      assert.deepEqual(log.slice(-1), [["wall", null]]);
      assert.deepEqual(numbering, [true, false]);
    });
  ends("the drawing's tab is left", (c) => c.setShown(false));
  ends("the section unmounts", (c) => c.end());
  ends("its zone is removed elsewhere", (c) => c.setZones([two([])[0], { ...two([])[1], id: "z9" }]));
  ends("the wall is one zone again", (c) => c.setZones([two([])[0]]));

  test("a zone just added has a moment to appear before choosing gives up on it", () => {
    const { choosing, timers } = setup();
    choosing.start("z2");
    assert.equal(timers.at(-1).ms, CHOOSING_GRACE_MS);
    choosing.setZones(two([]));
    assert.equal(choosing.state.zoneId, "z2", "not there yet, still waiting");
    timers.at(-1).fn();
    assert.equal(choosing.state.zoneId, null);
  });

  test("without a wall to drive the preview stays off, and comes on with it", () => {
    const { choosing, log } = setup({ canWall: false });
    choosing.start("z1");
    assert.deepEqual(log.slice(-1), [["wall", null]]);
    choosing.setCanWall(true);
    assert.deepEqual(log.slice(-1), [["wall", { mode: "zones" }]]);
  });

  test("numbering is held by tap to order and choosing alike, and said again on a resync", () => {
    const sent = [];
    const hold = createNumberingHold((on) => sent.push(on));
    hold.resend();
    hold.set("draft", true);
    hold.set("choosing", true);
    hold.set("draft", false);
    hold.resend();
    hold.set("choosing", false);
    hold.resend();
    assert.deepEqual(sent, [true, true, false]);
    hold.set("choosing", true);
    hold.release();
    assert.deepEqual(sent, [true, true, false, true, false]);
  });
});

/* ---- The touch stream: the newest information wins ---- */

test("a touch stream answer older than main's message is dropped", async () => {
  let answer;
  let told = null;
  let resynced = null;
  const channel = {
    touchStream: () => new Promise((resolve) => (answer = resolve)),
    onTouchStream: (fn) => ((told = fn), () => {}),
    onResync: (fn) => ((resynced = fn), () => {}),
  };
  const seen = [];
  const stop = watchTouchStream(channel, (heard) => seen.push(heard));
  told(true);
  answer(false);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(seen, [true], "the answer to the question asked before the message is dropped");
  resynced();
  answer(false);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(seen, [true, false], "a question asked after it is answered");
  stop();
});

/* ---- The wall section hands its zones to the cards, on the board and on the phone's Wall tab ---- */

describe("the wall section provides the zones to the layouts' cards", () => {
  const layout = fixture("theduck");
  const ids = placeLayout(layout, 0).panels.map((p) => p.id);
  const noop = async () => {};
  const split = {
    activities: [],
    sessions: [],
    settings: DEFAULT_SETTINGS,
    members: ROSTER,
    zones: [{ id: "wall", member: "rich" }, { id: "z1", member: "sam", panels: [ids[0]] }],
    order: DEFAULT_ORDER,
    layout,
    controller: { host: "192.168.1.40", port: 16021, name: "The Duck", model: "NL42" },
    connection: { status: "connected", name: "The Duck", host: "192.168.1.40", port: 16021, retryAt: null, events: true },
    output: { mode: "idle", activityId: null, fraction: null, inControl: true, detail: null, since: "" },
    control: null,
    mainStatus: "running",
    mainStatusReason: null,
    supportsGoals: true,
    touchStreamHeard: false,
    actions: new Proxy({}, { get: () => noop }),
    onTouch: () => () => {},
    onGestureZone: () => () => {},
    onControllerChanged: () => () => {},
    onResync: () => () => {},
  };
  // Just enough of a window for the layouts' first render (their effects never run on the server).
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const fakeWindow = {
    innerHeight: 900,
    matchMedia: () => media,
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  const render = (value, element) => {
    const { ModelProvider, renderToStaticMarkup, createElement } = ui;
    globalThis.window = fakeWindow;
    try {
      return renderToStaticMarkup(createElement(ModelProvider, { value }, element));
    } finally {
      delete globalThis.window;
    }
  };
  const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  test("the board: zone cards in the side column, no Now card, no picker", (t) => {
    t.mock.method(Date, "now", () => T0);
    const { createElement, WallSection, Board } = ui;
    const html = render(
      split,
      createElement(WallSection, { cap: 300, sky: true, arrange: (parts) => createElement(Board, { parts }) }),
    );
    assert.match(html, /data-zone-cards/);
    assert.match(text(html), /Rich .*Sam 1 panel/);
    assert.doesNotMatch(text(html), /This wall follows|Now on your wall/);
    const one = render(
      { ...split, zones: [] },
      createElement(WallSection, { cap: 300, sky: true, arrange: (parts) => createElement(Board, { parts }) }),
    );
    assert.doesNotMatch(one, /data-zone-cards/);
    assert.match(text(one), /This wall follows.*Split the wall/);
    assert.match(text(one), /Now on your wall/);
  });

  test("the phone's Wall tab: the zone cards under the small wall", (t) => {
    t.mock.method(Date, "now", () => T0);
    const { createElement, PhoneTabs } = ui;
    const html = render(split, createElement(PhoneTabs, { cap: 300, notices: null, setup: null }));
    assert.match(html, /data-zone-cards/);
    assert.match(text(html), /Sam 1 panel/);
    assert.doesNotMatch(text(html), /This wall follows/);
  });
});

test("a touch stream answer to an older question never overwrites a newer one's", async () => {
  const answers = [];
  let resynced = null;
  const channel = {
    touchStream: () => new Promise((resolve) => answers.push(resolve)),
    onTouchStream: () => () => {},
    onResync: (fn) => ((resynced = fn), () => {}),
  };
  const seen = [];
  const stop = watchTouchStream(channel, (heard) => seen.push(heard));
  resynced();
  // The second question is answered first (heard); the first one's late failure (not heard) is dropped.
  answers[1](true);
  await Promise.resolve();
  await Promise.resolve();
  answers[0](false);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(seen, [true]);
  stop();
});

test("the drawing's words while choosing: tap only where a drag would pan (zoomed, touch), else tap or drag", async () => {
  const { choosingLabel } = await import("../ui/src/components/wall/zoneMarks.ts");
  assert.equal(choosingLabel("Sam", true, true), "Your wall: tap panels to bring them into Sam's zone");
  for (const [zoomed, coarse] of [
    [false, true],
    [false, false],
    [true, false],
  ]) {
    assert.equal(
      choosingLabel("Sam", zoomed, coarse),
      "Your wall: tap or drag across panels to bring them into Sam's zone",
      `zoomed ${zoomed}, coarse ${coarse}`,
    );
  }
  const source = readFileSync(new URL("../ui/src/components/wall/WallStage.tsx", import.meta.url), "utf8");
  assert.match(source, /label: choosingLabel\(choosingFor\.name, z > 1, coarse\)/);
  const canvas = readFileSync(new URL("../ui/src/components/wall/StageCanvas.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(canvas, /tap or drag across panels/, "the canvas says only what it is given");
});

describe("focus around choosing panels", () => {
  const body = { isConnected: true, closest: () => null };
  const live = { isConnected: true, closest: () => null };
  const leaving = { isConnected: true, closest: (s) => (s === "[data-exiting]" ? {} : null) };
  const gone = { isConnected: false, closest: () => null };

  test("lost: nothing focused, the page, an element gone, or one on its way out", () => {
    assert.equal(focusIsLost(null, body), true);
    assert.equal(focusIsLost(body, body), true);
    assert.equal(focusIsLost(gone, body), true);
    assert.equal(focusIsLost(leaving, body), true, "a chip in a closing \"Whose zone?\"");
    assert.equal(focusIsLost(live, body), false, "the brightness slider, say");
  });

  test("an end the person didn't make leaves focus on a live control; Escape from the drawing or a lost focus moves it", () => {
    assert.equal(refocusAfterEnd(false, false), false, "grace ran out, or the zone was removed elsewhere");
    assert.equal(refocusAfterEnd(false, true), true);
    assert.equal(refocusAfterEnd(true, false), true, "the banner's Done went");
  });

  test("Escape in an open popover or menu closes that, not choosing", () => {
    assert.equal(escapeEndsChoosing(false, false), true);
    assert.equal(escapeEndsChoosing(true, false), false);
    assert.equal(escapeEndsChoosing(false, true), false);
  });
});
