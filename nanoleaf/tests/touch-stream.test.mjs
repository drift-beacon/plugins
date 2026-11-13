import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { TouchStream } from "../main/src/nanoleaf/touch-stream.ts";
import { encodeTouchPacket, SWIPE_GRACE_MS, TOUCH_DOWN, TOUCH_SWIPE, TOUCH_UP } from "../shared/touch.ts";

/** A stand-in dgram socket: `bind` says it is listening on `port` (unless `failBind`); tests emit messages by hand. */
function fakeSocket({ port = 50123, failBind = null } = {}) {
  const socket = new EventEmitter();
  socket.types = [];
  socket.closed = 0;
  socket.bind = (requested) => {
    socket.requested = requested;
    setImmediate(() => (failBind ? socket.emit("error", failBind) : socket.emit("listening")));
  };
  socket.unref = () => {};
  socket.address = () => ({ address: "0.0.0.0", family: "IPv4", port });
  socket.close = () => {
    socket.closed++;
  };
  socket.receive = (bytes, address = "192.168.1.20") => socket.emit("message", Buffer.from(bytes), { address });
  return socket;
}

function clock(start = 10_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

test("the listener binds an ephemeral port, reports it, buffers records and places a swipe", async () => {
  const socket = fakeSocket();
  const now = clock();
  const debug = [];
  const heard = [];
  const stream = new TouchStream({
    createSocket: (type) => {
      socket.types.push(type);
      return socket;
    },
    now,
    debug: (message) => debug.push(message),
    onListening: (port) => heard.push(port),
  });
  assert.equal(stream.port, null);
  assert.equal(await stream.bound, 50123);
  assert.equal(socket.requested, 0);
  assert.deepEqual(socket.types, ["udp4"]);
  assert.equal(stream.port, 50123);
  assert.deepEqual(heard, [50123]);

  assert.equal(stream.packets, 0);
  assert.equal(stream.lastPacketAt, null, "silent until a packet arrives");
  socket.receive(encodeTouchPacket([{ panelId: 10, type: TOUCH_DOWN }]));
  now.advance(100);
  socket.receive(encodeTouchPacket([{ panelId: 20, type: TOUCH_SWIPE, fromId: 10 }]));
  now.advance(50);
  socket.receive(encodeTouchPacket([{ panelId: 20, type: TOUCH_UP }]));
  assert.equal(stream.packets, 3);
  assert.equal(stream.lastPacketAt, 10_150);
  assert.equal(stream.recent().length, 3);
  assert.equal(stream.now(), 10_150, "the stream's clock is the injected one");
  assert.equal(stream.swipePanel([20]), 20, "a peek; a from-id off the wall falls back to the earliest panel");
  assert.equal(stream.swipePanel([10, 20], now() + 5000), null, "too long after the touches");
  assert.equal(stream.takeSwipePanel([10, 20]), 10, "timed on the stream's clock by default");
  assert.equal(stream.recent().length, 0, "the swipe used its touches up");
  now.advance(100);
  assert.equal(stream.takeSwipePanel([10, 20]), null, "a second swipe without packets isn't placed");

  socket.receive(Uint8Array.of(0, 3, 0, 10));
  assert.equal(stream.packets, 4);
  assert.equal(stream.malformed, 1);
  assert.ok(debug.some((line) => /listening on UDP 50123/.test(line)));
  assert.equal(debug.filter((line) => /first packet/.test(line)).length, 1, "no line per packet");

  stream.close();
  stream.close();
  assert.equal(socket.closed, 1);
  assert.equal(stream.port, null);
  assert.equal(stream.closed, true);
  socket.receive(encodeTouchPacket([{ panelId: 10, type: TOUCH_DOWN }]));
  assert.equal(stream.packets, 4, "nothing is read after close()");
});

test("a source filter ignores other senders; udp6 is used when asked", async () => {
  const socket = fakeSocket();
  const stream = new TouchStream({
    type: "udp6",
    source: "192.168.1.20",
    createSocket: (type) => {
      socket.types.push(type);
      return socket;
    },
  });
  await stream.bound;
  assert.deepEqual(socket.types, ["udp6"]);
  socket.receive(encodeTouchPacket([{ panelId: 10, type: TOUCH_DOWN }]), "192.168.1.99");
  socket.receive(encodeTouchPacket([{ panelId: 10, type: TOUCH_DOWN }]), "::ffff:192.168.1.20");
  assert.equal(stream.ignored, 1);
  assert.equal(stream.packets, 1);
  stream.close();
});

test("socket failures are logged, never thrown; a failed bind closes the socket and resolves the port as null", async () => {
  const logged = [];
  const socket = fakeSocket({ failBind: Object.assign(new Error("bind EACCES"), { code: "EACCES" }) });
  const failed = new TouchStream({ createSocket: () => socket, log: (message, error) => logged.push([message, error]) });
  assert.equal(await failed.bound, null);
  assert.equal(failed.port, null);
  assert.equal(failed.closed, true);
  assert.equal(socket.closed, 1, "the socket is closed once");
  assert.equal(logged.length, 1);
  assert.match(logged[0][1].message, /EACCES/);
  failed.close();
  assert.equal(socket.closed, 1);

  const bound = fakeSocket();
  const later = new TouchStream({ createSocket: () => bound, log: (message) => logged.push([message]) });
  await later.bound;
  bound.emit("error", new Error("ECONNRESET"));
  assert.equal(later.closed, false, "an error after binding is logged, the stream stays open");
  assert.equal(bound.closed, 0);
  later.close();

  const thrown = new TouchStream({
    createSocket: () => {
      throw new Error("no sockets");
    },
    log: (message) => logged.push([message]),
  });
  assert.equal(await thrown.bound, null);
  assert.equal(thrown.closed, true);
  assert.match(logged.at(-1)[0], /Couldn't make a socket/);
  thrown.close();

  const closedEarly = new TouchStream({ createSocket: () => fakeSocket() });
  closedEarly.close();
  assert.equal(await closedEarly.bound, null);
});

/** Timers the test fires by hand: `fire()` runs every pending callback. */
function manualTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimeout: (callback, ms) => {
      const handle = next++;
      pending.set(handle, { callback, ms });
      return handle;
    },
    clearTimeout: (handle) => pending.delete(handle),
    fire() {
      const due = [...pending.values()];
      pending.clear();
      for (const { callback } of due) callback();
    },
  };
}

/** A stream over a fake socket, a hand-moved clock and hand-fired timers. */
async function graceStream() {
  const socket = fakeSocket();
  const now = clock();
  const timers = manualTimers();
  const stream = new TouchStream({ createSocket: () => socket, now, timers });
  await stream.bound;
  return { socket, now, timers, stream };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const down = (panelId) => encodeTouchPacket([{ panelId, type: TOUCH_DOWN }]);
const swiped = (panelId, fromId) => encodeTouchPacket([{ panelId, type: TOUCH_SWIPE, fromId }]);

test("placeSwipe: touch data already there places the swipe at once; its late tail is used up by the grace", async () => {
  const { socket, now, timers, stream } = await graceStream();
  socket.receive(down(10));
  now.advance(100);
  socket.receive(swiped(20, 10));
  now.advance(10);
  assert.equal(await stream.placeSwipe([10, 20, 30]), 10);
  now.advance(20);
  socket.receive(encodeTouchPacket([{ panelId: 30, type: TOUCH_UP }]));
  assert.equal(timers.pending.size, 1);
  assert.deepEqual([...timers.pending.values()].map((timer) => timer.ms), [SWIPE_GRACE_MS]);
  timers.fire();
  assert.equal(stream.recent().length, 0, "the up that came after the swipe event is used up too");
  now.advance(200);
  assert.equal(await placeAfterGrace(stream, timers, [10, 20, 30]), null, "so a following swipe isn't placed by it");
  stream.close();
});

/** Calls placeSwipe, fires the grace timer, and returns what it resolved with. */
async function placeAfterGrace(stream, timers, panelIds) {
  let settled = false;
  const placing = stream.placeSwipe(panelIds).then((panel) => {
    settled = true;
    return panel;
  });
  await tick();
  assert.equal(settled, false, "it waits out the grace");
  timers.fire();
  return placing;
}

test("placeSwipe: a packet 50 ms after the swipe event is placed after the grace", async () => {
  const { socket, now, timers, stream } = await graceStream();
  let result = "pending";
  const placing = stream.placeSwipe([10, 20]).then((panel) => (result = panel));
  now.advance(40);
  socket.receive(down(10));
  now.advance(10);
  socket.receive(swiped(20, 10));
  await tick();
  assert.equal(result, "pending", "nothing until the grace ends");
  now.advance(SWIPE_GRACE_MS - 50);
  timers.fire();
  assert.equal(await placing, 10);
  assert.equal(stream.recent().length, 0);
  stream.close();
});

test("placeSwipe: nothing arriving gives null after the grace", async () => {
  const { now, timers, stream } = await graceStream();
  const placing = placeAfterGrace(stream, timers, [10, 20]);
  now.advance(SWIPE_GRACE_MS);
  assert.equal(await placing, null);
  stream.close();
});

test("placeSwipe: a packet after the grace isn't used by that swipe, and stays for later", async () => {
  const { socket, now, timers, stream } = await graceStream();
  let result = "pending";
  const placing = stream.placeSwipe([10, 20]).then((panel) => (result = panel));
  now.advance(SWIPE_GRACE_MS + 30);
  socket.receive(down(10));
  timers.fire();
  assert.equal(await placing, null);
  assert.equal(result, null);
  assert.deepEqual(
    stream.recent().map((touch) => touch.record.panelId),
    [10],
    "the late record is left for the next swipe",
  );
  stream.close();
});

test("placeSwipe: two swipes inside one grace don't hang; a closed stream gives null", async () => {
  const { socket, now, timers, stream } = await graceStream();
  const first = stream.placeSwipe([10, 20]);
  now.advance(20);
  const second = stream.placeSwipe([10, 20]);
  now.advance(20);
  socket.receive(down(10));
  timers.fire();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.toSorted(), [10, null].toSorted(), "the first to take gets the record, the other nothing");

  const waiting = stream.placeSwipe([10, 20]);
  stream.close();
  assert.equal(await waiting, null, "close() settles a waiting call");
  assert.equal(timers.pending.size, 0, "and clears its timer");
  assert.equal(await stream.placeSwipe([10, 20]), null, "a closed stream answers at once");
});

test("the default clock is monotonic", async () => {
  const stream = new TouchStream({ createSocket: () => fakeSocket() });
  const before = performance.now();
  const reading = stream.now();
  assert.ok(reading >= before && reading <= performance.now());
  stream.close();
});

test("a real socket receives packets sent to its port on localhost", async (t) => {
  const stream = new TouchStream();
  t.after(() => stream.close());
  const port = await stream.bound;
  assert.ok(port > 0);
  const sender = createSocket("udp4");
  t.after(() => sender.close());
  await new Promise((resolve, reject) =>
    sender.send(encodeTouchPacket([{ panelId: 7, type: TOUCH_DOWN }]), port, "127.0.0.1", (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  const deadline = Date.now() + 2000;
  while (stream.packets === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stream.packets, 1);
  assert.equal(stream.recent()[0].record.panelId, 7);
});

test("end to end: emulator, a real TouchStream and EventStream with touchEventsPort place a swipe on its first panel", async (t) => {
  const { startEmulator } = await import("../tools/fake-nanoleaf.mjs");
  const { EventStream, touches } = await import("../main/src/nanoleaf/events.ts");
  const emu = await startEmulator({ port: 0, wallPort: null, udpPort: 0, quiet: true, tokens: ["tok"] });
  t.after(() => emu.close());
  const panels = [...emu.lights().keys()];
  const touch = new TouchStream();
  t.after(() => touch.close());
  await touch.bound;
  const placed = [];
  const events = new EventStream({
    host: "127.0.0.1",
    port: emu.port,
    token: "tok",
    ids: [4],
    touchEventsPort: () => touch.port,
    onEvent: (event) => {
      for (const { gesture } of touches(event)) {
        if (gesture.startsWith("swipe")) void touch.placeSwipe(panels).then((panel) => placed.push([gesture, panel]));
      }
    },
  });
  t.after(() => events.close());
  const deadline = Date.now() + 2000;
  const until = async (check) => {
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await until(() => events.isOpen);
  emu.touch(-1, "swipe-left", { panels: [panels[3], panels[1], panels[4]] });
  await until(() => placed.length === 1);
  emu.touch(-1, "swipe-up");
  await until(() => placed.length === 2);
  assert.deepEqual(placed, [
    ["swipe-left", panels[3]],
    ["swipe-up", null],
  ]);
  assert.equal(touch.packets, 4);
});

test("onHeard is told once, at the first packet from the source; a failing handler is logged", async () => {
  const socket = fakeSocket();
  const told = [];
  const logs = [];
  const stream = new TouchStream({
    createSocket: () => socket,
    source: "192.168.1.20",
    onHeard: () => {
      told.push(stream.lastPacketAt !== null);
      throw new Error("boom");
    },
    log: (message) => logs.push(message),
  });
  await stream.bound;
  socket.receive(encodeTouchPacket([{ panelId: 10, type: TOUCH_DOWN }]), "192.168.1.99");
  assert.deepEqual(told, [], "another sender isn't the stream");
  socket.receive(encodeTouchPacket([{ panelId: 10, type: TOUCH_DOWN }]));
  socket.receive(encodeTouchPacket([{ panelId: 10, type: TOUCH_UP }]));
  assert.deepEqual(told, [true], "once, with the packet already counted");
  assert.deepEqual(logs, ["The touch stream's heard handler failed"]);
  assert.equal(stream.packets, 2, "the packet is still read");
  stream.close();
});

/* ---- One touch stream per connection (main/src/index.ts `touchStreams`) ---- */

function streamsHarness(socketOptions) {
  const posts = [];
  const opened = [];
  const sockets = [];
  const ctx = {
    log: { info() {}, warn() {}, error() {} },
    ui: { post: (name, payload) => void posts.push([name, payload]) },
  };
  return { ctx, posts, opened, sockets, socketOptions };
}

test("heard: false at each new connection, true at its first packet; every copy is told each change", async () => {
  const { touchStreams } = await import("../main/src/index.ts");
  const h = streamsHarness();
  const touch = touchStreams(h.ctx, {
    createSocket: () => {
      const socket = fakeSocket();
      h.sockets.push(socket);
      return socket;
    },
    createEvents: (options) => {
      h.opened.push(options);
      return { close() {} };
    },
  });
  const connection = { host: "192.168.1.20", port: 16021, token: "tok", onEvent() {} };
  const first = touch.open(connection);
  await until(() => h.opened.length === 1);
  assert.equal(h.opened[0].touchEventsPort(), 50123, "the events request asks for the stream");
  assert.deepEqual(touch.info(), { heard: false });
  h.sockets[0].receive(encodeTouchPacket([{ panelId: 10, type: TOUCH_DOWN }]), "192.168.1.99");
  assert.deepEqual(touch.info(), { heard: false }, "only the controller's own packets count");
  h.sockets[0].receive(encodeTouchPacket([{ panelId: 10, type: TOUCH_DOWN }]));
  assert.deepEqual(touch.info(), { heard: true });
  assert.deepEqual(h.posts, [["touchStream", { heard: true }]]);
  // The connection drops and comes back: a new stream, not heard yet.
  first.close();
  assert.equal(h.sockets[0].closed, 1);
  touch.open(connection);
  await until(() => h.opened.length === 2);
  assert.deepEqual(touch.info(), { heard: false });
  assert.deepEqual(h.posts, [
    ["touchStream", { heard: true }],
    ["touchStream", { heard: false }],
  ]);
  h.sockets[1].receive(encodeTouchPacket([{ panelId: 10, type: TOUCH_DOWN }]));
  assert.deepEqual(h.posts.at(-1), ["touchStream", { heard: true }]);
  touch.close();
  assert.deepEqual(h.posts.at(-1), ["touchStream", { heard: false }]);
});

test("the events request opens without TouchEventsPort when the touch socket can't bind", async (t) => {
  const { createServer } = await import("node:http");
  const { touchStreams } = await import("../main/src/index.ts");
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.headers);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(":\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const h = streamsHarness();
  const touch = touchStreams(h.ctx, { createSocket: () => fakeSocket({ failBind: new Error("EADDRINUSE") }) });
  const handle = touch.open({ host: "127.0.0.1", port: server.address().port, token: "tok", onEvent() {} });
  t.after(() => handle.close());
  await until(() => requests.length === 1);
  assert.equal(requests[0].toucheventsport, undefined);
  assert.deepEqual(touch.info(), { heard: false });
  handle.close();
});

async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A local events endpoint: `answer(headers, n)` says 200 (an open stream) or a status to refuse with. */
async function eventsServer(t, answer) {
  const { createServer } = await import("node:http");
  const requests = [];
  const open = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.toucheventsport ?? null);
    const status = answer(request.headers, requests.length);
    if (status !== 200) {
      response.writeHead(status);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(":\n\n");
    open.push(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { requests, open, port: server.address().port };
}

function headerHarness() {
  const warnings = [];
  const posts = [];
  const ctx = {
    log: { info() {}, warn: (message) => warnings.push(message), error() {} },
    ui: { post: (name, payload) => void posts.push([name, payload]) },
  };
  return { ctx, warnings, posts };
}

test("a controller that won't open the events request with TouchEventsPort gets it without, after two tries", async (t) => {
  const { touchStreams } = await import("../main/src/index.ts");
  const server = await eventsServer(t, (headers) => (headers.toucheventsport ? 400 : 200));
  const h = headerHarness();
  const statuses = [];
  const touch = touchStreams(h.ctx, { createSocket: () => fakeSocket() });
  const connection = {
    host: "127.0.0.1",
    port: server.port,
    token: "tok",
    backoffMs: [5],
    onEvent() {},
    onStatus: (open) => statuses.push(open),
  };
  const first = touch.open(connection);
  t.after(() => first.close());
  await until(() => statuses.includes(true));
  assert.deepEqual(server.requests, ["50123", "50123", null], "opened on the third attempt, without the header");
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /didn't open while the plugin asked it for touch data/);
  assert.deepEqual(touch.info(), { heard: false });
  assert.equal(touch.current(), null, "no touch stream for the rest of this connection");
  // It stays off for this connection: a drop and a reconnect go without it.
  server.open.shift().end();
  await until(() => server.requests.length === 4);
  assert.equal(server.requests[3], null);
  first.close();
  // A new connection asks again.
  const second = touch.open(connection);
  t.after(() => second.close());
  await until(() => server.requests.length === 5);
  assert.equal(server.requests[4], "50123");
  second.close();
  assert.equal(h.warnings.length, 1, "said once");
});

test("once the events request opened with TouchEventsPort, a drop and reconnect keep asking for it", async (t) => {
  const { touchStreams } = await import("../main/src/index.ts");
  const server = await eventsServer(t, (headers, n) => (n === 2 ? 503 : 200));
  const h = headerHarness();
  const touch = touchStreams(h.ctx, { createSocket: () => fakeSocket() });
  const handle = touch.open({ host: "127.0.0.1", port: server.port, token: "tok", backoffMs: [5], onEvent() {} });
  t.after(() => handle.close());
  await until(() => server.open.length === 1);
  server.open.shift().end();
  // The reconnect fails once (a 503), then opens: three requests, every one asking.
  await until(() => server.open.length === 1);
  assert.deepEqual(server.requests, ["50123", "50123", "50123"]);
  assert.deepEqual(h.warnings, []);
  assert.notEqual(touch.current(), null);
  handle.close();
});
