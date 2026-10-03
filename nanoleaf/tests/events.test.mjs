import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  effectName,
  EventStream,
  layoutChange,
  SseParser,
  stateAttrs,
  touches,
} from "../main/src/nanoleaf/events.ts";

/** Collects parser output. */
function parse(chunks) {
  const messages = [];
  const parser = new SseParser((message) => messages.push(message));
  for (const chunk of chunks) parser.push(chunk);
  return messages;
}

test("SSE: LF, CRLF and CR line ends, even split across chunks", () => {
  assert.deepEqual(parse(["id: 1\ndata: a\n\n", "id: 2\r\ndata: b\r\n\r\n", "id: 3\rdata: c\r\r"]), [
    { id: "1", event: "message", data: "a" },
    { id: "2", event: "message", data: "b" },
    { id: "3", event: "message", data: "c" },
  ]);
  const split = parse(["id: 4\r", "\ndata: d\r", "\n\r", "\n", "id: 5\r", "", "\ndata: e\n", "\n"]);
  assert.deepEqual(split, [
    { id: "4", event: "message", data: "d" },
    { id: "5", event: "message", data: "e" },
  ]);
  assert.deepEqual(parse(["i", "d", ":", " ", "7", "\n", "da", "ta:x", "yz", "\n", "\n"]), [
    { id: "7", event: "message", data: "xyz" },
  ]);
});

test("SSE: comments, keep-alives, multi-line data, BOM, bare fields and the spec's edge cases", () => {
  const messages = parse([
    "﻿: hello\n\n",
    ":\n",
    "id: 2\ndata: {\"a\":\ndata:  1}\n\n",
    "data\n\n",
    "event: custom\ndata:x\nretry: 1000\nunknown: 1\n\n",
    "id\ndata: after empty id\n\n",
    "id: 8\n\n",
    "data: unterminated",
  ]);
  assert.deepEqual(messages, [
    { id: "2", event: "message", data: '{"a":\n 1}' },
    { id: "2", event: "message", data: "" },
    { id: "2", event: "custom", data: "x" },
    { id: "", event: "message", data: "after empty id" },
  ]);
});

test("typed helpers read state, layout, effect and touch events", () => {
  const state = { id: 1, events: [{ attr: 1, value: false }, { attr: 2, value: 40 }, { attr: 6, value: "hs" }] };
  assert.deepEqual(stateAttrs(state), { on: false, brightness: 40, colorMode: "hs" });
  assert.deepEqual(
    stateAttrs({ id: 1, events: [{ attr: 3, value: 72 }, { attr: 4, value: 80 }, { attr: 5, value: 2700 }, null] }),
    { hue: 72, sat: 80, ct: 2700 },
  );
  assert.deepEqual(stateAttrs({ id: 3, events: [{ attr: 1, value: "Flames" }] }), {});

  const layout = {
    id: 2,
    events: [
      {
        attr: 1,
        value: { numPanels: 1, sideLength: 0, positionData: [{ panelId: 7, x: 1, y: 2, o: 60, shapeType: 9 }] },
      },
      { attr: 2, value: 90 },
    ],
  };
  assert.deepEqual(layoutChange(layout), {
    positionData: [{ id: 7, x: 1, y: 2, o: 60, shapeType: 9 }],
    globalOrientation: 90,
  });
  assert.deepEqual(layoutChange({ id: 2, events: [{ attr: 2, value: 120 }] }), {
    positionData: null,
    globalOrientation: 120,
  });
  assert.equal(layoutChange(state), null);

  assert.equal(effectName({ id: 3, events: [{ attr: 1, value: "*ExtControl*" }] }), "*ExtControl*");
  assert.equal(effectName(state), null);

  const touch = {
    id: 4,
    events: [
      { gesture: 0, panelId: 7 },
      { gesture: 1, panelId: 7 },
      { gesture: 2, panelId: -1 },
      { gesture: 3, panelId: -1 },
      { gesture: 4, panelId: -1 },
      { gesture: 5, panelId: -1 },
      { gesture: 9, panelId: 7 },
    ],
  };
  assert.deepEqual(touches(touch), [
    { panelId: 7, gesture: "tap" },
    { panelId: 7, gesture: "double-tap" },
    { panelId: -1, gesture: "swipe-up" },
    { panelId: -1, gesture: "swipe-down" },
    { panelId: -1, gesture: "swipe-left" },
    { panelId: -1, gesture: "swipe-right" },
  ]);
  assert.deepEqual(touches(state), []);
});

/** An SSE server that runs `script(res, connection)` for each connection; `statuses` picks non-200 answers. */
async function sseServer(script, statuses = []) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const status = statuses[requests.length - 1] ?? 200;
    if (status !== 200) {
      res.writeHead(status).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    script(res, requests.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await wait(5);
  }
}

test("EventStream parses a scripted controller and reconnects after it closes", async (t) => {
  const server = await sseServer((res, connection) => {
    if (connection === 1) {
      const chunks = [
        ": keep-alive\r\n\r\n",
        'id: 1\r\ndata: {"events":[{"attr":1,"value":true},{"attr":2,"value":40}]}\r\n\r\n',
        'id: 3\nda',
        'ta: {"events":[{"attr":1,"value":"Fla',
        'mes"}]}\n\n',
        ":\n",
        'id: 2\ndata: {"events":[{"attr":1,"value":{"numPanels":1,"sideLength":0,\n',
        'data: "positionData":[{"panelId":7,"x":1,"y":2,"o":60,"shapeType":9}]}},{"attr":2,"value":90}]}\n\n',
        "id: 4\rdata: not json\r\r",
        'id: 9\ndata: {"events":[]}\n\n',
        'id: 4\ndata: {"no":"events"}\n\n',
      ];
      let i = 0;
      const next = () => {
        if (i < chunks.length) {
          res.write(chunks[i++]);
          setTimeout(next, 3);
        } else res.end();
      };
      next();
    } else {
      res.write('id: 4\ndata: {"events":[{"gesture":0,"panelId":36776}]}\n\n');
    }
  });
  t.after(server.close);

  const events = [];
  const statuses = [];
  const logged = [];
  const stream = new EventStream({
    host: "127.0.0.1",
    port: server.port,
    token: "tok",
    backoffMs: [20],
    onEvent: (event) => events.push(event),
    onStatus: (open, error) => statuses.push([open, error]),
    log: (message) => logged.push(message),
  });
  t.after(() => stream.close());

  await until(() => events.some((event) => event.id === 4));
  assert.deepEqual(server.requests, ["/api/v1/tok/events?id=1,2,3,4", "/api/v1/tok/events?id=1,2,3,4"]);
  assert.deepEqual(
    statuses.map(([open, error]) => [open, error]),
    [
      [true, null],
      [false, null],
      [true, null],
    ],
  );
  assert.equal(stream.isOpen, true);
  assert.deepEqual(
    events.map((event) => event.id),
    [1, 3, 2, 4],
  );
  assert.deepEqual(stateAttrs(events[0]), { on: true, brightness: 40 });
  assert.equal(effectName(events[1]), "Flames");
  assert.deepEqual(layoutChange(events[2]).positionData, [{ id: 7, x: 1, y: 2, o: 60, shapeType: 9 }]);
  assert.deepEqual(touches(events[3]), [{ panelId: 36776, gesture: "tap" }]);
  assert.ok(logged.some((message) => /isn't JSON/.test(message)));
  assert.ok(logged.some((message) => /without an events array/.test(message)));

  stream.close();
  const before = statuses.length;
  await wait(50);
  assert.equal(statuses.length, before, "close() reports nothing");
  assert.equal(stream.isOpen, false);
});

test("EventStream backs off through failed attempts, then opens; close() stops reconnecting", async (t) => {
  const server = await sseServer(() => {}, [401, 500]);
  t.after(server.close);
  const statuses = [];
  const logged = [];
  const stream = new EventStream({
    host: "127.0.0.1",
    port: server.port,
    token: "tok",
    ids: [2, 4],
    backoffMs: [10, 30],
    onEvent: () => {},
    onStatus: (open) => statuses.push(open),
    log: (message, error) => logged.push([message, error?.kind, error?.status]),
  });
  await until(() => stream.isOpen);
  assert.deepEqual(statuses, [true], "failed attempts before opening aren't status changes");
  assert.equal(server.requests.length, 3);
  assert.equal(server.requests[0], "/api/v1/tok/events?id=2,4");
  assert.deepEqual(logged.slice(0, 2), [
    ["Event stream didn't open; retrying in 10 ms", "unauthorized", 401],
    ["Event stream didn't open; retrying in 30 ms", "server", 500],
  ]);
  stream.close();
  await server.close();
  await wait(60);
  assert.equal(server.requests.length, 3);
});

test("EventStream resets its backoff only after staying open long enough", async (t) => {
  const server = await sseServer((res) => res.end('id: 3\ndata: {"events":[{"attr":1,"value":"Forest"}]}\n\n'));
  t.after(server.close);
  const make = (resetAfterMs) =>
    new EventStream({
      host: "127.0.0.1",
      port: server.port,
      token: "tok",
      backoffMs: [10, 5000],
      resetAfterMs,
      onEvent: () => {},
    });

  const resetting = make(0);
  await until(() => server.requests.length >= 4);
  resetting.close();

  await wait(30);
  const start = server.requests.length;
  const growing = make(60_000);
  await wait(250);
  growing.close();
  assert.equal(server.requests.length - start, 2, "the second drop waits the second step (5 s)");
});

test("EventStream reports a refused connection and keeps retrying", async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const logged = [];
  const stream = new EventStream({
    host: "127.0.0.1",
    port,
    token: "tok",
    backoffMs: [10],
    onEvent: () => {},
    log: (message, error) => logged.push(error?.kind),
  });
  await until(() => logged.length >= 2);
  stream.close();
  assert.deepEqual(logged.slice(0, 2), ["unreachable", "unreachable"]);
});

test("EventStream times out a controller that never answers", async (t) => {
  const sockets = [];
  const server = createServer(() => {});
  server.on("connection", (socket) => sockets.push(socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const logged = [];
  const stream = new EventStream({
    host: "127.0.0.1",
    port: server.address().port,
    token: "tok",
    connectTimeoutMs: 40,
    backoffMs: [1000],
    onEvent: () => {},
    log: (message, error) => logged.push(error?.kind),
  });
  await until(() => logged.length >= 1);
  stream.close();
  assert.equal(logged[0], "timeout");
});

test("a throwing handler is logged and the stream carries on", async (t) => {
  const server = await sseServer((res) => {
    res.write('id: 3\ndata: {"events":[{"attr":1,"value":"A"}]}\n\n');
    res.write('id: 3\ndata: {"events":[{"attr":1,"value":"B"}]}\n\n');
  });
  t.after(server.close);
  const seen = [];
  const logged = [];
  const stream = new EventStream({
    host: "127.0.0.1",
    port: server.port,
    token: "tok",
    onEvent: (event) => {
      seen.push(effectName(event));
      if (seen.length === 1) throw new Error("handler bug");
    },
    onStatus: () => {
      throw new Error("status bug");
    },
    log: (message) => logged.push(message),
  });
  t.after(() => stream.close());
  await until(() => seen.length === 2);
  assert.deepEqual(seen, ["A", "B"]);
  assert.ok(logged.includes("An event handler failed"));
  assert.ok(logged.includes("The event stream's status handler failed"));
});
