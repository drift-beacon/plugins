import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { parseSsdp } from "../main/src/nanoleaf/discovery.ts";
import { effectName, EventStream, stateAttrs, touches } from "../main/src/nanoleaf/events.ts";
import { NanoleafClient } from "../main/src/nanoleaf/http.ts";
import { ExtControlStream } from "../main/src/nanoleaf/stream.ts";
import { encodeExtControlV2, parseAnimData } from "../shared/protocol.ts";
import { LAYOUTS, startEmulator } from "../tools/fake-nanoleaf.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const duck = fixture("theduck");

/** A clock the test moves by hand, so transitions and the pairing window are exact. */
function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

/** An emulator on ephemeral ports, closed when the test ends. */
async function start(t, options = {}) {
  const emu = await startEmulator({ port: 0, wallPort: 0, udpPort: 0, quiet: true, ...options });
  t.after(() => emu.close());
  return emu;
}

async function call(emu, method, path, body) {
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const response = await fetch(`${emu.url}${path}`, { method, body: payload });
  const text = await response.text();
  let json = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, type: response.headers.get("content-type") };
}

/** Opens the pairing window and takes a token, as the plugin's pair command does. */
async function pair(emu) {
  emu.openPairing();
  const { status, json } = await call(emu, "POST", "/api/v1/new");
  assert.equal(status, 200);
  return json.auth_token;
}

/** Waits until `predicate()` is truthy, polling every 5 ms. */
async function until(predicate, what = "the condition", timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Reads an event stream, splitting it into `{ id | event, data }` blocks (comments kept in `raw`). */
function stream(port, path) {
  return new Promise((resolve, reject) => {
    const blocks = [];
    let raw = "";
    let buffer = "";
    let ended = false;
    const req = request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
        buffer += chunk;
        for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const field = (name) => new RegExp(`^${name}: ?(.*)$`, "m").exec(block)?.[1];
          const data = field("data");
          if (data === undefined) continue;
          const id = field("id");
          const event = field("event") ?? null;
          blocks.push({ id: id === undefined ? null : Number(id), event, data: JSON.parse(data) });
        }
      });
      res.on("close", () => {
        ended = true;
      });
      resolve({
        status: res.statusCode,
        type: res.headers["content-type"],
        blocks,
        raw: () => raw,
        ended: () => ended,
        close: () => req.destroy(),
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** The device's own events: `{ id, events }` per message. */
async function events(t, emu, token, ids = "1,2,3,4") {
  const sse = await stream(emu.port, `/api/v1/${token}/events?id=${ids}`);
  t.after(sse.close);
  return { ...sse, messages: () => sse.blocks.map((block) => ({ id: block.id, events: block.data.events })) };
}

async function sendUdp(port, bytes) {
  const socket = createSocket("udp4");
  await new Promise((resolve, reject) => {
    socket.send(bytes, port, "127.0.0.1", (error) => (error ? reject(error) : resolve()));
  });
  socket.close();
}

/** Sends a datagram and waits until the emulator has counted it (applied, dropped or ignored). */
async function frame(emu, bytes) {
  const before = emu.frames + emu.droppedFrames + emu.ignoredFrames;
  await sendUdp(emu.udpPort, bytes);
  await until(() => emu.frames + emu.droppedFrames + emu.ignoredFrames > before, "the frame to arrive");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const ids = (emu) => [...emu.lights().keys()];
const colours = (emu, options) => [...emu.lights(options).values()].map((light) => light.rgb);

test("pairing answers 403 until the window opens, then a token; the window closes after its time", async (t) => {
  const now = clock();
  const emu = await start(t, { now });
  assert.equal((await call(emu, "POST", "/api/v1/new")).status, 403);
  emu.openPairing(1000);
  const answer = await call(emu, "POST", "/api/v1/new");
  assert.equal(answer.status, 200);
  assert.match(answer.json.auth_token, /^[A-Za-z0-9]{32}$/);
  assert.ok(emu.tokens.has(answer.json.auth_token));
  now.advance(999);
  assert.equal((await call(emu, "POST", "/api/v1/new")).status, 200);
  now.advance(2);
  assert.equal((await call(emu, "POST", "/api/v1/new")).status, 403);
  assert.equal((await call(emu, "GET", "/api/v1/new")).status, 405);
  assert.equal(emu.tokens.size, 2);
});

test('pairing "open" always hands out tokens', async (t) => {
  const emu = await start(t, { pairing: "open" });
  const answer = await call(emu, "POST", "/api/v1/new");
  assert.equal(answer.status, 200);
  assert.equal(typeof answer.json.auth_token, "string");
});

test("a wrong or missing token gets 401; GET / is the info object; DELETE revokes and ends its streams", async (t) => {
  const emu = await start(t);
  const token = await pair(emu);
  for (const path of ["/api/v1/nope/", "/api/v1/nope/state", "/api/v1/", "/api/v1"]) {
    assert.equal((await call(emu, "GET", path)).status, 401, path);
  }
  assert.equal((await call(emu, "PUT", "/api/v1/nope/state", { on: { value: true } })).status, 401);
  const info = await call(emu, "GET", `/api/v1/${token}/`);
  assert.equal(info.status, 200);
  assert.match(info.type, /application\/json/);
  assert.deepEqual(info.json, emu.info());
  assert.equal(info.json.name, "The Duck");
  assert.deepEqual(Object.keys(info.json), Object.keys(duck));
  assert.deepEqual(info.json.panelLayout, duck.panelLayout);
  assert.deepEqual((await call(emu, "GET", `/api/v1/${token}`)).json, info.json);
  const sse = await events(t, emu, token);
  assert.equal((await call(emu, "DELETE", `/api/v1/${token}`)).status, 204);
  assert.equal(emu.tokens.has(token), false);
  assert.equal((await call(emu, "GET", `/api/v1/${token}/`)).status, 401);
  await until(sse.ended, "the revoked token's event stream to end");
  assert.equal((await call(emu, "GET", "/")).status, 404, "any HTTP answer tells a probe it's reachable");
});

test("PUT /state sets power, brightness, hue/sat and ct; GET /state/* reads them back", async (t) => {
  const emu = await start(t);
  const token = await pair(emu);
  const api = `/api/v1/${token}`;
  assert.deepEqual((await call(emu, "GET", `${api}/state/on`)).json, { value: false });
  assert.deepEqual((await call(emu, "GET", `${api}/state`)).json, emu.info().state);

  const lit = { brightness: { value: 40 }, on: { value: true } };
  assert.equal((await call(emu, "PUT", `${api}/state`, lit)).status, 204);
  assert.deepEqual((await call(emu, "GET", `${api}/state/brightness`)).json, { value: 40, max: 100, min: 0 });
  assert.deepEqual((await call(emu, "GET", `${api}/state/on`)).json, { value: true });
  assert.equal(emu.brightness(), 40);

  assert.equal((await call(emu, "PUT", `${api}/state`, { hue: { value: 120 }, sat: { value: 100 } })).status, 204);
  assert.equal((await call(emu, "GET", `${api}/state/colorMode`)).json, "hs");
  assert.deepEqual((await call(emu, "GET", `${api}/state/hue`)).json, { value: 120, max: 360, min: 0 });
  assert.equal(emu.effect(), "*Solid*");
  assert.deepEqual(new Set(colours(emu, { settled: true }).map(String)), new Set(["0,255,0"]));

  assert.equal((await call(emu, "PUT", `${api}/state`, { ct: { value: 2700 } })).status, 204);
  assert.equal((await call(emu, "GET", `${api}/state/colorMode`)).json, "ct");
  assert.deepEqual((await call(emu, "GET", `${api}/state/ct`)).json, { value: 2700, max: 6500, min: 1200 });

  assert.equal((await call(emu, "PUT", `${api}/state`, { brightness: { increment: -500 } })).status, 204);
  assert.equal(emu.brightness(), 0, "increments stop at the range");
  assert.equal((await call(emu, "PUT", `${api}/state`, { sat: { value: 250 } })).status, 204);
  assert.equal(emu.info().state.sat.value, 100, "values are clamped");

  assert.equal((await call(emu, "PUT", `${api}/state`, "nope")).status, 400);
  assert.equal((await call(emu, "PUT", `${api}/state`, {})).status, 400);
  assert.equal((await call(emu, "PUT", `${api}/state`, { brightness: { value: "x" } })).status, 422);
  assert.equal((await call(emu, "PUT", `${api}/state`, { on: { value: 1 } })).status, 422);
  assert.equal((await call(emu, "PUT", `${api}/state`, { brightness: { value: 5, duration: -1 } })).status, 422);
  assert.equal((await call(emu, "GET", `${api}/state/nope`)).status, 404);
});

test("brightness multiplies the displayed level, eases over its duration, and power off shows dark", async (t) => {
  const now = clock();
  const emu = await start(t, { now, layout: "hexagons" });
  const token = await pair(emu);
  const api = `/api/v1/${token}/state`;
  const level = (options) => [...emu.lights(options).values()][0].level;
  assert.equal(level(), 0.64);
  await call(emu, "PUT", api, { brightness: { value: 20, duration: 1 } });
  assert.equal(level(), 0.64);
  now.advance(500);
  assert.equal(level(), 0.42);
  assert.equal(level({ settled: true }), 0.2);
  now.advance(500);
  assert.equal(level(), 0.2);

  assert.equal(emu.pressPower(), false);
  assert.equal(level({ settled: true }), 0);
  now.advance(1000);
  assert.equal(level(), 0);
  assert.equal(emu.on(), false);

  await call(emu, "PUT", api, { brightness: { value: 30 } });
  assert.equal(emu.on(), true, "a brightness value turns the wall on");
  await call(emu, "PUT", api, { brightness: { value: 50 }, on: { value: false } });
  assert.equal(emu.on(), false, "unless the same body turns it off");
});

test("effects: list, select (which turns the wall on), unknown names 404, and write request/add/delete", async (t) => {
  const emu = await start(t);
  const token = await pair(emu);
  const api = `/api/v1/${token}`;
  assert.deepEqual((await call(emu, "GET", `${api}/effects/effectsList`)).json, duck.effects.effectsList);
  assert.equal((await call(emu, "GET", `${api}/effects/select`)).json, "*Solid*");
  assert.deepEqual((await call(emu, "GET", `${api}/effects`)).json, duck.effects);
  assert.equal((await call(emu, "PUT", `${api}/effects`, { select: "Nope" })).status, 404);
  assert.equal((await call(emu, "PUT", `${api}/effects`, { select: "*Static*" })).status, 404);
  assert.equal((await call(emu, "PUT", `${api}/effects`, {})).status, 400);

  assert.equal((await call(emu, "PUT", `${api}/effects`, { select: "Blaze" })).status, 204);
  assert.equal(emu.effect(), "Blaze");
  assert.equal(emu.on(), true);
  assert.equal(emu.info().state.colorMode, "effect");

  const request = await call(emu, "PUT", `${api}/effects`, { write: { command: "request", animName: "Blaze" } });
  assert.equal(request.status, 200);
  assert.equal(request.json.animName, "Blaze");
  assert.ok(Array.isArray(request.json.palette) && request.json.palette.length > 0);

  const mine = { command: "add", animName: "Mine", animType: "static", animData: "1 49632 1 1 2 3 0 1", loop: false };
  assert.equal((await call(emu, "PUT", `${api}/effects`, { write: mine })).status, 204);
  assert.ok(emu.info().effects.effectsList.includes("Mine"));
  const saved = await call(emu, "PUT", `${api}/effects`, { write: { command: "request", animName: "Mine" } });
  assert.equal(saved.json.animData, mine.animData);
  const all = await call(emu, "PUT", `${api}/effects`, { write: { command: "requestAll" } });
  assert.equal(all.json.animations.length, duck.effects.effectsList.length + 1);
  const write = (command) => call(emu, "PUT", `${api}/effects`, { write: { animName: "Mine", ...command } });
  assert.equal((await write({ command: "delete" })).status, 204);
  assert.equal(emu.info().effects.effectsList.includes("Mine"), false);
  assert.equal((await write({ command: "request" })).status, 404);
  assert.equal((await call(emu, "PUT", `${api}/effects`, { write: { command: "dance" } })).status, 400);

  assert.equal(emu.selectEffect(), emu.effect(), "the Nanoleaf app picks another effect at random");
  assert.notEqual(emu.effect(), "Blaze");
  assert.throws(() => emu.selectEffect("Nope"), RangeError);
});

test("a static display lights the listed panels, turns the others off, and reads back as *Static*", async (t) => {
  const now = clock();
  const emu = await start(t, { now });
  const token = await pair(emu);
  const api = `/api/v1/${token}/effects`;
  const [a, b, ...rest] = ids(emu);
  const animData = `3 ${a} 1 255 0 0 0 5 ${b} 1 0 255 0 0 5 0 1 9 9 9 0 5`;
  const display = { command: "display", animType: "static", animData, loop: false, palette: [], colorType: "HSB" };
  assert.equal((await call(emu, "PUT", api, { write: display })).status, 204);
  assert.equal(emu.effect(), "*Static*");
  assert.equal(emu.on(), false, "a display write doesn't turn the wall on");
  const settled = emu.lights({ settled: true });
  assert.deepEqual(settled.get(a).rgb, [255, 0, 0]);
  assert.deepEqual(settled.get(b).rgb, [0, 255, 0]);
  for (const id of rest) assert.deepEqual(settled.get(id).rgb, [0, 0, 0], `unlisted panel ${id} turns off`);
  assert.equal(settled.has(0), false, "the controller (id 0) isn't a light");
  now.advance(250);
  assert.deepEqual(emu.lights().get(a).rgb, [255, 102, 51], "halfway through its 500 ms transition");
  now.advance(250);
  assert.deepEqual(emu.lights().get(a).rgb, [255, 0, 0]);

  const back = await call(emu, "PUT", api, { write: { command: "request", animName: "*Static*" } });
  assert.equal(back.status, 200);
  assert.equal(back.json.animType, "static");
  assert.deepEqual([...parseAnimData(back.json.animData).keys()], [a, b, 0]);

  const bad = { ...display, animData: "2 1 1 255" };
  assert.equal((await call(emu, "PUT", api, { write: bad })).status, 422);
  assert.equal(emu.effect(), "*Static*");

  emu.selectEffect("Blaze");
  assert.equal((await call(emu, "PUT", api, { write: { command: "request", animName: "*Static*" } })).status, 400);
  await call(emu, "PUT", `/api/v1/${token}/state`, { hue: { value: 10 } });
  assert.equal((await call(emu, "PUT", api, { write: { command: "request", animName: "*Static*" } })).status, 404);
});

test("a custom display animates each panel's frames and loops", async (t) => {
  const now = clock();
  const emu = await start(t, { now });
  const token = await pair(emu);
  const [a, b] = ids(emu);
  const animData = `1 ${a} 2 255 0 0 0 10 0 0 255 0 10`;
  const write = { command: "display", animType: "custom", animData, loop: true, palette: [], colorType: "HSB" };
  assert.equal((await call(emu, "PUT", `/api/v1/${token}/effects`, { write })).status, 204);
  assert.equal(emu.effect(), "*Dynamic*");
  now.advance(1000);
  assert.deepEqual(emu.lights().get(a).rgb, [255, 0, 0]);
  assert.deepEqual(emu.lights().get(b).rgb, [0, 0, 0], "panels left out fade off");
  now.advance(500);
  assert.deepEqual(emu.lights().get(a).rgb, [128, 0, 128]);
  now.advance(500);
  assert.deepEqual(emu.lights().get(a).rgb, [0, 0, 255]);
  now.advance(1000);
  assert.deepEqual(emu.lights().get(a).rgb, [255, 0, 0], "it loops");
});

test("extControl v2: 204, then UDP frames apply with transitions; an unknown id drops the whole frame", async (t) => {
  const now = clock();
  const emu = await start(t, { now });
  const token = await pair(emu);
  const api = `/api/v1/${token}/effects`;
  const panels = ids(emu);
  const red = encodeExtControlV2(panels.map((id) => [id, [255, 0, 0]]), 10);

  await frame(emu, red);
  assert.equal(emu.ignoredFrames, 1, "frames before extControl are ignored");
  assert.equal(emu.frames, 0);

  const v1 = { command: "display", animType: "extControl" };
  assert.equal((await call(emu, "PUT", api, { write: v1 })).status, 400, "Shapes need v2");
  const v2 = { ...v1, extControlVersion: "v2" };
  const entered = await call(emu, "PUT", api, { write: v2 });
  assert.equal(entered.status, 204);
  assert.equal(entered.text, "");
  assert.equal(emu.effect(), "*ExtControl*");
  assert.equal((await call(emu, "GET", `/api/v1/${token}/effects/select`)).json, "*ExtControl*");

  await frame(emu, red);
  assert.equal(emu.frames, 1);
  const solid = [255, 204, 102];
  assert.deepEqual(colours(emu)[0], solid, "a transition starts from what shows");
  now.advance(500);
  assert.deepEqual(colours(emu)[0], [255, 102, 51]);
  now.advance(500);
  assert.deepEqual(new Set(colours(emu).map(String)), new Set(["255,0,0"]));

  await frame(emu, encodeExtControlV2([[panels[0], [0, 0, 255]], [0, [0, 0, 255]]], 0));
  assert.equal(emu.droppedFrames, 1, "the controller's id 0 is unknown");
  await frame(emu, encodeExtControlV2([[panels[0], [0, 0, 255]], [4242, [0, 0, 255]]], 0));
  assert.equal(emu.droppedFrames, 2);
  await frame(emu, new Uint8Array([0, 2, 1, 2, 3]));
  assert.equal(emu.droppedFrames, 3, "a malformed frame is dropped");
  assert.deepEqual(emu.lights().get(panels[0]).rgb, [255, 0, 0], "nothing from a dropped frame shows");

  await frame(emu, encodeExtControlV2([[panels[0], [0, 0, 255]]], 0));
  assert.equal(emu.frames, 2);
  assert.deepEqual(emu.lights().get(panels[0]).rgb, [0, 0, 255], "transition 0 is instant; a partial frame is fine");
  assert.deepEqual(emu.lights().get(panels[1]).rgb, [255, 0, 0], "panels left out keep their colour");

  emu.selectEffect("Blaze");
  assert.equal(emu.effect(), "Blaze");
  await frame(emu, red);
  assert.equal(emu.frames, 2, "the Nanoleaf app ended the stream");
  assert.equal(emu.ignoredFrames, 2);
});

test("extControl: false rejects streaming with 400, so the plugin's static fallback can be exercised", async (t) => {
  const emu = await start(t, { extControl: false });
  const token = await pair(emu);
  const write = { command: "display", animType: "extControl", extControlVersion: "v2" };
  assert.equal((await call(emu, "PUT", `/api/v1/${token}/effects`, { write })).status, 400);
  assert.equal(emu.effect(), "*Solid*");
});

test("SSE sends state, effects, layout and touch events in the documented format, per subscription", async (t) => {
  const emu = await start(t, { keepAliveMs: 20 });
  const token = await pair(emu);
  const all = await events(t, emu, token);
  assert.equal(all.status, 200);
  assert.match(all.type, /text\/event-stream/);
  const touches = await events(t, emu, token, "4");
  const received = (count) => until(() => all.messages().length >= count, `${count} events`);

  await call(emu, "PUT", `/api/v1/${token}/state`, { brightness: { value: 55, duration: 0 } });
  await received(1);
  assert.deepEqual(all.messages()[0], {
    id: 1,
    events: [
      { attr: 1, value: true },
      { attr: 2, value: 55 },
    ],
  });

  emu.selectEffect("Blaze");
  await received(3);
  assert.deepEqual(all.messages()[1], { id: 1, events: [{ attr: 6, value: "effect" }] });
  assert.deepEqual(all.messages()[2], { id: 3, events: [{ attr: 1, value: "Blaze" }] });

  emu.setLayout("triangles");
  await received(4);
  const layout = all.messages()[3];
  assert.equal(layout.id, 2);
  assert.equal(layout.events[0].attr, 1);
  assert.deepEqual(layout.events[0].value, fixture("wings").panelLayout.layout);
  assert.deepEqual(layout.events[1], { attr: 2, value: 299 });

  const panel = ids(emu)[0];
  emu.touch(panel);
  emu.touch(panel, "swipe-left");
  await received(6);
  assert.deepEqual(all.messages()[4], { id: 4, events: [{ gesture: 0, panelId: panel }] });
  assert.deepEqual(all.messages()[5], { id: 4, events: [{ gesture: 4, panelId: -1 }] });
  await until(() => touches.messages().length >= 2, "the touch-only stream");
  assert.deepEqual(
    touches.messages().map((message) => message.id),
    [4, 4],
  );
  assert.throws(() => emu.touch(panel, 9), RangeError);
  assert.ok(ids(emu).includes(emu.touch().panelId), "a tap without an id lands on some panel");

  await until(() => all.raw().includes(": keep-alive\n\n"), "a keep-alive comment");
  assert.match(all.raw(), /^id: 1\ndata: \{"events":\[/m);

  assert.equal((await stream(emu.port, `/api/v1/${token}/events?id=9`)).status, 400);
  assert.equal((await stream(emu.port, `/api/v1/${token}/events`)).status, 400);
  assert.equal((await stream(emu.port, "/api/v1/nope/events?id=1")).status, 401);
});

test("panelLayout endpoints, orientation writes and identify", async (t) => {
  const emu = await start(t);
  const token = await pair(emu);
  const api = `/api/v1/${token}`;
  const sse = await events(t, emu, token, "2");
  assert.deepEqual((await call(emu, "GET", `${api}/panelLayout`)).json, duck.panelLayout);
  assert.deepEqual((await call(emu, "GET", `${api}/panelLayout/layout`)).json, duck.panelLayout.layout);
  assert.deepEqual((await call(emu, "GET", `${api}/panelLayout/globalOrientation`)).json, {
    value: 59,
    max: 360,
    min: 0,
  });
  assert.equal((await call(emu, "PUT", `${api}/panelLayout`, { globalOrientation: { value: 90 } })).status, 204);
  await until(() => sse.messages().length === 1, "the layout event");
  assert.deepEqual(sse.messages()[0], { id: 2, events: [{ attr: 2, value: 90 }] });
  assert.equal(emu.info().panelLayout.globalOrientation.value, 90);
  assert.equal((await call(emu, "PUT", `${api}/identify`)).status, 204);
  assert.equal((await call(emu, "GET", `${api}/nope`)).status, 404);
});

test("each named layout loads its fixture; setLayout takes a name or info object; lights are 7/8/9 only", async (t) => {
  for (const [name, file] of Object.entries(LAYOUTS)) {
    const emu = await start(t, { layout: name });
    const expected = fixture(file);
    assert.deepEqual(emu.info().panelLayout, expected.panelLayout, name);
    assert.equal(emu.info().name, expected.name);
    const lights = expected.panelLayout.layout.positionData.filter((p) => [7, 8, 9].includes(p.shapeType));
    assert.deepEqual(ids(emu), lights.map((p) => p.panelId).sort((x, y) => x - y), name);
    await emu.close();
  }
  const emu = await start(t, { layout: fixture("minis") });
  assert.equal(emu.info().name, "Shapes Minis");
  const changes = [];
  emu.onChange((change) => changes.push(change.kind));
  emu.setLayout(fixture("wings"));
  assert.equal(emu.info().name, "Shapes Minis", "rearranging keeps the controller's identity");
  assert.equal(ids(emu).length, 9);
  assert.deepEqual(changes, ["layout"]);
  await assert.rejects(startEmulator({ layout: "nope", quiet: true }), RangeError);
  await assert.rejects(startEmulator({ pairing: "maybe", quiet: true }), RangeError);
});

test("onChange reports what happened; a failing listener doesn't break the device", async (t) => {
  const emu = await start(t);
  const seen = [];
  emu.onChange(() => {
    throw new Error("listener bug");
  });
  const stop = emu.onChange((change) => seen.push(change));
  emu.openPairing();
  emu.pressPower();
  emu.selectEffect("Jungle");
  emu.touch(ids(emu)[0], 1);
  stop();
  emu.pressPower();
  assert.deepEqual(
    seen.map((change) => change.kind),
    ["pairing", "state", "state", "effect", "touch"],
  );
  assert.deepEqual(seen[1].changed, [{ attr: 1, value: true }]);
  assert.deepEqual(seen[2].changed, [{ attr: 6, value: "effect" }], "an effect replaces the hs colour");
  assert.deepEqual([seen[3].name, seen[3].previous], ["Jungle", "*Solid*"]);
  assert.deepEqual([seen[4].panelId, seen[4].gesture], [ids(emu)[0], 1]);
});

test("the wall page: HTML, its own stream of layout, status and frames, and its buttons", async (t) => {
  const emu = await start(t);
  const page = await fetch(emu.wallUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /<svg id="wall"/);

  const wall = await stream(emu.wallPort, "/stream");
  t.after(wall.close);
  const latest = (event) => wall.blocks.filter((block) => block.event === event).at(-1)?.data;
  await until(() => latest("layout") && latest("status") && latest("frame"), "the first layout, status and frame");
  assert.equal(latest("layout").panels.length, 7);
  assert.deepEqual(latest("layout").others.map((other) => other.role), ["controller"]);
  assert.equal(latest("layout").panels[0].pts.length, 3);
  assert.equal(latest("status").name, "The Duck");
  assert.equal(latest("frame").c.split(",").length, 7);
  assert.match(latest("frame").c, /^([0-9a-f]{6},){6}[0-9a-f]{6}$/);

  const post = async (path, body) => {
    const response = await fetch(new URL(path, emu.wallUrl), { method: "POST", body: JSON.stringify(body ?? {}) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  assert.equal((await post("pair")).status, 200);
  assert.equal((await call(emu, "POST", "/api/v1/new")).status, 200, '"Hold power button" opens pairing');
  await until(() => latest("status").pairingLeft === 30, "the countdown");

  const token = [...emu.tokens][0];
  const sse = await events(t, emu, token, "3,4");
  await post("touch", { panelId: 42632, gesture: 0 });
  await post("effect", { name: "Jungle" });
  await until(() => sse.messages().length === 2, "touch and effects events");
  assert.deepEqual(sse.messages()[0], { id: 4, events: [{ gesture: 0, panelId: 42632 }] });
  assert.deepEqual(sse.messages()[1], { id: 3, events: [{ attr: 1, value: "Jungle" }] });

  assert.equal((await post("power")).json.result, false);
  assert.equal(emu.on(), false);
  assert.equal((await post("rearrange")).json.result, "triangles");
  await until(() => latest("layout").panels.length === 9, "the rearranged layout");
  assert.equal((await post("nope")).status, 404);
  assert.equal((await post("effect", { name: "Nope" })).status, 422);
});

test("SSDP answers M-SEARCH for ssdp:all and nanoleaf:nl42 with headers discovery reads, nothing else", async (t) => {
  const emu = await start(t, { ssdp: true, ssdpPort: 0, random: () => 0 });
  assert.equal(typeof emu.ssdpPort, "number");
  const socket = createSocket("udp4");
  const answers = [];
  socket.on("message", (message) => answers.push(message.toString("utf8")));
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  t.after(() => socket.close());
  const search = (st) =>
    [
      "M-SEARCH * HTTP/1.1",
      "HOST: 239.255.255.250:1900",
      'MAN: "ssdp:discover"',
      "MX: 1",
      `ST: ${st}`,
      "",
      "",
    ].join("\r\n");
  for (const st of ["ssdp:all", "nanoleaf:nl42", "nanoleaf_aurora:light", "urn:schemas-upnp-org:device:Basic:1"]) {
    socket.send(search(st), emu.ssdpPort, "127.0.0.1");
  }
  await until(() => answers.length >= 2, "two SSDP answers");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(answers.length, 2, "only ssdp:all and the model's own type are answered");
  for (const answer of answers) {
    assert.match(answer, /^HTTP\/1\.1 200 OK\r\n/);
    assert.match(answer, /\r\nST: nanoleaf:nl42\r\n/);
    assert.deepEqual(parseSsdp(answer, "127.0.0.1"), {
      host: "127.0.0.1",
      port: emu.port,
      name: "The Duck",
      model: "NL42",
      id: parseSsdp(answer, "127.0.0.1").id,
      source: "ssdp",
    });
    assert.match(parseSsdp(answer, "127.0.0.1").id, /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
  }
});

test("close() releases every port and ends streams; a clash fails with EADDRINUSE and releases the rest", async () => {
  const first = await startEmulator({ port: 0, wallPort: 0, udpPort: 0, quiet: true });
  const ports = { port: first.port, udpPort: first.udpPort, wallPort: first.wallPort, quiet: true };
  const spare = await freePort();
  let second = null;
  try {
    await assert.rejects(startEmulator(ports), { code: "EADDRINUSE" });
    await assert.rejects(startEmulator({ ...ports, port: spare }), { code: "EADDRINUSE" }, "the UDP port clashes");
    await assert.rejects(
      startEmulator({ ...ports, port: spare, udpPort: 0 }),
      { code: "EADDRINUSE" },
      "the wall port clashes",
    );
    const token = await pair(first);
    const sse = await stream(first.port, `/api/v1/${token}/events?id=1`);
    const wall = await stream(first.wallPort, "/stream");
    await first.close();
    await first.close();
    await until(() => sse.ended() && wall.ended(), "streams to end");
    second = await startEmulator({ ...ports });
    assert.equal(second.port, first.port);
    assert.equal(second.udpPort, first.udpPort);
    assert.equal(second.wallPort, first.wallPort);
    const reuse = await startEmulator({ port: spare, udpPort: 0, wallPort: null, quiet: true });
    assert.equal(reuse.port, spare, "the failed starts released the REST port they had bound");
    assert.equal(reuse.wallUrl, null);
    await reuse.close();
  } finally {
    await first.close();
    await second?.close();
  }
});

test("main's REST, event and UDP clients work against the emulator end to end", async (t) => {
  const emu = await start(t);
  assert.equal(await NanoleafClient.requestToken("127.0.0.1", emu.port), null, "the window is closed");
  assert.equal(await NanoleafClient.probe("127.0.0.1", emu.port), true);
  emu.openPairing();
  const token = await NanoleafClient.requestToken("127.0.0.1", emu.port);
  const client = new NanoleafClient({ host: "127.0.0.1", port: emu.port, token, timeoutMs: 1000 });
  const info = await client.info();
  assert.equal(info.name, "The Duck");
  assert.equal(info.effects.select, "*Solid*");
  assert.equal(info.panelLayout.positionData.length, 8);
  assert.equal(info.state.on, false);

  const received = [];
  const opened = [];
  const events = new EventStream({
    host: "127.0.0.1",
    port: emu.port,
    token,
    onEvent: (event) => received.push(event),
    onStatus: (open) => opened.push(open),
  });
  t.after(() => events.close());
  await until(() => opened.includes(true), "the event stream to open");

  await client.setState({ brightness: { value: 70, duration: 0 }, on: { value: true } });
  await client.enterExtControl();
  assert.equal(await client.select(), "*ExtControl*");
  const stream = new ExtControlStream("127.0.0.1", { port: emu.udpPort });
  t.after(() => stream.close());
  const panels = ids(emu);
  stream.send(panels.map((id) => [id, [0, 128, 255]]), 0);
  await until(() => emu.frames === 1, "the streamed frame");
  assert.deepEqual(new Set(colours(emu).map(String)), new Set(["0,128,255"]));
  assert.deepEqual((await client.state()).brightness, 70);

  const animData = `${panels.length} ${panels.map((id) => `${id} 1 10 20 30 0 5`).join(" ")}`;
  await client.write({ command: "display", animType: "static", animData, loop: false, palette: [], colorType: "HSB" });
  assert.equal(await client.requestStatic(), animData);
  emu.selectEffect("Blaze");
  assert.equal(await client.requestStatic(), null, "a dynamic effect has no static scene");
  emu.touch(panels[2], "double-tap");
  await until(() => received.some((event) => event.id === 4), "the touch event");
  assert.deepEqual(stateAttrs(received[0]), { on: true, brightness: 70 });
  assert.deepEqual(received.map(effectName).filter(Boolean), ["*ExtControl*", "*Static*", "Blaze"]);
  assert.deepEqual(touches(received.at(-1)), [{ panelId: panels[2], gesture: "double-tap" }]);
  await client.revoke();
  assert.equal(emu.tokens.size, 0);
});

/* ---- Injected faults ---- */

/** A fetch whose connection the emulator reset: resolves with the error instead of throwing. */
async function failedCall(emu, method, path, body, signal) {
  try {
    await fetch(`${emu.url}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), signal });
    return null;
  } catch (error) {
    return error;
  }
}

test("faults: dropNext resets only the matching requests, unanswered, and they never reach the device", async (t) => {
  const emu = await start(t, { pairing: "open" });
  const token = await pair(emu);
  emu.selectEffect("Northern Lights");
  const state = emu.faults({ dropNext: 1, match: { method: "PUT", path: "/effects", body: '"select"' } });
  assert.deepEqual(
    state.pending.map(({ action, left }) => ({ action, left })),
    [{ action: "reset", left: 1 }],
  );

  assert.equal((await call(emu, "GET", `/api/v1/${token}/effects/select`)).json, "Northern Lights", "no match");
  const write = { write: { command: "display", animType: "extControl", extControlVersion: "v2" } };
  assert.equal((await call(emu, "PUT", `/api/v1/${token}/effects`, write)).status, 204, "a write isn't a select");
  const error = await failedCall(emu, "PUT", `/api/v1/${token}/effects`, { select: "Blaze" });
  assert.ok(error instanceof TypeError, "the connection was reset");
  assert.equal(emu.effect(), "*ExtControl*", "the dropped select never ran");
  assert.deepEqual(
    emu.requests().at(-1),
    { method: "PUT", path: `/api/v1/${token}/effects`, status: 0, body: '{"select":"Blaze"}', reason: "fault: reset" },
  );
  assert.deepEqual(emu.faults().pending, [], "used up");
  assert.equal((await call(emu, "PUT", `/api/v1/${token}/effects`, { select: "Blaze" })).status, 204);
  assert.equal(emu.effect(), "Blaze");
});

test("faults: failNext answers failStatus without acting, then the device answers again", async (t) => {
  const emu = await start(t, { pairing: "open", faults: { failNext: 1, match: { path: "/new" } } });
  assert.equal((await call(emu, "POST", "/api/v1/new")).status, 503, "set from startEmulator's options");
  const token = await pair(emu);

  emu.faults({ failNext: 2, failStatus: 500, match: { method: "PUT", path: /^\/state$/ } });
  const body = { brightness: { value: 30, duration: 0 } };
  assert.equal((await call(emu, "PUT", `/api/v1/${token}/state`, body)).status, 500);
  assert.equal((await call(emu, "PUT", `/api/v1/${token}/state`, body)).status, 500);
  assert.equal(emu.brightness(), 100, "failed requests do nothing");
  assert.equal((await call(emu, "PUT", `/api/v1/${token}/state`, body)).status, 204);
  assert.equal(emu.brightness(), 30);

  emu.faults({ failNext: Infinity, match: ({ method }) => method === "DELETE" });
  assert.equal((await call(emu, "DELETE", `/api/v1/${token}`)).status, 503, "a function can match too");
  assert.equal((await call(emu, "DELETE", `/api/v1/${token}`)).status, 503, "Infinity lasts until cleared");
  assert.deepEqual(emu.faults(null), { pending: [], delay: null, refuseExtControl: false, dropFrames: false });
  assert.equal((await call(emu, "DELETE", `/api/v1/${token}`)).status, 204);

  assert.throws(() => emu.faults({ dropNext: -1 }), RangeError);
  assert.throws(() => emu.faults({ dropNext: 1, failNext: 0.5 }), RangeError);
  assert.deepEqual(emu.faults().pending, [], "a bad spec adds nothing");
  assert.throws(() => emu.faults({ failNext: 1, failStatus: 42 }), RangeError);
  assert.throws(() => emu.faults({ delayMs: -5 }), RangeError);
  assert.throws(() => emu.faults({ dropNext: 1, match: { path: 5 } }), TypeError);
  assert.throws(() => emu.faults("drop"), TypeError);
});

test("faults: hangNext never answers; delayMs holds requests, which still run after the client gives up", async (t) => {
  const emu = await start(t, { pairing: "open" });
  const token = await pair(emu);

  emu.faults({ hangNext: 1, match: { method: "GET" } });
  const hung = new AbortController();
  const pending = failedCall(emu, "GET", `/api/v1/${token}/state`, undefined, hung.signal);
  await until(() => emu.requests().at(-1)?.reason === "fault: hang", "the request to arrive");
  let settled = false;
  void pending.then(() => (settled = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "no answer");
  hung.abort();
  assert.equal((await pending)?.name, "AbortError");

  emu.faults({ delayMs: 40, match: { method: "PUT" } });
  assert.deepEqual(emu.faults().delay?.ms, 40);
  const started = performance.now();
  assert.equal((await call(emu, "GET", `/api/v1/${token}/effects/select`)).status, 200, "GETs aren't held");
  const body = JSON.stringify({ brightness: { value: 12 } });
  const gaveUp = request({ host: "127.0.0.1", port: emu.port, method: "PUT", path: `/api/v1/${token}/state` });
  gaveUp.on("error", () => {});
  gaveUp.on("finish", () => gaveUp.destroy());
  gaveUp.end(body);
  await until(() => emu.brightness() === 12, "the held request to run anyway");
  assert.ok(performance.now() - started >= 39, "it waited its delay");
  emu.faults({ delayMs: 0 });
  assert.equal(emu.faults().delay, null);
});

test("faults: refuseExtControl and dropFrames switch at run time; closeEvents cuts every event stream", async (t) => {
  const emu = await start(t, { pairing: "open" });
  const token = await pair(emu);
  const write = { write: { command: "display", animType: "extControl", extControlVersion: "v2" } };
  emu.faults({ refuseExtControl: true });
  assert.equal((await call(emu, "PUT", `/api/v1/${token}/effects`, write)).status, 400);
  emu.faults({ refuseExtControl: false });
  assert.equal((await call(emu, "PUT", `/api/v1/${token}/effects`, write)).status, 204);

  const panel = ids(emu)[0];
  emu.faults({ dropFrames: true });
  await sendUdp(emu.udpPort, encodeExtControlV2([[panel, [255, 0, 0]]], 0));
  await until(() => emu.lostFrames === 1, "the lost frame");
  assert.equal(emu.frames, 0);
  emu.faults({ dropFrames: false });
  await frame(emu, encodeExtControlV2([[panel, [255, 0, 0]]], 0));
  assert.equal(emu.frames, 1);

  const first = await events(t, emu, token);
  const second = await events(t, emu, token, "3");
  assert.equal(emu.closeEvents(), 2);
  await until(() => first.ended() && second.ended(), "the clients to see it");
  assert.equal(emu.closeEvents(), 0);
});

test("main's clients against injected faults: PUT retries, 5xx kinds, event reconnects, lost frames", async (t) => {
  const emu = await start(t, { pairing: "open" });
  const token = await pair(emu);
  const client = new NanoleafClient({ host: "127.0.0.1", port: emu.port, token, retryDelaysMs: [1, 1] });
  emu.selectEffect("Northern Lights");

  emu.faults({ dropNext: 1, match: { method: "PUT", body: '"select"' } });
  await client.selectEffect("Blaze");
  assert.equal(emu.effect(), "Blaze", "a dropped select is sent again");
  emu.faults({ failNext: 2, failStatus: 503, match: { path: "/state" } });
  await client.setState({ brightness: { value: 40 } });
  assert.equal(emu.brightness(), 40, "two 503s, then it lands");
  emu.faults({ failNext: 3, failStatus: 503, match: { path: "/effects" } });
  await assert.rejects(client.selectEffect("Starlight"), (error) => error.kind === "server" && error.status === 503);
  assert.equal(emu.effect(), "Blaze");
  emu.faults({ dropNext: 1, match: { method: "PUT", path: "/state" } });
  await assert.rejects(client.setState({ brightness: { increment: 10 } }), (error) => error.kind === "unreachable");
  assert.equal(emu.brightness(), 40, "an increment is never sent twice");
  emu.faults({ failNext: 1, failStatus: 503, match: { body: '"request"' } });
  await client.write({ command: "display", animType: "static", animData: `1 ${ids(emu)[0]} 1 1 2 3 0 1` });
  assert.ok((await client.requestStatic()) !== null, "a 503 on the read-back is retried, not taken as 'none'");
  emu.faults({ failNext: 3, failStatus: 503, match: { body: '"request"' } });
  await assert.rejects(client.requestStatic(), (error) => error.kind === "server");
  assert.deepEqual(emu.faults().pending, []);

  const statuses = [];
  const events = new EventStream({
    host: "127.0.0.1",
    port: emu.port,
    token,
    backoffMs: [5],
    onEvent: () => {},
    onStatus: (open, error) => statuses.push(open ? "open" : `dropped ${error?.kind ?? "clean"}`),
    log: (message, error) => error && statuses.push(`retry ${error.kind}`),
  });
  t.after(() => events.close());
  await until(() => events.isOpen, "the event stream to open");
  emu.faults({ failNext: 1, failStatus: 503, match: { path: "/events" } });
  emu.closeEvents();
  await until(() => statuses.filter((s) => s === "open").length === 2, "the stream to reopen");
  assert.ok(statuses.includes("retry server"), `a 503 on reconnect is a server error: ${statuses}`);

  const stream = new ExtControlStream("127.0.0.1", { port: emu.udpPort });
  t.after(() => stream.close());
  await client.enterExtControl();
  emu.faults({ dropFrames: true });
  assert.equal(stream.send([[ids(emu)[0], [9, 9, 9]]]), true);
  await until(() => emu.lostFrames === 1, "the lost frame");
  assert.equal(emu.frames, 0);
});
