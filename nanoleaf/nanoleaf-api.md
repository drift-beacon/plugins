# Nanoleaf local OpenAPI: what this plugin relies on

A distilled reference for Nanoleaf **Shapes** (Hexagons, Triangles, Mini Triangles) as driven by this plugin. It comes from the official "Nanoleaf Light Panels Open API Documentation" (Confluence copy, version 8, edited 2026-07-08; the old `forum.nanoleaf.me/docs/openapi` now redirects to a support forum) plus the implementations and community reports listed under [Sources](#sources). Where the reports disagreed, the review that checked them against real layouts wins.

Each fact is tagged when it doesn't come straight from the official doc: **[code]** means it was verified in another project's source, **[community]** means a user report, and **[unverified]** means nobody has confirmed it. Section numbers are referenced from `DESIGN.md` (§3 endpoints, §5 extControl) and from the code.

## 1. Discovery

Neither mDNS nor SSDP crosses VLANs, and the Home Assistant add-on runs on a bridge network that sees no multicast at all. Manual IP entry must always work.

### 1.1 mDNS (DNS-SD)

- Service type `_nanoleafapi._tcp.local.`, for example the instance `Shapes 6297._nanoleafapi._tcp.local.` [community].
- The SRV record carries the port. It is 16021 by default, but the doc says not to hard-code it.
- TXT keys:
  - `md`: the model, for example `NL42`.
  - `srcvers`: the firmware version. Firmware 9.3.2 reported `1.1.0` here; 9.3.3 fixed it [community].
  - `id`: a random device ID that changes on factory reset. A reset also removes every API token.
- Controllers advertise IPv4 and IPv6. Since the Thread border-router firmware (8.5.2) this includes link-local `fe80::` addresses, and openHAB saw a device flip between them [community]. **Prefer the A record.**
- `_nanoleafms._tcp` is advertised too, but its port isn't the OpenAPI's [code].
- **How the plugin asks.** It sends one query from an ephemeral port, never binding 5353, which the OS responder owns. The query is a PTR question for `_nanoleafapi._tcp.local` with the unicast-response (QU) bit set, sent to `224.0.0.251:5353`.
  - A query whose source port isn't 5353 is a "legacy unicast" query (RFC 6762 §6.7). Responders must answer by unicast to that port, repeating the query ID and question.
  - DNS-SD responders normally add SRV, TXT and A records to a PTR answer. If one sends the PTR alone, ask for the instance's SRV and TXT. If there's no A record, the sender's address is the controller's.

### 1.2 SSDP

- Multicast group `239.255.255.250:1900`.
- **NOTIFY** is sent about every 60 s, with `NTS: ssdp:alive`, and `ssdp:byebye` when the device goes away. Its headers are `NT`, `USN: uuid:…`, `Location: http://<ip>:16021`, `Cache-Control: max-age = 60`, `nl-deviceid` and `nl-devicename`.
- **M-SEARCH.** The doc (written for Light Panels) says `ST` must be `ssdp:all` or `nanoleaf_aurora:light`.
  - The answer is a unicast `HTTP/1.1 200 OK` with `S`, `Ext`, `Cache-Control`, `ST`, `USN`, `Location` and `nl-deviceid`. The doc lists `nl-devicename` only for NOTIFY, but nanoleafapi reads it from search answers [code].
  - With `MX: M`, the answer is delayed by a random 0…M seconds.
- Types seen in `ST`/`NT` [code]:

  | Type | Product |
  |---|---|
  | `Nanoleaf_aurora:light` | Light Panels |
  | `nanoleaf:nl29` | Canvas |
  | `nanoleaf:nl42` | **Shapes** |
  | `nanoleaf:nl52` | Elements |
  | `nanoleaf:nl59` | Lines |
  | `nanoleaf:nl64` | Skylight |
  | `nanoleaf:nl69` | 4D |

- The plugin searches for `ssdp:all`, `nanoleaf:nl42` and `nanoleaf_aurora:light`, twice, 300 ms apart, from an ephemeral port. It keeps answers whose `ST`/`NT` mentions "nanoleaf" (case-insensitive). Headers are case-insensitive.

### 1.3 Model numbers

| Model | Product |
|---|---|
| NL22 | Light Panels |
| NL29 | Canvas |
| **NL42** | Shapes. Hexagon kits report it, and so do Triangles and mixed kits (both fixtures) |
| NL47, NL48 | Shapes Triangles and Mini Triangles retail models. Never seen in `GET /` [unverified] |
| NL52 | Elements |
| NL59 | Lines |
| NL64 | Skylight |
| NL69 | 4D |

**Treat the model as a hint only.** Decide what is supported after pairing, from the `shapeType`s in the layout.

## 2. Authentication and pairing

1. The user holds the controller's power button for 5–7 s until the LEDs flash in a pattern. This opens a 30 s pairing window.
2. `POST /api/v1/new` with no body:
   - **200** `{"auth_token": "…"}` on success.
   - Documented errors are 401, 403 and 422. **403 means the window isn't open** [code: aionanoleaf, homebridge-nanoleaf-scenes].
3. Poll about once a second until a token arrives or the window closes.

- Skylight has no button, so the Nanoleaf app's "Connect to API" (device settings) opens the window instead. Whether Shapes offer it too is [unverified].
- **Using the token.** It goes in the path: `/api/v1/<token>/…`. A wrong token gives **401**.
- **Revoking.** `DELETE /api/v1/<token>` gives **204**. Errors are 401 and 500.
- A token lasts until factory reset.
- A limit on the number of tokens is [unverified]. An old client's README claims five, first in, first out.
- **Doc rendering bug.** The HTML strips `<auth_token>` placeholders, so the doc's `GET /api/v1//events` means `/api/v1/<token>/events`.

## 3. Endpoints

The base is `http://<host>:16021/api/v1/<token>`. The pairing and revoke paths sit directly under `/api/v1`. Error statuses are 400 (bad request), 401 (bad token), 404 (no such resource) and 422 (unprocessable). The plugin serialises its requests to one controller, because a busy controller can drop requests [code: Chromatics].

**Retries.** Chromatics retries every mutating call three times with backoff "because a controller under load can drop a request", and aionanoleaf retries every method three times [code]. The plugin retries a request that got no answer, timed out or got a 5xx, twice (after 250 ms and 750 ms), keeping its place in the queue. It does this for GETs and for the PUTs that are safe to send twice: `/state` with absolute values, `/effects {select}`, and the `display`, `add` and `request` writes. It never retries `POST /new` (pairing polls anyway), `DELETE`, `/identify` or an `increment`.

**5xx.** The doc lists 500 only for revoke; whether the controller ever answers 5xx elsewhere is [unverified]. The plugin reads a 5xx as a transient failure (`server`), never as a refusal: a refusal (4xx) can make it give up on something, for example an effect the user deleted, and a busy controller mustn't cause that.

| Method | Path | Body | Success |
|---|---|---|---|
| POST | `/api/v1/new` | none | 200 `{"auth_token"}`; 403 when the window isn't open |
| DELETE | `/api/v1/<token>` | none | 204 |
| GET | `/` | none | 200: everything (shape below). Errors 401, 422 |
| GET | `/state` | none | 200 `{on:{value}, brightness:{value,max,min}, hue, sat, ct, colorMode}` |
| GET | `/state/on` | none | 200 `{value: true}` |
| GET | `/state/brightness`, `/state/hue`, `/state/sat`, `/state/ct` | none | 200 `{value, max, min}` |
| GET | `/state/colorMode` | none | 200 `"effect"`, `"hs"` or `"ct"` |
| PUT | `/state` | see below | 204 |
| GET | `/effects/select` | none | 200, a JSON string such as `"*Static*"` |
| GET | `/effects/effectsList` | none | 200 `string[]` |
| PUT | `/effects` | `{"select": "<name>"}` | 204 |
| PUT | `/effects` | `{"write": {…}}` (§4, §5) | 200 with a body (`request`), or 204 |
| GET | `/panelLayout` | none | 200 `{globalOrientation:{value,max:360,min:0}, layout:{numPanels, sideLength, positionData}}` |
| GET | `/panelLayout/layout` | none | 200 `{numPanels, sideLength, positionData:[{panelId,x,y,o,shapeType}]}` |
| GET | `/panelLayout/globalOrientation` | none | 200 `{value, max, min}` |
| PUT | `/panelLayout` | `{"globalOrientation": {"value": 120}}` | 204 (the plugin never writes this) |
| PUT | `/identify` | none | 204. **Flashes the whole wall**; there is no per-panel identify |
| GET | `/events?id=1,2,3,4` | none | 200 `text/event-stream` (§6) |

**`PUT /state` bodies:**
- `{"on": {"value": true}}`.
- `{"brightness": {"value": 0–100, "duration": <seconds>}}`, or `{"brightness": {"increment": -10}}`. `duration` is optional.
- `{"hue": {"value": 0–360}}`, `{"sat": {"value": 0–100}}` and `{"ct": {"value": 1200–6500}}`, or `increment` for any of them.
- Several keys can go in one body. aionanoleaf insists that **`on` is the last key**; the reason is [unverified], and the plugin always sends it last.

**`GET /` shape** (fields the plugin reads):

```ts
interface Info {
  name: string; serialNo: string; manufacturer: string; model: string; firmwareVersion: string;
  hardwareVersion?: string;
  state: {
    on: { value: boolean }; brightness: Range; hue: Range; sat: Range; ct: Range;
    colorMode: "effect" | "hs" | "ct";
  };
  effects: { select: string; effectsList: string[] };
  panelLayout: {
    globalOrientation: Range;
    layout: { numPanels: number; sideLength: number; positionData: PositionDatum[] };
  };
}
type Range = { value: number; max: number; min: number };
type PositionDatum = { panelId: number; x: number; y: number; o: number; shapeType: number };
```

- **Colour modes:** `effect` (static and dynamic effects), `hs` (hue and saturation) and `ct` (colour temperature). The `ct` range is 1200–6500 for Shapes, Canvas, Lines and Light Panels, and 1500–4000 for Elements. Firmware 1.5.0 wrongly reported 0–100.
- **Reserved effect names** from `/effects/select`:
  - `*Static*`: static colours per panel.
  - `*Dynamic*`: a temporary dynamic effect.
  - `*Solid*`: a hue/sat or ct colour.
  - `*ExtControl*`: streaming is active [code: hyperion, Chromatics, nanoleaf-claude-usage].
  - **Never "restore" a name in `*…*`** by selecting it.
- `numPanels` excludes the controller on Light Panels but includes it on Canvas and Shapes (see §8). Iterate `positionData` and don't trust `numPanels`.

## 4. Static and custom effects (`animData`)

**Grammar.** A space-separated string with no newlines:

```
numPanels  panelId numFrames R G B W T [R G B W T …]  panelId numFrames …
```

- `panelId` is written in decimal and can be any 16-bit value. For example, `36776` works on a real Shapes wall [community].
- `W` is ignored ("white LED is used automatically during white balancing").
- `T` is the transition to that colour in 100 ms units.
  - `T = -1` is a start frame, applied instantly. It is allowed only as a panel's first frame and not with `loop: true`.
  - A `T` of 0 was "not always honored" in one script [code], so use `T ≥ 1`.
- Frame counts may differ per panel.
- **A static effect** is one frame per panel.

**Commands** (`PUT /effects {"write": {…}}`):
- **`display`:** shows an effect temporarily without saving it. This is what the plugin uses.
- **`add`:** saves or overwrites a named effect in the user's list. Avoid it.
- **`displayTemp` + `duration` (seconds):** shows an effect, then reverts.
- **`request` + `animName`:** reads an effect back.
  - `{"command":"request","animName":"*Static*"}` returns the current static scene as `{animName, animType:"static", animData, …}`.
  - openHAB gets **404** when there is no static scene and **400** while a dynamic effect runs [code]. The plugin treats both as "no animData".

**The official static example:**

```json
{"write": {"command": "display", "animType": "static",
  "animData": "3 82 1 255 0 255 0 20 60 1 0 255 255 0 20 118 1 0 0 0 0 20",
  "loop": false, "palette": [], "colorType": "HSB"}}
```

- The doc marks `version: "1.0"` as required, but its own examples and nanoleafapi leave it out.
- **A looping pulse on the device** [code: nanoleafapi `pulsate`] gives each panel two frames with `loop: true` and `animType: "custom"`: `"<n> <id> 2 R G B 0 T r g b 0 T …"`.
- **A static write that leaves panels out turns them off** [community: openHAB 156893]. Always send every light panel.
- After a static display, `select` reads `*Static*`. After a custom one it presumably reads `*Dynamic*` [unverified].

## 5. External control streaming (extControl v2)

**Entering:**
- `PUT /effects` with `{"write": {"command": "display", "animType": "extControl", "extControlVersion": "v2"}}`.
- Shapes, Lines, Elements, Blocks, Skylight and 4D answer **204 with no body**. Frames then go by **UDP to the controller's own IP, port 60222**. This wording was added to the doc on 2026-07-07.
- Without `extControlVersion`, v1 is assumed, and non-Light-Panels devices answer with an error.
- Light Panels (v1) answer 200 with `{streamControlIpAddr, streamControlPort, streamControlProtocol: "udp"}`. The doc gives the port as 60221 in one place and 60222 in another.

**The v2 packet** (big-endian, `2 + 8·n` bytes):

| Bytes | Field |
|---|---|
| 2 | `nPanels` |
| then per panel: 2 | panel id |
| 1 + 1 + 1 | R, G, B |
| 1 | W (send 0; ignored) |
| 2 | transition time, in 100 ms units |

**The doc's example.** Panel 374 → (255, 0, 255) with T 12, panel 651 → (255, 255, 0) with T 128, and panel 235 → (0, 255, 255) with T 451:

```
00 03  01 76 FF 00 FF 00 00 0C  02 8B FF FF 00 00 00 80  00 EB 00 FF FF 00 01 C3
```

`tests/protocol.test.mjs` checks this byte for byte. For comparison, v1 (Light Panels) is `u8 nPanels`, then per panel `u8 id, u8 nFrames(=1), R, G, B, W, u8 T`.

**Behaviour:**
- **Rate.** "Must not stream data at a rate higher than 10Hz". 100 ms transitions stay smooth at 10 Hz.
- A frame need not include every panel; panels left out keep their state.
- A new frame restarts a panel's transition from its current in-between colour.
- **The whole frame is dropped when any id is unknown** [community: an Essentials lamp; assumed for Shapes]. Send only ids from the current layout, and never the controller (type 12).
- **Use an unconnected UDP socket** [community: light-sync]. With a connected one, an ICMP "port unreachable" from before the device opened 60222 surfaces as `ECONNREFUSED` on later sends.
- **Order of operations.** Read `select` and `state` first, then open the local socket, then enter extControl [code: nanoleaf-claude-usage]. That way a failure never strands the wall in `*ExtControl*` without a record of what to restore.
- **When streaming stops,** the panels hold the last frame and `select` stays `*ExtControl*` until something else is selected. No timeout is documented [unverified].
- **Addressing.** Frames go to the address the REST API answers on. For an IPv6 controller that means a udp6 socket. When the user enters a host name, the plugin resolves it once per stream and sends to the address. A `dgram` send to a name runs getaddrinfo every time, at 10 Hz, on the thread pool the whole process shares.
- **Leaving.** Select an effect, or write any other `display`. The Nanoleaf app, HomeKit or another client also ends it; the firmware then ignores frames [code: Chromatics].
- **Keep-alive.** Chromatics resends the last frame every 1 s and checks `select` every 30 s.
- **Power.** Hyperion makes sure the wall is on (`PUT /state {on:true}`) after entering. Whether frames show while `on=false` is [unverified].
- **Size.** 500 panels are 4002 bytes, over a 1500-byte MTU. Typical Shapes walls of 60 panels or fewer are under 500 bytes.

## 6. Events (SSE)

**Request.** `GET /api/v1/<token>/events?id=1,2,3,4` holds the connection open with `Content-Type: text/event-stream`.
- Each event is `id: <type>` then `data: <json>` then a blank line.
- Firmware needs to be newer than 3.1.0 on Light Panels and 1.10 on Canvas; Shapes have events from 4.0.2 [code: ioBroker].

**Event types.** The doc's prose calls touch "id=3"; its table is right: **1 state, 2 layout, 3 effects, 4 touch**.

| Id | Payload |
|---|---|
| 1 state | `{"events":[{"attr":1,"value":true},{"attr":2,"value":40}]}`. Attrs: 1 on, 2 brightness, 3 hue, 4 saturation, 5 cct, 6 colorMode |
| 2 layout | `{"events":[{"attr":1,"value":{numPanels,sideLength,positionData}},{"attr":2,"value":90}]}`. Attrs: 1 layout, 2 globalOrientation |
| 3 effects | `{"events":[{"attr":1,"value":"Flames"}]}` |
| 4 touch | `{"events":[{"gesture":0,"panelId":7},{"gesture":3,"panelId":-1}]}` |

**Touch gestures:** 0 single tap, 1 double tap, 2 swipe up, 3 swipe down, 4 swipe left and 5 swipe right. Swipes carry `panelId: -1`.
- The doc says only Canvas supports touch. That is out of date: openHAB supports touch on NL42, NL47 and NL48 [community].
- **By default a double tap toggles power.** Users can switch this off in the app.

**UDP touch stream.** The `TouchEventsPort: <port>` request header asks for fine-grained touch data by UDP while the SSE request (with id 4) lives. The format is a 2-byte count, then per panel a 2-byte id, 1 byte of touch type (hover, down, hold, up, swipe) and strength, and a 2-byte swiped-from id. The doc's layout of it is garbled, and the plugin doesn't use it.

**Robustness:**
- Whether the controller sends keep-alives or comments is [unverified]. The stream can be quiet for hours.
  - Node's `fetch` (undici) aborts a body after 300 s without data, so the plugin reads the stream with `node:http`.
  - It uses TCP keep-alive, and parses LF, CRLF and CR line ends, `:` comments and multi-line `data`.
- aionanoleaf reconnects after 5 s on errors [code]. The plugin backs off 1, 2, 5, 10, 20 and 30 s.
- The number of concurrent SSE clients a controller allows is [unverified].

## 7. Shape types

| `shapeType` | Shape | Side (layout units) | Lights? |
|---|---|---|---|
| 0 | Light Panels triangle | 150 | yes |
| 1 | Rhythm | — | no |
| 2 | Canvas square | 100 | yes |
| 3 | Canvas control square (primary) | 100 | yes |
| 4 | Canvas control square (passive) | 100 | yes |
| **7** | **Shapes hexagon** | **67** | **yes** |
| **8** | **Shapes triangle** | **134** | **yes** |
| **9** | **Shapes mini triangle** | **67** | **yes** |
| 12 | Shapes controller | — | no |
| 14 | Elements hexagon | 134 | yes |
| 15 | Elements hexagon corner | 33.5 / 58 | yes (6 per hexagon) |
| 16 | Lines connector | 11 | no |
| 17 | Light Lines | 154 | yes |
| 18 | Light Lines, single zone | 77 | yes |
| 19 | Controller cap | 11 | no |
| 20 | Power connector | 11 | no |
| 29 | 4D lightstrip | 50 | yes |
| 30, 31, 32 | Skylight panel, controller primary, controller passive | 180 | yes |

- Types 5 (power supply, in hyperion's enum only), 6, 10, 11, 13 and 21–28 are undocumented.
- The plugin drives **7, 8 and 9** only and draws everything else as an inert ghost.
- **Each Shapes panel is one colour zone** [code: openHAB `numLights = 1`]. A partial fill can only be an intensity on that panel.
- All three Shapes types can be mixed on one controller ("Connect+"), up to about 500 panels.

## 8. Layout geometry

- `(x, y)` is the panel's centroid, with **Y pointing up**. `o` is its orientation in degrees, **counter-clockwise**. The origin is arbitrary.
- **Global orientation.**
  - `positionData` is the same whatever the global orientation; the doc leaves it "to the developer to account for this".
  - Rotate every centroid by **θ = −globalOrientation** (counter-clockwise positive): `x' = x·cosθ − y·sinθ`, `y' = x·sinθ + y·cosθ`. Add θ to each `o`.
  - openHAB, hyperion and nanoleaf-claude-usage all use this sign [code].
  - Values like 59, 299 and 235 occur, so don't round them the way hyperion does (to 15°).
  - The orientation "doesn't know where the floor is", so offer a view rotation too.
- **Normalise `o` into [0, 360).** Shapes report multiples of 60, but Elements report 480, 600 and 660.
- **Side length comes from `shapeType`** (7 → 67, 8 → 134, 9 → 67). The doc says the layout's `sideLength` has been deprecated and 0 since firmware 5.0.0, yet real 6.5.1 layouts show both 0 (mixed) and 134 (triangles only). Never read it.
- **Triangles (8, 9).**
  - Circumradius R = side/√3; inradius r = side/(2√3).
  - Corner k sits at **90° + o + 120°·k** from the centroid.
  - So `o ∈ {0, 120, 240}` points up and `{60, 180, 300}` points down. This was measured on a real NL42 [code: nanoleaf-claude-usage] and matches openHAB.
- **Hexagons (7).**
  - R = side; inradius r = side·√3/2.
  - Corners at **o + 60°·k**, so flat top and bottom when o = 0.
  - Confirmed on the `theduck` fixture: a mini triangle meets a hexagon along the normal this predicts, and hexagon edges must be parallel to triangle edges.
- **Joins.** Edges are always parallel, but panels also join **offset by half a side** (a mini triangle against half a triangle's edge).
  - Test adjacency by projecting the centre-to-centre vector onto an edge normal: it must be ≈ rA + rB (±3 units).
  - The tangential part must be less than (sideA + sideB)/2.
- **The controller** (type 12) appears in `positionData` with real coordinates (panel id 0 in both Shapes fixtures), and `numPanels` counts it. Draw it as a marker and never send it a colour.
- **Scale.** A mini-triangle edge is about 11.5 cm = 67 units, so 1 unit ≈ 1.7 mm (retail listing; approximate).

## 9. Brightness and state

- **Global brightness** is 0–100 on panels. Essentials report a minimum of 1 and reject 0.
- **Global brightness multiplies everything.** "Universal Brightness fades Panels regardless of mode (Static, Dynamic, Solid) … universal multiplier". Per-panel RGB from static, custom or extControl writes is scaled by it.
- **The plugin's max brightness.** While it drives the wall, the plugin sets global brightness to the user's maximum and sends full-scale colours, keeping all 8 bits for partial fills. It restores the previous brightness afterwards.
- `brightness.duration` is in **seconds**.
- Home Assistant sets brightness without an explicit turn-on, which suggests a brightness `PUT` turns the wall on [unverified].
- **RGB 0, 0, 0 turns the LEDs off.** The panel then shows its diffuser and the room's light, not black: "Panels colours fade to white (or whatever ambient lighting is around)".
- **Colour mode and effect name go together:**
  - `hs`/`ct` ↔ `*Solid*`;
  - `effect` ↔ a named effect, `*Static*`, `*Dynamic*` or `*ExtControl*`.
- **The last writer wins.** The Nanoleaf app, HomeKit, Home Assistant's Nanoleaf integration and other streamers replace our output. Detect it with effects events (id 3) or by polling `select`.

## 10. Gotchas

1. A static write must include every light panel, or the missing ones turn off (§4).
2. One unknown id drops a whole extControl frame. Refresh the layout on layout events (id 2) before streaming (§5).
3. Stream from an unconnected UDP socket, at 10 Hz or less (§5).
4. Never select a `*…*` pseudo-effect to restore it. Use `*Static*` animData, hue/sat/ct, or a named effect (§3).
5. `on` goes last in `PUT /state` (§3).
6. `sideLength` is 0 or stale; use `shapeType` (§8). `numPanels` includes the controller (§3).
7. `o` can exceed 360; normalise it. Don't round `globalOrientation` (§8).
8. `/identify` flashes the whole wall. To point out one panel, light it in a frame that still lists every panel (§3).
9. Double tap toggles power by default (§6).
10. Prefer IPv4 from mDNS. IPv6 link-local addresses need a zone (§1), and a WHATWG URL (so `fetch`) can't carry one, so the plugin doesn't support them.
11. `fetch` bodies time out on a quiet SSE stream; use `node:http` (§6).
12. Don't gate support on the model string (§1.3).
13. Pairing answers 403 until the button has been held; poll (§2).
14. Use `T ≥ 1`; W is ignored (§4).

## 11. Unverified (test on hardware)

1. Whether `GET /` ever reports `NL47` or `NL48` on a Triangles or Mini Triangles kit.
2. Whether frames and static displays show while `on=false`, and whether an `/effects` write turns the wall on.
3. Whether extControl times out, or needs keep-alive frames.
4. Whether Shapes, like the Essentials lamp, drop a whole frame for an unknown id.
5. The `select` value after a `custom` display (`*Dynamic*`?).
6. The number of SSE clients allowed, and whether the controller ever sends SSE keep-alives.
7. Whether "Connect to API" in the app opens pairing for Shapes.
8. Whether Shapes answer an M-SEARCH for `ssdp:all` or `nanoleaf:nl42`, and whether their search answers carry `nl-devicename`.
9. Whether the controller's mDNS responder answers legacy unicast queries (RFC 6762 says it must) and includes SRV, TXT and A records with a PTR answer.
10. The token count limit.
11. Why `on` must be the last key in `PUT /state`.
12. Behaviour on firmware 12.x, where pairing reportedly moved into the app.
13. How the controller turns RGB values (extControl frames, static and custom animData) and global brightness into light: perceptually, so 128 looks about half as bright as 255 (like most RGB APIs), or linearly. The plugin assumes perceptual and sends the level as it is (`DEVICE_GAMMA = 1` in shared/color.ts, with a small floor so a lit panel never rounds to off). The emulator's wall page assumes the same. If low fills look too bright on a real wall, raise `DEVICE_GAMMA` towards 2.2.
14. Whether the controller answers 5xx (other than 500 for revoke) or drops requests under load, as Chromatics reports. The plugin retries both (§3).

## Sources

- Official doc, "Nanoleaf Light Panels Open API Documentation" (v8, 2026-07-08): https://nanoleaf.atlassian.net/wiki/spaces/nlapid/pages/2789310530 ; services list (OpenAPI on TCP 16021): https://nanoleaf.atlassian.net/wiki/spaces/nlapid/pages/3410591752
- openHAB Nanoleaf binding: https://github.com/openhab/openhab-addons/tree/main/bundles/org.openhab.binding.nanoleaf (`ShapeType.java`, `Triangle.java`, `Hexagon.java`, `NanoleafLayout.java`, `NanoleafControllerHandler.java`); layout fixtures: https://raw.githubusercontent.com/openhab/openhab-addons/main/bundles/org.openhab.binding.nanoleaf/src/test/resources/theduck.json (also `wings.json`, `lasvegas.json`, `spaceinvader.json`)
- openHAB community: https://community.openhab.org/t/nanoleaf-shapes-triangle-touch-support-does-not-work/151982 ; https://community.openhab.org/t/nanoleaf-canvas-setting-a-single-panel-turns-all-others-off/156893
- aionanoleaf: https://github.com/milanmeu/aionanoleaf ; aionanoleaf2: https://github.com/loebi-ch/aionanoleaf2
- Home Assistant integration (SSDP and zeroconf types): https://github.com/home-assistant/core/tree/dev/homeassistant/components/nanoleaf ; static animData on Shapes ids: https://community.home-assistant.io/t/nanoleaf-seperate-lights/335591 ; "Connect to API": https://community.home-assistant.io/t/687740
- nanoleafapi (`enable_extcontrol`, `pulsate`, SSDP discovery): https://github.com/MylesMor/nanoleafapi
- hyperion.ng: https://github.com/hyperion-project/hyperion.ng/blob/master/libsrc/leddevice/dev_net/LedDeviceNanoleaf.cpp
- nanoleaf-claude-usage (real NL42 geometry, streaming order): https://github.com/crstian19/nanoleaf-claude-usage
- light-sync protocol notes (unconnected sockets, dropped frames): https://github.com/hicham-bouchikhi/light-sync/blob/main/docs/NANOLEAF_PROTOCOL.md
- Chromatics Nanoleaf device (retries, keep-alive): https://github.com/logicallysynced/Chromatics/tree/master/Chromatics/Extensions/RGB.NET/Devices/Nanoleaf
- `T` of 0 not honoured: https://github.com/shawnoster/preflight/blob/main/bin/nanoleaf-streak
- ioBroker adapter (SSDP types, event firmware): npm `iobroker.nanoleaf-lightpanels`
- RFC 6762 (Multicast DNS, §6.7 legacy unicast): https://www.rfc-editor.org/rfc/rfc6762 ; RFC 6763 (DNS-SD): https://www.rfc-editor.org/rfc/rfc6763 ; RFC 1035 §4.1.4 (name compression): https://www.rfc-editor.org/rfc/rfc1035
- Server-sent events parsing: https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
