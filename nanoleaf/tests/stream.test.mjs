import assert from "node:assert/strict";
import dns from "node:dns";
import { createSocket } from "node:dgram";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { ExtControlStream } from "../main/src/nanoleaf/stream.ts";
import { decodeExtControlV2 } from "../shared/protocol.ts";

/** A real UDP listener on 127.0.0.1 (or ::1) that decodes every packet it gets. */
async function listener(address = "127.0.0.1") {
  const socket = createSocket(address.includes(":") ? "udp6" : "udp4");
  const frames = [];
  const waiters = [];
  socket.on("message", (message, rinfo) => {
    frames.push({ panels: decodeExtControlV2(message), from: rinfo });
    for (const waiter of waiters.splice(0)) waiter();
  });
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, address, resolve);
  });
  const until = async (count) => {
    while (frames.length < count) await new Promise((resolve) => waiters.push(resolve));
  };
  return { port: socket.address().port, frames, until, close: () => socket.close() };
}

/** A stand-in socket whose sends fail in the given way ("callback", "throw" or "ok"); `mode` can change later. */
function failingSocket(mode) {
  const socket = new EventEmitter();
  socket.mode = mode;
  socket.sends = [];
  socket.bind = () => {};
  socket.unref = () => {};
  socket.close = () => {};
  socket.send = (packet, port, host, callback) => {
    socket.sends.push(host);
    if (socket.mode === "throw") throw new Error("ERR_SOCKET_DGRAM_NOT_RUNNING");
    const error = socket.mode === "ok" ? null : Object.assign(new Error("send EHOSTUNREACH"), { code: "EHOSTUNREACH" });
    setImmediate(() => callback(error));
  };
  return socket;
}

/** A lookup the test answers by hand: `calls` lists each name asked for, `answer`/`fail` settle the oldest one. */
function manualLookup() {
  const pending = [];
  const lookup = (host) =>
    new Promise((resolve, reject) => {
      lookup.calls.push(host);
      pending.push({ resolve, reject });
    });
  lookup.calls = [];
  lookup.answer = async (addresses) => {
    pending.shift().resolve(addresses);
    await tick();
  };
  lookup.fail = async (error) => {
    pending.shift().reject(error);
    await tick();
  };
  return lookup;
}

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = [[1, [1, 1, 1]]];
const notFound = () => Object.assign(new Error("getaddrinfo ENOTFOUND wall.test"), { code: "ENOTFOUND" });

test("frames reach a local listener as decodable extControl v2 packets", async (t) => {
  const wall = await listener();
  t.after(wall.close);
  const stream = new ExtControlStream("127.0.0.1", { port: wall.port });
  t.after(() => stream.close());

  assert.equal(stream.send(new Map([[49632, [255, 0, 128]], [34671, [0, 0, 0]]])), true);
  assert.equal(stream.send([[7, [1, 2, 3], 12]], 5), true);
  assert.equal(stream.send([[8, [4, 5, 6]]], 3), true);
  await wall.until(3);

  assert.deepEqual(wall.frames[0].panels, [
    { id: 49632, rgb: [255, 0, 128], transitionDs: 1 },
    { id: 34671, rgb: [0, 0, 0], transitionDs: 1 },
  ]);
  assert.deepEqual(wall.frames[1].panels, [{ id: 7, rgb: [1, 2, 3], transitionDs: 12 }]);
  assert.deepEqual(wall.frames[2].panels, [{ id: 8, rgb: [4, 5, 6], transitionDs: 3 }]);
  assert.notEqual(wall.frames[0].from.port, 60222, "frames come from an ephemeral port");
  assert.equal(stream.sent, 3);
  assert.equal(stream.errors, 0);
  assert.equal(stream.address, "127.0.0.1");
});

test("send errors are counted and logged, never thrown", async () => {
  const logged = [];
  const log = (message, error) => logged.push({ message, error });

  const later = new ExtControlStream("192.0.2.1", { createSocket: () => failingSocket("callback"), log });
  assert.equal(later.send(frame), true);
  assert.equal(later.send(frame), true);
  await tick();
  assert.equal(later.errors, 2);
  assert.equal(logged.length, 1, "only the first error of a run is logged");
  assert.match(logged[0].message, /192\.0\.2\.1:60222/);

  const now = new ExtControlStream("192.0.2.1", { createSocket: () => failingSocket("throw"), log });
  assert.equal(now.send(frame), false);
  assert.equal(now.errors, 1);

  const bad = new ExtControlStream("192.0.2.1", { createSocket: () => failingSocket("callback"), log });
  assert.equal(bad.send([[70000, [1, 1, 1]]]), false, "an id that can't be encoded is an error, not a throw");
  assert.equal(bad.errors, 1);

  const noisy = new ExtControlStream("192.0.2.1", { createSocket: () => failingSocket("throw"), log });
  const before = logged.length;
  for (let i = 0; i < 250; i++) noisy.send(frame);
  assert.equal(noisy.errors, 250);
  assert.equal(logged.length - before, 3, "logged at errors 1, 100 and 200");
});

test("socket errors are counted instead of crashing, and close is final and idempotent", async () => {
  const socket = failingSocket("callback");
  const stream = new ExtControlStream("192.0.2.1", { createSocket: () => socket });
  socket.emit("error", new Error("boom"));
  assert.equal(stream.errors, 1);
  stream.close();
  stream.close();
  assert.equal(stream.closed, true);
  assert.equal(stream.send(frame), false);
});

test("onError fires when frames start failing, once per run, and again after they recover", async () => {
  const socket = failingSocket("callback");
  const reported = [];
  const stream = new ExtControlStream("192.0.2.1", { createSocket: () => socket, onError: (e) => reported.push(e) });
  stream.send(frame);
  stream.send(frame);
  await tick();
  assert.equal(stream.errors, 2);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].code, "EHOSTUNREACH");

  socket.mode = "ok";
  stream.send(frame);
  await tick();
  socket.mode = "callback";
  stream.send(frame);
  await tick();
  assert.equal(reported.length, 2, "a frame went out in between, so this is a new run");

  const throwing = new ExtControlStream("192.0.2.1", {
    createSocket: () => failingSocket("throw"),
    onError: () => {
      throw new Error("handler bug");
    },
  });
  assert.equal(throwing.send(frame), false, "a failing handler doesn't escape send");
});

test("a host name is looked up once, not per frame; frames before the answer are dropped, not queued", async (t) => {
  const wall = await listener();
  t.after(wall.close);
  const lookup = manualLookup();
  const stream = new ExtControlStream("shapes-6297.local", { port: wall.port, lookup });
  t.after(() => stream.close());

  assert.deepEqual(lookup.calls, ["shapes-6297.local"], "the lookup starts with the stream");
  assert.equal(stream.address, null);
  assert.equal(stream.send([[1, [9, 9, 9]]]), false, "no address yet");
  assert.equal(stream.sent, 0);

  await lookup.answer([
    { address: "fe80::1", family: 6 },
    { address: "127.0.0.1", family: 4 },
  ]);
  assert.equal(stream.address, "127.0.0.1", "IPv4 wins over link-local IPv6");
  for (let i = 0; i < 20; i++) assert.equal(stream.send([[i + 1, [255, 0, 0]]]), true);
  await wall.until(20);
  assert.equal(lookup.calls.length, 1, "20 frames, one lookup");
  assert.deepEqual(
    wall.frames.map((f) => f.panels[0].id),
    Array.from({ length: 20 }, (_, i) => i + 1),
    "the dropped frame never arrives",
  );
  assert.equal(stream.errors, 0);
});

test("a real socket never runs a DNS lookup per frame", async (t) => {
  const wall = await listener();
  t.after(wall.close);
  // dgram captures dns.lookup when a socket is made, so count from before the stream exists.
  const original = dns.lookup;
  let lookups = 0;
  dns.lookup = function (...args) {
    lookups++;
    return original.apply(this, args);
  };
  t.after(() => {
    dns.lookup = original;
  });
  const stream = new ExtControlStream("localhost", { port: wall.port });
  t.after(() => stream.close());
  const deadline = Date.now() + 5000;
  while (stream.address === null && stream.errors === 0 && Date.now() < deadline) await tick();
  assert.equal(stream.address, "127.0.0.1");
  for (let i = 0; i < 20; i++) stream.send(frame);
  await wall.until(20);
  assert.equal(lookups, 0, "neither bind nor the 20 sends looked anything up");

  const plain = createSocket("udp4");
  t.after(() => plain.close());
  await new Promise((resolve) => plain.send(Buffer.from([0]), wall.port, "localhost", resolve));
  assert.ok(lookups >= 1, "the counter does see a plain socket's send to a name");
});

test("a failed lookup drops frames and is retried no sooner than resolveRetryMs, one lookup at a time", async () => {
  const lookup = manualLookup();
  const now = clock();
  const logged = [];
  const reported = [];
  const socket = failingSocket("ok");
  const stream = new ExtControlStream("wall.test", {
    lookup,
    now,
    resolveRetryMs: 5000,
    createSocket: () => socket,
    log: (message, error) => logged.push(error?.code),
    onError: (error) => reported.push(error?.code),
  });
  assert.equal(stream.send(frame), false, "while the first lookup runs");
  assert.equal(lookup.calls.length, 1, "no second lookup while one is in flight");

  await lookup.fail(notFound());
  assert.equal(stream.errors, 1);
  assert.deepEqual(logged, ["ENOTFOUND"]);
  assert.deepEqual(reported, ["ENOTFOUND"]);
  now.advance(4999);
  assert.equal(stream.send(frame), false);
  assert.equal(lookup.calls.length, 1, "too soon to ask again");

  now.advance(1);
  assert.equal(stream.send(frame), false, "this frame is dropped; it starts the next lookup");
  assert.equal(lookup.calls.length, 2);
  await lookup.answer([{ address: "192.0.2.7", family: 4 }]);
  assert.equal(stream.send(frame), true);
  assert.deepEqual(socket.sends, ["192.0.2.7"]);

  const empty = new ExtControlStream("wall.test", { lookup: async () => [], createSocket: () => failingSocket("ok") });
  await tick();
  assert.equal(empty.errors, 1, "a name without addresses is an error");
  assert.equal(empty.send(frame), false);
});

test("a failed send to a resolved name looks it up again (rate-limited) and keeps sending meanwhile", async () => {
  const lookup = manualLookup();
  const now = clock();
  const sockets = [];
  const stream = new ExtControlStream("wall.test", {
    lookup,
    now,
    resolveRetryMs: 1000,
    createSocket: (type) => {
      const socket = failingSocket("callback");
      socket.type = type;
      sockets.push(socket);
      return socket;
    },
  });
  await lookup.answer([{ address: "192.0.2.7", family: 4 }]);
  now.advance(500);
  assert.equal(stream.send(frame), true);
  await tick();
  assert.equal(stream.errors, 1);

  assert.equal(stream.send(frame), true, "still sends to the old address while it may change");
  assert.equal(lookup.calls.length, 1, "within resolveRetryMs of the last lookup");
  now.advance(500);
  assert.equal(stream.send(frame), true);
  assert.equal(lookup.calls.length, 2, "the controller may have a new address");
  await lookup.answer([{ address: "2001:db8::7", family: 6 }]);
  assert.equal(stream.address, "2001:db8::7");
  stream.send(frame);
  assert.deepEqual(
    sockets.map((socket) => socket.type),
    ["udp4", "udp6"],
    "a new family gets a new socket",
  );
  assert.deepEqual(sockets[1].sends, ["2001:db8::7"]);
});

test("IPv6 controllers stream over udp6, bare or in brackets", async (t) => {
  let wall;
  try {
    wall = await listener("::1");
  } catch (error) {
    t.skip(`no IPv6 loopback here (${error.code ?? error.message})`);
    return;
  }
  t.after(wall.close);
  const types = [];
  for (const host of ["::1", "[::1]"]) {
    const stream = new ExtControlStream(host, {
      port: wall.port,
      createSocket: (type) => {
        types.push(type);
        return createSocket(type);
      },
    });
    t.after(() => stream.close());
    assert.equal(stream.address, "::1");
    assert.equal(stream.send([[5, [0, 128, 255]]]), true);
  }
  await wall.until(2);
  assert.deepEqual(types, ["udp6", "udp6"]);
  assert.deepEqual(wall.frames[0].panels, [{ id: 5, rgb: [0, 128, 255], transitionDs: 1 }]);
});

test("closing while a lookup runs ignores its answer and makes no socket", async () => {
  const lookup = manualLookup();
  let made = 0;
  const stream = new ExtControlStream("wall.test", {
    lookup,
    createSocket: () => {
      made++;
      return failingSocket("ok");
    },
  });
  stream.close();
  await lookup.answer([{ address: "192.0.2.7", family: 4 }]);
  assert.equal(made, 0);
  assert.equal(stream.address, null);
  assert.equal(stream.send(frame), false);
});

test("a real socket sending to an unresolvable host doesn't throw", async () => {
  const errors = [];
  const stream = new ExtControlStream("nanoleaf.invalid", { log: (message, error) => errors.push(error) });
  assert.equal(stream.send(frame), false, "no address yet");
  const deadline = Date.now() + 5000;
  while (stream.errors === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stream.send(frame), false, "still none, and too soon to look again");
  stream.close();
  assert.equal(stream.errors, 1);
  assert.equal(errors.length, 1);
});
