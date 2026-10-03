import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { test } from "node:test";
import {
  buildMdnsQuery,
  buildSsdpSearch,
  discover,
  mergeFound,
  parseDnsMessage,
  parseMdns,
  parseSsdp,
} from "../main/src/nanoleaf/discovery.ts";

/** Builds DNS packets by hand, byte by byte, so the tests don't lean on the module's own encoder. */
class Packet {
  bytes = [];
  get offset() {
    return this.bytes.length;
  }
  u8(value) {
    this.bytes.push(value & 0xff);
    return this;
  }
  u16(value) {
    return this.u8(value >> 8).u8(value);
  }
  u32(value) {
    return this.u16(value >>> 16).u16(value & 0xffff);
  }
  label(text) {
    const encoded = new TextEncoder().encode(text);
    this.u8(encoded.length);
    for (const byte of encoded) this.u8(byte);
    return this;
  }
  end() {
    return this.u8(0);
  }
  pointer(offset) {
    return this.u16(0xc000 | offset);
  }
  /** A record header; returns a function that patches in the data length once the data is written. */
  record(type, cls = 0x0001, ttl = 10) {
    this.u16(type).u16(cls).u32(ttl);
    const lengthAt = this.offset;
    this.u16(0);
    const start = this.offset;
    return () => {
      const length = this.offset - start;
      this.bytes[lengthAt] = length >> 8;
      this.bytes[lengthAt + 1] = length & 0xff;
    };
  }
  build() {
    return Uint8Array.from(this.bytes);
  }
}

/** The service name as a question at offset 12: `_nanoleafapi` at 12, `_tcp` at 25, `local` at 30. */
function header(packet, { id = 0, flags = 0x8400, questions = 1, answers = 0, additional = 0 } = {}) {
  packet.u16(id).u16(flags).u16(questions).u16(answers).u16(0).u16(additional);
  if (questions) packet.label("_nanoleafapi").label("_tcp").label("local").end().u16(12).u16(0x8001);
}

/** A full answer the way a DNS-SD responder sends it: PTR, then SRV, TXT, A, AAAA and NSEC, all compressed. */
function shapesAnswer({ id = 0 } = {}) {
  const p = new Packet();
  header(p, { id, answers: 1, additional: 5 });
  p.pointer(12);
  let done = p.record(12);
  const instance = p.offset;
  p.label("Shapes 6297").pointer(12);
  done();

  p.pointer(instance);
  done = p.record(33, 0x8001, 120);
  p.u16(0).u16(0).u16(16021);
  const target = p.offset;
  p.label("Shapes-6297").pointer(30);
  done();

  p.pointer(instance);
  done = p.record(16, 0x8001, 4500);
  p.label("md=NL42").label("srcvers=9.2.4").label("id=4A:6F:21:9C:0B:11").label("MD=ignored").u8(0).label("flag");
  done();

  p.pointer(target);
  done = p.record(1, 0x8001, 120);
  p.u8(192).u8(168).u8(1).u8(40);
  done();

  p.pointer(target);
  done = p.record(28, 0x8001, 120);
  p.u16(0xfe80).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(1);
  done();

  p.pointer(instance);
  done = p.record(47, 0x8001, 120);
  p.pointer(instance).u8(0).u8(1).u8(0x40);
  done();
  return p.build();
}

test("buildMdnsQuery is a one-question PTR query for _nanoleafapi._tcp.local with the QU bit", () => {
  const expected = [
    [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
    [12, ..."_nanoleafapi"].map((c) => (typeof c === "string" ? c.charCodeAt(0) : c)),
    [4, ..."_tcp"].map((c) => (typeof c === "string" ? c.charCodeAt(0) : c)),
    [5, ..."local"].map((c) => (typeof c === "string" ? c.charCodeAt(0) : c)),
    [0, 0, 12, 0x80, 1],
  ].flat();
  assert.deepEqual(Array.from(buildMdnsQuery()), expected);
  const parsed = parseDnsMessage(buildMdnsQuery([{ name: "Shapes 6297._nanoleafapi._tcp.local", type: 33 }], 7));
  assert.equal(parsed.id, 7);
  assert.equal(parsed.response, false);
  assert.deepEqual(parsed.questions, [
    { name: "Shapes 6297._nanoleafapi._tcp.local", type: 33, unicastResponse: true },
  ]);
  assert.throws(() => buildMdnsQuery([{ name: `${"x".repeat(64)}.local`, type: 1 }]), RangeError);
});

test("parseDnsMessage follows compression pointers through every record type", () => {
  const message = parseDnsMessage(shapesAnswer({ id: 0x1234 }));
  assert.equal(message.id, 0x1234);
  assert.equal(message.response, true);
  assert.deepEqual(message.questions, [{ name: "_nanoleafapi._tcp.local", type: 12, unicastResponse: true }]);
  assert.deepEqual(
    message.records.map((record) => [record.type, record.name]),
    [
      ["PTR", "_nanoleafapi._tcp.local"],
      ["SRV", "Shapes 6297._nanoleafapi._tcp.local"],
      ["TXT", "Shapes 6297._nanoleafapi._tcp.local"],
      ["A", "Shapes-6297.local"],
      ["AAAA", "Shapes-6297.local"],
      ["other", "Shapes 6297._nanoleafapi._tcp.local"],
    ],
  );
  const [ptr, srv, txt, a, aaaa, nsec] = message.records;
  assert.equal(ptr.target, "Shapes 6297._nanoleafapi._tcp.local");
  assert.deepEqual([srv.port, srv.target, srv.ttl], [16021, "Shapes-6297.local", 120]);
  assert.deepEqual(txt.entries, ["md=NL42", "srcvers=9.2.4", "id=4A:6F:21:9C:0B:11", "MD=ignored", "flag"]);
  assert.equal(a.address, "192.168.1.40");
  assert.equal(aaaa.address, "fe80::1");
  assert.equal(nsec.code, 47);
});

test("parseMdns resolves a controller, preferring the A record", () => {
  assert.deepEqual(parseMdns(shapesAnswer(), "10.0.0.9"), [
    { host: "192.168.1.40", port: 16021, name: "Shapes 6297", model: "NL42", id: "4A:6F:21:9C:0B:11", source: "mdns" },
  ]);
});

test("parseMdns falls back to the sender's IPv4 address, then a routable IPv6 one", () => {
  const p = new Packet();
  header(p, { answers: 2, additional: 2 });
  p.pointer(12);
  let done = p.record(12);
  const first = p.offset;
  p.label("Hexagons A.B").pointer(12);
  done();
  p.pointer(12);
  done = p.record(12);
  const second = p.offset;
  p.label("Triangles").pointer(12);
  done();
  p.pointer(second);
  done = p.record(33);
  p.u16(0).u16(0).u16(16022);
  const target = p.offset;
  p.label("tri").pointer(30);
  done();
  p.pointer(target);
  done = p.record(28);
  p.u16(0x2001).u16(0xdb8).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0x42);
  done();
  const bytes = p.build();

  const fromV4 = parseMdns(bytes, "192.168.1.77");
  assert.deepEqual(
    fromV4.map((found) => [found.name, found.host, found.port]),
    [
      ["Hexagons A.B", "192.168.1.77", 16021],
      ["Triangles", "192.168.1.77", 16022],
    ],
  );
  const fromV6 = parseMdns(bytes, "fe80::9");
  assert.deepEqual(
    fromV6.map((found) => [found.name, found.host]),
    [["Triangles", "2001:db8::42"]],
    "without an IPv4 address or a routable AAAA an instance is skipped",
  );
});

test("parseMdns ignores queries, other services and malformed packets", () => {
  assert.deepEqual(parseMdns(buildMdnsQuery(), "192.168.1.40"), []);
  const full = shapesAnswer();
  assert.deepEqual(parseMdns(full.subarray(0, full.length - 5), "192.168.1.40"), []);
  assert.deepEqual(parseMdns(full.subarray(0, 8), "192.168.1.40"), []);

  const loop = new Packet();
  header(loop, { questions: 0, answers: 1 });
  loop.pointer(12);
  assert.deepEqual(parseMdns(loop.build(), "192.168.1.40"), []);
  assert.throws(() => parseDnsMessage(loop.build()), /pointer/);

  const other = new Packet();
  header(other, { questions: 0, answers: 1 });
  other.label("_hap").label("_tcp").label("local").end();
  const done = other.record(12);
  other.label("Lamp").pointer(12 + 5);
  done();
  assert.deepEqual(parseMdns(other.build(), "192.168.1.9"), []);
});

const SHAPES_SSDP = [
  "HTTP/1.1 200 OK",
  "S: uuid:2f402f80-da50-11e1-9b23-001788255acc",
  "Ext: ",
  'Cache-Control: no-cache="Ext", max-age = 60',
  "ST: nanoleaf:nl42",
  "USN: uuid:2f402f80-da50-11e1-9b23-001788255acc",
  "Location: http://192.168.1.40:16021",
  "nl-deviceid: 46:EC:1B:0D:67:32",
  "nl-devicename: Shapes 6297",
  "",
  "",
].join("\r\n");

const RENDERER_SSDP = [
  "HTTP/1.1 200 OK",
  "ST: urn:schemas-upnp-org:device:MediaRenderer:1",
  "Location: http://192.168.1.9/",
  "",
  "",
].join("\r\n");

const CANVAS_SSDP = [
  "HTTP/1.1 200 OK",
  "st: nanoleaf:nl29",
  "location: http://192.168.1.41:16021",
  "NL-DeviceName: Canvas 1A2B",
  "",
  "",
].join("\r\n");

test("parseSsdp reads a Shapes search response", () => {
  assert.deepEqual(parseSsdp(SHAPES_SSDP, "192.168.1.40"), {
    host: "192.168.1.40",
    port: 16021,
    name: "Shapes 6297",
    model: "NL42",
    id: "46:EC:1B:0D:67:32",
    source: "ssdp",
  });
});

test("parseSsdp: case-insensitive headers, NOTIFY, legacy Aurora, missing Location, and what it rejects", () => {
  const canvas = "HTTP/1.1 200 OK\nst: Nanoleaf:NL29\nLOCATION: http://192.168.1.41:16021/\nNL-DEVICENAME: Canvas\n\n";
  assert.deepEqual(parseSsdp(canvas, "192.168.1.41"), {
    host: "192.168.1.41",
    port: 16021,
    name: "Canvas",
    model: "NL29",
    id: null,
    source: "ssdp",
  });
  const notify = [
    "NOTIFY * HTTP/1.1",
    "NT: Nanoleaf_aurora:light",
    "NTS: ssdp:alive",
    "Location: http://[fe80::1]:16021",
    "",
    "",
  ].join("\r\n");
  assert.deepEqual(parseSsdp(notify, "192.168.1.5"), {
    host: "fe80::1",
    port: 16021,
    name: null,
    model: null,
    id: null,
    source: "ssdp",
  });
  const bare = "HTTP/1.1 200 OK\r\nST: ssdp:all\r\nnl-deviceid: AA\r\n\r\n";
  assert.deepEqual(parseSsdp(bare, "192.168.1.6"), {
    host: "192.168.1.6",
    port: 16021,
    name: null,
    model: null,
    id: "AA",
    source: "ssdp",
  });
  assert.equal(parseSsdp(notify.replace("ssdp:alive", "ssdp:byebye"), "192.168.1.5"), null);
  assert.equal(parseSsdp(RENDERER_SSDP, "192.168.1.9"), null);
  assert.equal(parseSsdp(buildSsdpSearch("nanoleaf:nl42"), "192.168.1.2"), null);
  assert.equal(parseSsdp("HTTP/1.1 404 Not Found\r\nST: nanoleaf:nl42\r\n\r\n", "192.168.1.2"), null);
});

test("buildSsdpSearch is a well-formed M-SEARCH", () => {
  assert.equal(
    buildSsdpSearch("nanoleaf:nl42"),
    'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: nanoleaf:nl42\r\n\r\n',
  );
});

test("mergeFound dedupes by host, lets mDNS win and SSDP fill gaps, and sorts", () => {
  const mdns = [{ host: "192.168.1.40", port: 16021, name: "Shapes 6297", model: "NL42", id: null, source: "mdns" }];
  const ssdp = [
    { host: "192.168.1.40", port: 1, name: "Other", model: "NL99", id: "46:EC", source: "ssdp" },
    { host: "192.168.1.41", port: 16021, name: null, model: "NL29", id: null, source: "ssdp" },
    { host: "192.168.1.39", port: 16021, name: "Canvas", model: "NL29", id: null, source: "ssdp" },
  ];
  assert.deepEqual(mergeFound(mdns, ssdp), [
    { host: "192.168.1.39", port: 16021, name: "Canvas", model: "NL29", id: null, source: "ssdp" },
    { host: "192.168.1.40", port: 16021, name: "Shapes 6297", model: "NL42", id: "46:EC", source: "mdns" },
    { host: "192.168.1.41", port: 16021, name: null, model: "NL29", id: null, source: "ssdp" },
  ]);
});

/** A UDP responder on 127.0.0.1 that calls `answer(text or bytes, rinfo, reply)` for each packet. */
async function responder(answer) {
  const socket = createSocket("udp4");
  const received = [];
  socket.on("message", (message, rinfo) => {
    received.push(message);
    answer(message, rinfo, (bytes) => socket.send(bytes, rinfo.port, rinfo.address));
  });
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return { port: socket.address().port, received, close: () => socket.close() };
}

test("discover merges fake SSDP and mDNS responders on 127.0.0.1, asks for missing SRV, and closes", async (t) => {
  const ssdp = await responder((message, rinfo, reply) => {
    const text = message.toString();
    if (text.includes("ST: nanoleaf:nl42")) reply(SHAPES_SSDP);
    if (text.includes("ST: ssdp:all")) {
      reply(RENDERER_SSDP);
      reply(CANVAS_SSDP);
    }
  });
  t.after(ssdp.close);

  const mdnsQueries = [];
  const mdns = await responder((message, rinfo, reply) => {
    const query = parseDnsMessage(message);
    mdnsQueries.push(query.questions);
    const p = new Packet();
    if (query.questions[0].type === 12) {
      // The first answer carries the PTR alone, as some responders do.
      header(p, { id: query.id, answers: 1 });
      p.pointer(12);
      const done = p.record(12);
      p.label("Shapes 6297").pointer(12);
      done();
    } else {
      header(p, { id: query.id, questions: 0, answers: 3 });
      const instance = p.offset;
      p.label("Shapes 6297").label("_nanoleafapi").label("_tcp").label("local").end();
      let done = p.record(33);
      p.u16(0).u16(0).u16(16021);
      const target = p.offset;
      p.label("Shapes-6297").pointer(instance + 1 + 11 + 1 + 12 + 1 + 4);
      done();
      p.pointer(instance);
      done = p.record(16);
      p.label("md=NL42").label("id=4A:6F:21:9C:0B:11");
      done();
      p.pointer(target);
      done = p.record(1);
      p.u8(192).u8(168).u8(1).u8(40);
      done();
    }
    reply(p.build());
  });
  t.after(mdns.close);

  const sent = [];
  const closed = [];
  const createFake = (purpose) => {
    const socket = createSocket("udp4");
    const send = socket.send.bind(socket);
    socket.send = (bytes, port, address, callback) => {
      sent.push({ purpose, port, address, text: Buffer.from(bytes).toString("latin1"), at: Date.now() });
      return send(bytes, purpose === "ssdp" ? ssdp.port : mdns.port, "127.0.0.1", callback);
    };
    const close = socket.close.bind(socket);
    socket.close = (...args) => {
      closed.push(purpose);
      return close(...args);
    };
    return socket;
  };

  const started = Date.now();
  const found = await discover({ timeoutMs: 600, createSocket: createFake });
  assert.ok(Date.now() - started >= 600);

  assert.deepEqual(found, [
    { host: "192.168.1.41", port: 16021, name: "Canvas 1A2B", model: "NL29", id: null, source: "ssdp" },
    { host: "192.168.1.40", port: 16021, name: "Shapes 6297", model: "NL42", id: "4A:6F:21:9C:0B:11", source: "mdns" },
  ]);

  const searches = sent.filter((entry) => entry.purpose === "ssdp");
  assert.equal(searches.length, 6, "three search targets, sent twice");
  assert.ok(searches.every((entry) => entry.address === "239.255.255.250" && entry.port === 1900));
  for (const target of ["ssdp:all", "nanoleaf:nl42", "nanoleaf_aurora:light"]) {
    assert.equal(searches.filter((entry) => entry.text.includes(`\r\nST: ${target}\r\n`)).length, 2);
  }
  assert.ok(searches[5].at - searches[0].at >= 250, "the second round goes out about 300 ms later");

  const queries = sent.filter((entry) => entry.purpose === "mdns");
  assert.ok(queries.every((entry) => entry.address === "224.0.0.251" && entry.port === 5353));
  assert.deepEqual(mdnsQueries, [
    [{ name: "_nanoleafapi._tcp.local", type: 12, unicastResponse: true }],
    [
      { name: "Shapes 6297._nanoleafapi._tcp.local", type: 33, unicastResponse: true },
      { name: "Shapes 6297._nanoleafapi._tcp.local", type: 16, unicastResponse: true },
    ],
  ]);
  assert.deepEqual(closed.sort(), ["mdns", "ssdp"]);
});

test("discover never rejects when sockets can't be made or used", async () => {
  const logged = [];
  const none = await discover({
    timeoutMs: 50,
    createSocket: () => {
      throw new Error("no sockets here");
    },
    log: (message) => logged.push(message),
  });
  assert.deepEqual(none, []);
  assert.equal(logged.length, 2);

  const broken = await discover({
    timeoutMs: 50,
    createSocket: () => {
      const socket = createSocket("udp4");
      socket.send = () => {
        throw new Error("EPERM");
      };
      return socket;
    },
    log: (message) => logged.push(message),
  });
  assert.deepEqual(broken, []);
});

test("discover ends early, sockets closed, when its signal aborts", async () => {
  const closed = [];
  const createFake = (purpose) => {
    const socket = createSocket("udp4");
    const close = socket.close.bind(socket);
    socket.close = (...args) => {
      closed.push(purpose);
      return close(...args);
    };
    socket.send = () => {};
    return socket;
  };
  const controller = new AbortController();
  const started = Date.now();
  const pending = discover({ timeoutMs: 5000, createSocket: createFake, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  assert.deepEqual(await pending, []);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(closed.sort(), ["mdns", "ssdp"]);

  const aborted = AbortSignal.abort();
  assert.deepEqual(await discover({ timeoutMs: 5000, createSocket: createFake, signal: aborted }), []);
});
