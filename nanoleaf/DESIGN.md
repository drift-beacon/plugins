# Nanoleaf plugin: design

The plugin drives Nanoleaf **Shapes** (Hexagons, Triangles, Mini Triangles) from Drift Beacon:

- **Live session:** the wall glows in the colour of the activity whose session is live for this user.
- **Goal progress:** if that activity has a goal, the panels fill one after another in a sequence. For example, 35% of a 5-panel goal is panel 1 full, panel 2 at 75%, and the rest dark (or a faint track).
- **Sequence:** auto-assigned by default. The user can change it by tapping panels on a drawing of the real layout, dragging rows in a list, or tapping the physical panels. It can also be randomised.
- **Max brightness:** a user setting.
- **Pinned activity (no live session):** a subtler glow or a pulse, whichever the user picks, with its goal progress if it has one.
- **Schedule fired:** the whole wall swells twice in the scheduled activity's colour, over whatever it shows, then goes back to it. An idle wall is taken for it and handed back.

- **Control by another plugin:** a plugin (Magic Cube first) or Home Assistant takes a lock on the wall and says what it shows, until it lets go. See [Control](#control-another-plugin-holds-the-wall).

This file is the contract the code follows. `shared/types.ts` holds the types; the sections below hold behaviour. `nanoleaf-api.md` is the distilled controller API reference.

## Decisions (and why)

| Question | Decision |
|---|---|
| Where device I/O runs | Only in main. The UI iframe is sandboxed (opaque origin, no LAN, no CORS), so the UI talks to main through the private channel (requests it makes, messages main posts), published state and storage. |
| How the interface reaches main | The private UI channel (SDK 0.2.4): `discover`, `pair`, `forget`, `refresh`, `preview` and `brightness` are requests main answers in `ctx.ui.handle`, typed in `shared/ui-channel.ts`. None is in `manifest.json`: a declared command is public API (an action in Home Assistant, and callable by any plugin that uses this one), and these are setup steps and editor plumbing, not automation verbs. See [Commands and the channel](#commands-and-the-channel). |
| What stays declared | `resume` (a useful action: take the wall back after the Nanoleaf app changed it), `takeControl` and `releaseControl` (the lock other plugins and automations hold the wall with), the `touch` event, and the `connection`, `output` and `control` state: what other plugins and automations run, hear and read. |
| Which hosts main accepts | The local network: private IPv4 (10/8, 172.16/12, 192.168/16), IPv6 unique local addresses (fc00::/7), and names that lead only to those when they are looked up. Anything public, link-local or the server's own loopback is refused before a request goes out (`main/src/lan.ts`): `pair` answers `invalid`, and a stored controller with such a host shows as `unreachable` with the reason and is not contacted. A redirect is never followed (`http.ts`). **This guards against mistakes, not attackers.** A controller is always on the LAN, so any other address is a mistyped or pasted-in error, and saying so beats probing it. It is not a security boundary: Drift Beacon is self-hosted and the workspace's members are trusted, and a host name is looked up again at each connection (REST, events and the frame stream each resolve it themselves), so the plugin goes wherever the name leads at that moment. Host names are supported on purpose (a `.local` or router name survives a new DHCP lease). A development build (`nanoleaf-dev`) also accepts loopback, where the emulator listens. |
| A controller whose address changed | Main finds it again by itself. Once two reconnects in a row have failed (about 2 s after the first failure, plus the requests' own time), and then at most once every 60 s while it stays unreachable, the Controller runs discovery and asks each address it found for `info()` with the stored token. It moves to an address only when that address passes the host check, accepts the token and reports the **stored serial number**; then storage `controller` gets the new host and port and the connection carries on, with nobody asking. A controller with another serial is never adopted, and nothing is searched when no serial was stored. Routers hand out new DHCP leases, and making the user re-enter an address (or pair again) for that is the kind of chore the plugin should absorb. Where discovery can't see the network (the Home Assistant add-on), nothing is found and behaviour is as before: the notice says to reserve a fixed address. See [Finding the controller again](#finding-the-controller-again). |
| Who holds a wall preview | The copy of the interface that asked (`meta.client.id`). Only it ends the preview with `none`, so one tab closing its editor doesn't end what another is showing; the latest request takes the wall whoever held it. It ends early when its copy closes (`ctx.ui.onClientsChange`); the lease's time limit stays the backstop. |
| Settings vs storage | `configuration: []`. A config change restarts the instance, and the UI can't write config, so everything the user adjusts lives in plugin storage (per user and workspace). |
| Drawing the wall | Real geometry from `positionData`: side length comes from `shapeType` (7→67, 8→134, 9→67). The layout's `sideLength` is ignored because it is 0 on newer firmware. |
| Driving the wall | `extControl` v2 over UDP port 60222: 10 Hz ticks, 100 ms transitions, and a keep-alive every 1 s. This gives smooth fills, pulses and crossfades, the UI preview matches the wall, and panel identification is instant. If `extControl` fails, main falls back to static `display` writes, at most one every 1.5 s. |
| Max brightness | While the plugin drives the wall, it sets the device's brightness to the max and sends full-scale colours. This keeps the full 8-bit range for partial fills. The previous brightness is restored on hand-back. |
| Partial fill | Intensity on the one colour zone each Shapes panel has. The level is sent as it is (no 2.2 gamma: the controller most likely maps RGB perceptually itself, nanoleaf-api.md §11), lifted so any lit panel is at least 3% (8/255), and rounded so a dim panel keeps its hue. The drawing uses the same mapping as opacity. |
| Whose sessions | The user's own live span (`memberIds` includes them), newest first. Otherwise the activity they have pinned. Otherwise nothing. This mirrors `live-activity-slot.ts` in core. |
| Progress maths | Mirrors the app (`packages/domain`). The period starts at local midnight / Sunday / the 1st / Jan 1. Completed sessions of all members are summed, plus the user's own live elapsed time. A span activity whose goal is a count counts sessions (what the goal editor promises), not duration. |
| Goals, periods and pins in the SDK | SDK 0.2.2 adds `goal`, `period` and `pinnedBy` to `ActivityData`, plus `Activity.isPinned`. The change is additive; with an older app the plugin still glows but shows no goal and no pin. |
| When nothing is live or pinned | A setting: hand the wall back to the scene it had before (default), or turn it off. |
| Someone else changes the wall | The plugin yields until something different should show, or until the user presses "Take it back". It does not fight the Nanoleaf app, HomeKit or Home Assistant. |
| Two users or workspaces, one controller | The first instance to drive the controller wins, through a module-level claim (all instances of a plugin share one host process). The others show `busy`. |
| Discovery | Hand-rolled SSDP M-SEARCH plus a one-shot mDNS query, both from ephemeral ports, with no dependencies. Manual IP entry always works; it is the only option inside the Home Assistant add-on (bridge network). |

## Control: another plugin holds the wall

Three priorities decide what the wall shows, with no exception:

| Priority | Source | How it is drawn |
|---|---|---|
| P1 | A schedule firing | `withAlert`: over every other layer, then back to what is underneath |
| P2 | A controller holding the lock | A scene of kind `control`, decided ahead of live and pinned |
| P3 | The user's sessions and pins | The `live` and `pinned` scenes, else `off` |

An interface preview sits between P1 and the scene, as before, so it covers a controller's effect too.

**Why a scene, not a layer.** `decideScene` returns a `ControlScene` while a lock is held, so everything a scene already gets applies: it swaps in and out with the staggered crossfade, takes an idle wall and hands it back after the grace, ends a yield (its key is new), and the interface draws it through the same `decideScene` and `renderFrame`. A new effect within one hold keeps the key (`control:<leaseId>`) and fades as an adjustment.

**The contract** (`manifest.json`; the Director's `takeControl` and `releaseControl`):

| Rule | Behaviour |
|---|---|
| Holder | From `meta.caller` (`holderOf`): a plugin's manifest id for its main code and its interface, `integration` for Home Assistant. Nobody names a holder |
| Free, or lapsed | Granted, with a new `leaseId` |
| The holder again | Granted under the same `leaseId`, expiry renewed. A different effect gets a new `effectId` and clock; an equal one (`sameSpec`) only renews |
| A `requestId` seen before | The stored answer, nothing changed. Each holder's last 8 are kept for 60 s |
| Someone else holds it | `granted: false`, `reason: "held"`, `holder`: an output, not an error (the platform has no `busy` code) |
| Driving or `allowControl` off | `granted: false`, `reason: "paused"` or `"not-allowed"`; switching either off ends a hold |
| Lease | `ttlMs` (default 30 s, 1 s–2 min) from the last call. A `reveal`'s lease is its own length (`REVEAL_MS`) from its start, whatever `ttlMs` says |
| Lapse | On the first tick past it; the lock lives in memory only, so a restart drops it |
| `releaseControl` | Only the holder, and only for the current lease when it names a `leaseId` |
| `shown` | The Director wants the wall and isn't in static fallback. `granted` without `shown` is a hold the panels can't show (offline, another instance driving, static writes) |

**A covered reveal is dropped.** Its clock starts when the command lands and never waits: under a schedule alert, an interface preview or a takeover still in progress it runs unseen and its lease ends on time. Nothing replays it.

**Effect clocks.** A `ControlEffect` carries `startedAt` on main's clock, inside the scene, so the scene a crossfade fades from keeps its own effect and clock. The interface asks main its time over the channel (`clock`) when it opens and on every resync, and moves `startedAt` onto its own clock (`ui/src/lib/control.ts`); a page opened part-way through a reveal draws it part-way through.

**Published.** `control`: `{ holder, leaseId, effect, since, expiresAt } | null`, on every change of the lock. `output.mode` is `control` while the effect is the scene (`activityId` and `fraction` null).

### effects.ts

`effectLight(prepared, k)` gives position `k` of `n` its colour and level at `dt = t − startedAt` (never negative). What looks random is `unit(seed, k, step)`, a hash seeded by the effect's id, so main and the interface draw the same frame.

- **`readEffect(request)`**: CSS colours → LED colours (`toLedRgb`), unparseable ones dropped; 1–`MAX_COLORS` (12) must remain; `periodMs` clamped to 400–10000, default pulse 4000, shuffle 900, reveal 600; a reveal needs `color`. Answers the problem as text otherwise (the handler throws `invalid`).
- **pulse**: colour `colors[k mod m]`. Level `CONTROL_PULSE_LOW + (1 − CONTROL_PULSE_LOW)·(0.5 − 0.5·cos(2π(dt/period − k/n)))`: one whole period spans the wall (a pin's pulse spans 0.3), which is what sets a one-colour palette apart from a pin.
- **shuffle**: panel `k` holds a colour for its own step, `period·(0.6 + 0.8·unit)`, offset by its own fraction of a step, then crossfades over `SHUFFLE_FADE_MS` (200) to the next. Even steps pick any colour; odd steps pick one unlike both neighbours, so no colour is held twice in a row (two colours alternate; one colour stays). Level pulses at `period` from `SHUFFLE_LOW` (0.35), each panel at its own phase.
- **reveal** (`REVEAL_MS` = 2700): panels shuffle until they lock to `color` one after another (`revealLockAt`: 120 ms apart, all by `REVEAL_LOCK_MS` = 1200, each over a 150 ms fade), then the wall swells twice (`REVEAL_BEAT_MS` = 450, down to 0.25), then holds at full for 600 ms.
- **Reduced motion** (the interface only): pulse and shuffle hold `colors[k mod m]` at 0.6; a reveal shows the winner.

## Architecture

```
            ┌──────────────────────── main (plugin host, Node) ────────────────────────┐
 ctx data ─▶│ scene.ts decideScene ─▶ Director ─▶ render.ts renderFrame ─▶ stream.ts   │─ UDP 60222 ─▶ panels
 storage  ─▶│      ▲ progress.ts        │  takeover / hand-back / yield    protocol.ts  │
            │      │                    ▼                                               │
            │   Controller ◀── http.ts (REST 16021) ◀── events.ts (SSE: state/layout/…) │
            │      │ publishes state `connection`, `output`; writes storage `layout`    │
            └──────┼────────────────────────────────────────────────────────────────────┘
                   │ channel (private): discover, pair, forget, refresh, preview, brightness
                   │ declared command: resume
            ┌──────▼──────────────────────── UI (iframe, React) ──────────────────────┐
            │ model.ts (live ctx or simulator) ─▶ same decideScene + renderFrame at 60fps │
            │ WallSection (layout drawing, order editor) · Now · Settings · Setup     │
            └─────────────────────────────────────────────────────────────────────────┘
```

`shared/` is imported by main, the UI, the tests and the emulator. Every file in it is pure (see the header of `shared/types.ts`).

## Files

```
nanoleaf/
  manifest.json            the declared command (resume), events and state (the source of truth for their shapes)
  DESIGN.md  nanoleaf-api.md  README.md
  shared/
    types.ts               the shared types (edit with care: everyone builds on them)
    storage.ts             read/validate/default every storage value
    geometry.ts            shapes, polygons, global orientation, bounds, adjacency
    order.ts               auto orders, seeded shuffle, resolving an order against a layout
    color.ts               CSS colour parsing, LED colour, mixing, level → device drive and drawing opacity
    progress.ts            goal progress for the current period
    scene.ts               decideScene
    render.ts              RenderState transitions and renderFrame (the one animation engine)
    effects.ts             a controller's effects (pulse, shuffle, reveal) and reading a request for one
    protocol.ts            extControl v2 packets, static animData (encode and parse)
    ui-channel.ts          the private channel: request and message types (module augmentation), input schemas
    lan.ts                 which addresses are on the local network, and why one isn't
  main/src/
    index.ts               definePlugin: wires Controller, Director, the channel's handlers and `resume`
    lan.ts                 the host check `pair` makes before anything connects
    claims.ts              module-level controller claims
    controller.ts          connection lifecycle, pairing, layout, SSE, published `connection`
    director.ts            scene → control → frames; hand-back; yield; preview; published `output`
    policy.ts              the Director's pure decisions (wanting control, `output`, yield, frame changes)
    wall.ts                takeover, release, yield and stop, one operation at a time
    takeover.ts            the device request sequences for takeover and hand-back
    handback.ts            capturing and planning the hand-back
    session.ts             per-tick frame sending and throttled brightness while in control
    ports.ts               injected types: timers, log, storage, link, client, stream
    nanoleaf/http.ts       REST client
    nanoleaf/stream.ts     UDP extControl streamer
    nanoleaf/events.ts     SSE client
    nanoleaf/discovery.ts  SSDP + mDNS discovery and their parsers
  ui/src/
    main.tsx  App.tsx  model.ts  live-model.ts  motion.ts  drift-beacon.ts  hero.ts  styles.css
    hooks/                 useScene, useRenderState, useLights, useWallPreview, useNow, useMediaQuery
    lib/                   colour, SVG, panel-name and preview-lease helpers
    components/…           see "UI" (wall/ holds WallSection and its parts, setup/ the SetupFlow)
    prototypes/            harness (Picker, SimPanel), sim model, fixtures
  tools/fake-nanoleaf.mjs  controller emulator; fake-nanoleaf-wall.html is its virtual wall page
  tests/*.test.mjs         node:test; fixtures/ holds real layouts (openHAB test data)
```

## Shared modules: contracts

All functions are pure and deterministic: they take time as `now`/`t` (ms or `Date`) and randomness as a seed.

### storage.ts
- `DEFAULT_SETTINGS: Settings` has these values:

  | Setting | Default |
  |---|---|
  | `enabled` | `true` |
  | `maxBrightness` | `80` |
  | `pinnedStyle` | `"pulse"` |
  | `pinnedLevel` | `35` |
  | `pinnedProgress` | `true` |
  | `track` | `true` |
  | `allowControl` | `true` |
  | `scheduleAlert` | `true` |
  | `idle` | `"restore"` |
  | `viewRotation` | `0` |

- `DEFAULT_ORDER: PanelOrder = { mode: "auto", auto: "path", ids: [], seed: 1 }`.
- `readSettings(raw: unknown): Settings` validates field by field: a bad or missing field falls back to its default, numbers are clamped to their documented ranges and rounded, and `viewRotation` is normalised to a multiple of 30 in [0, 360).
- The other readers follow the same rules:
  - `readOrder(raw): PanelOrder`: ids must be unique non-negative integers; the seed becomes an unsigned 32-bit integer.
  - `readController(raw): ControllerConfig | null`: requires host, port and token.
  - `readLayout(raw): Layout | null`: `o` and `globalOrientation` wrap into [0, 360); a missing `shapeType` is 0 (old Light Panels firmware).
  - `readHandback(raw): Handback | null`: requires `controllerId`, `on` and `brightness`.
- `sameLayout(a, b): boolean` compares `controllerId`, globalOrientation (modulo 360) and panels (id, x, y, o, shapeType, in any order), ignoring `fetchedAt`. Null and undefined are equal.

### geometry.ts

**Shape table.** `SHAPES: Record<number, { kind, side, sides: 0|3|4|6, light: boolean }>` (`sides: 0` draws a marker):

| Type | Shape | Side | Light |
|---|---|---|---|
| 7 | hexagon | 67 | yes |
| 8 | triangle | 134 | yes |
| 9 | mini triangle | 67 | yes |
| 12 | controller | — | no |
| 0 | Light Panels triangle | 150 | ghost |
| 2, 3, 4 | Canvas square | 100 | ghost |
| 14 | Elements hexagon | 134 | ghost |
| 15 | Elements corner | — | ghost marker |

"Ghost" and "ghost marker" mean the shape is drawn inert only.

**Coordinates.** Nanoleaf coordinates are Y up, and `o` is in degrees counter-clockwise. Normalise `o` into [0, 360).

**Global orientation and view rotation.** Rotate every centroid about the origin by θ = −globalOrientation + viewRotation (degrees, counter-clockwise positive): `x' = x·cosθ − y·sinθ`, `y' = x·sinθ + y·cosθ`. Add θ to each panel's orientation.

**Triangles (8, 9).**
- Circumradius R = side/√3, inradius r = side/(2√3).
- Corner k is at angle `90° + o' + 120°·k` from the centroid.
- So `o ∈ {0, 120, 240}` points up and `{60, 180, 300}` points down (before θ).

**Hexagons (7).**
- R = side, inradius r = side·√3/2.
- Corner k is at angle `o' + 60°·k`, which gives a flat top and bottom when o' = 0.

**`placeLayout(layout: Layout, viewRotation = 0): PlacedLayout`.**
- `panels` holds light panels only (types 7, 8, 9), sorted by id.
- `others` holds the controller (12, role "controller") and every other type (role "unsupported"). Corners are included where the shape is known.
- `bounds` covers every corner.

**`adjacency(panels: PlacedPanel[]): Map<number, number[]>`.** Two panels touch when, for some edge normal n of panel A (the direction from A's centre to an edge midpoint), both of these hold:
- the centre-to-centre vector d satisfies `|d·n − (rA + rB)| ≤ 3`;
- `|d × n| < (sideA + sideB)/2 − 1`.

This handles offset joins such as a mini triangle against half of a triangle's edge.

**Fixtures.** `tests/fixtures/theduck.json` (mixed 7/8/9 plus controller) and `wings.json` (nine triangles) are real Shapes layouts. Their panels must place edge to edge: every panel adjacent to at least one other, and no overlaps.

**Helpers:**
- `centroidOf(panels)`.
- `panelAt(placed, point)`: hit test with point-in-polygon.
- `fitView(bounds, width, height, padding) → { scale, tx, ty }`: maps Y-up layout space to SVG Y-down pixels via `sx = x·scale + tx`, `sy = −y·scale + ty`.

### order.ts

**`autoOrder(panels: PlacedPanel[], kind: AutoOrder): number[]`.**
- `left-right` sorts by x then y (descending); `right-left` mirrors it.
- `bottom-up` sorts by y then x; `top-down` mirrors it.
- `path` builds a walk over `adjacency` that feels like one continuous fill:
  1. **A walk with no jumps, when the wall has one.** A depth-first search (Warnsdorff: fewest unvisited neighbours first, then the smallest turn from the previous direction, then lowest y, then lowest x; capped at 20,000 steps) looks for a walk through every panel between neighbours. A panel with one neighbour must end such a walk, so it starts from those panels (lowest first), or from the lowest-then-leftmost panel when that can be an end; a wall with three or more of them has none.
  2. **Otherwise the greedy walk**, run from the lowest-then-leftmost panel and from every panel with one neighbour; the walk with the fewest jumps wins, then the shortest longest jump, then the least jumping overall (the lowest start on a tie). Each step goes to the unvisited neighbour that strands the fewest groups of unvisited panels, then by the Warnsdorff rules above.
  3. **Jumps stay on the edge of what is lit.** When stuck, the walk jumps to the nearest unvisited panel (by centroid) among those touching a lit one (ties: fewest unvisited neighbours, lowest, leftmost), so every prefix of the order is one piece of the wall and the fill never leaps across it. Only a wall in pieces (a join the geometry missed) falls back to the nearest unvisited panel once a piece is done.
  4. Every panel appears exactly once.
- The sweeps and the path follow the wall as it hangs: they use the placed layout, rotated by `viewRotation`, so main and the UI both resolve orders with it.
- Results are deterministic, whatever order the panels arrive in.

**`shuffle(ids: number[], seed: number): number[]`.** Fisher–Yates over a small seeded PRNG (mulberry32). The same seed and ids give the same result.

**`resolveOrder(order: PanelOrder, panels: PlacedPanel[]): number[]`.** The effective order for this layout:
- `auto` → `autoOrder(panels, order.auto)`.
- `random` → `shuffle(ids ascending, order.seed)`: a base that doesn't depend on the rotation, so rotating the drawing never reshuffles.
- `custom` → `order.ids` filtered to existing panels, then any missing panels appended in `path` order.

**`isComplete(order, panels)`** is true when `order.ids` covers exactly the layout's panels.

### color.ts
- `parseColor(css: string): Rgb | null` accepts `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` (comma or space syntax), `hsl()`/`hsla()` and the CSS named colours an activity might use (at least the 16 basic names plus `orange`, `pink`, `purple`, `teal`, `indigo`, `violet`, `gold`, `crimson`, `coral`, `salmon`, `turquoise`, `tomato`, `skyblue`, `slateblue`). Alpha is ignored. Anything unparseable → null.
- `toLedRgb(rgb): Rgb` scales so the brightest channel is 255; black becomes warm white `WARM_WHITE = [255, 214, 170]`.
- `mix(a, b, t): Rgb` (t clamped, channels rounded) and `cssRgb(rgb, alpha?): string` (`rgb(r g b)` or `rgb(r g b / a)`).
- **Level → light**, one mapping for the wall and the drawing:
  - `DEVICE_GAMMA = 1`: no curve of our own, because the controller most likely maps RGB perceptually itself (unverified on hardware, nanoleaf-api.md §11; the 2.2 gamma used before crushed the faint track, a pinned glow and a pulse's trough to black). If low fills look too bright on a real wall, raise it and nothing else.
  - `MIN_DRIVE = 0.03`. `deviceDrive(level) = level > 0 ? MIN_DRIVE + (1 − MIN_DRIVE)·min(level, 1)^DEVICE_GAMMA : 0`: any lit level is lifted (not clamped, so dim levels stay apart and a trough still moves) to at least 8/255.
  - `lightOpacity(level)`: the opacity the UI draws a light at so it looks like the wall (`deviceDrive(level)` while `DEVICE_GAMMA` is 1). Every place that draws panel light uses it, never the raw level.
  - `deviceRgb(light: PanelLight): Rgb` quantises `rgb × deviceDrive(level)` so the hue survives: the brightest channel is rounded (at least 8 when lit), the others follow from their unrounded ratios, and a channel the colour has stays at least 1 once the brightest is 8 or more. Level 0 (or less, or NaN) is black; above 1 counts as 1.
- `WARM_WHITE` is exported.

### progress.ts
- `periodStart(period: GoalPeriod | null, now: Date | number): Date | null` uses local time (the process's time zone in main):
  - day: midnight;
  - week: the Sunday at or before `now`, at midnight;
  - month: the 1st;
  - year: Jan 1;
  - null: all history.
- `goalProgress(activity: ActivityLike, sessions: readonly SessionLike[], userId: string, now: Date | number): GoalProgress | null` returns null when `activity.goal` is missing or null, the target is ≤ 0, or a point activity has a duration goal. It considers only sessions of this activity with `startedAt ≥ periodStart`, or every session when the period is null.
- **Duration goal:**
  - Sum `(endedAt − startedAt)` in seconds over completed spans from any member.
  - Add `now − startedAt` for the user's newest live span of this activity. This counts in full even when that span started before the period, as the app does.
  - Other members' live sessions don't count.
- **Count goal, point activity:** the number of point sessions (any member).
- **Count goal, span activity:** completed spans (any member), plus 1 if the user has a live span of it.

### scene.ts
`decideScene({ userId, activities, sessions, settings, now }): Scene` has three outcomes.

1. **Off.** When `settings.enabled` is false, the result is `OFF_SCENE` (`kind: "off"`, `key: "off"`, and everything else null or 0).
2. **Live.** Use the user's newest live span whose activity exists, archived or not: core's live-activity slot still shows a live session of an archived activity, so the wall glows for it too. `activities` is therefore every activity, archived included (main lists them with `includeArchived: true`).
   - `key = "live:" + session.id`, `level = 1`, `style = "glow"`, `track = settings.track`.
   - `progress = goalProgress(...)`.
   - `rgb = toLedRgb(parseColor(color) ?? WARM_WHITE)`, `cssColor = activity.color`.
3. **Pinned.** Otherwise use the first non-archived activity whose `pinnedBy` includes `userId`.
   - `key = "pinned:" + id`, `level = pinnedLevel/100`, `style = pinnedStyle`.
   - `progress = pinnedProgress ? goalProgress(...) : null`.
   - Otherwise the result is `OFF_SCENE`.

`progressPercent(fraction) = min(100, round(max(0, fraction)·100))` is the whole percent as the app's progress button shows it (0.346 → 35, 0.996 → 100); every percentage in the interface (Now card, scrubber, notices) uses it, so the plugin and the app never disagree by one. `describeProgress(progress, trackingType?)` gives the Now card its words (`percent` from `progressPercent`, "21 min" / "1 h", "3" / "5 times" or "5 sessions" for a span activity's count goal, "today" / "this week" / "in total"); `formatDuration(seconds)` gives "45 s", "21 min", "1 h 5 min".

### render.ts: the one animation engine (main at 10 Hz, UI at 60 fps)

**Constants.** `TRACK = 0.08`. `FADE_MS = 900`. `STAGGER_MS = 45` per position, `STAGGER_MAX_MS = 540`. `ADJUST_FADE_MS = 400`. `LEAP = 0.01`. `PULSE_MS = 4000`. `PULSE_LOW = 0.2`. `PULSE_SPREAD = 0.3` (fraction of a period across the order). `EDGE_MS = 2600`. `EDGE_BOOST = 0.07`. `SHIMMER_MS = 1800`. `PREVIEW_FADE_MS = 200`. Levels are the scene's; how bright they look is `color.ts`'s job (`deviceDrive`), so the faint track and a pulse's trough stay visible on the wall.

**Nothing jumps.** Every change fades from what is lit at that moment, never from a stored scene: at the instant of any `advance` or `withPreview`, the frame is exactly what it was (tested over seeded random sequences of changes landing in each other's fades).

**State functions:**
- `initialRenderState(scene, now): RenderState` has no previous scene and no moments, and remembers the scene's goal fraction.
- `advance(state, scene, now): RenderState` returns the same object when nothing changed. A change is one of:
  - **Swap** (something else to show: a new `key`, activity or `rgb`): `previous = state.scene`, `changedAt = now`, the full staggered `FADE_MS` crossfade. Goal-met moments go with the old scene (its wave fades out with it rather than lighting the new one).
  - **Adjust** (the same thing shown differently: style, level, track, progress shown or not, a new goal or target, a count step, a fill starting from nothing or going back to it, or a duration step of `LEAP` or more): the same, with `adjust = true`: one unstaggered `ADJUST_FADE_MS` fade, so settings toggles and goal edits don't snap. A running goal-met wave stays on top.
  - **In place** (a duration goal's fraction creeping by less than `LEAP`, e.g. a live session's per-second progress): the scene is replaced, no fade.
  - **Interrupted fades.** When a swap or adjust lands while a fade (or, for a swap, a goal-met wave) is still running, the whole old state becomes `from`: it goes on animating underneath (its own fade, pulse and wave), and the new fade starts from it. The chain is trimmed as fades finish and capped at 8 deep (a cut that deep only happens when changes arrive faster than they fade, e.g. a slider dragged at 60 Hz, where the dropped layer differs by a step).
  - **Goal met.** When the scene isn't off, its fraction is ≥ 1 and the fraction before was < 1, append `{kind:"goal-met", at: now}`. "Before" is the old scene's fraction when it showed the same activity; for a live session that has just appeared with a count goal, the count without it (the live span counts as one), so starting the final session celebrates even from an idle wall; otherwise the fraction last seen for that activity (`goals`, the newest 8 activities). So a pinned goal met while it shows celebrates too, and the initial state never does.
  - **Pruning.** Drop moments older than `SHIMMER_MS`, drop `previous` and `from` once the fade is over (`ADJUST_FADE_MS`, or `FADE_MS + STAGGER_MAX_MS` for a swap), and drop the preview fade's `previewFrom` once it is over.
- `withPreview(state, preview | null, now): RenderState` compares by value, so a renewal returns the same state. A new fill fraction updates in place (scrubbing never re-fades). Anything else (a preview starting, replacing another, changing colour or ending) fades over `PREVIEW_FADE_MS` from the preview layer as it is now (`previewFrom`, frozen at its fade weight but still blinking and sweeping), so replacing a preview never flashes the scene: identify moving to another panel keeps the rest dimmed, the scrubber turning into Play order goes fill → sweep, a preview shown again during a fade-out picks up where it was. `previewAt` (the blink and sweep clock) restarts only when a preview starts, its mode changes or identify gets different panels.
- `fromDark(state, now)`: the state as it should show when the plugin has just taken the wall: the scene and preview fade in as if from `OFF_SCENE`, and its moments and goal memory carry on (a fresh state would drop a goal met by the session that made the plugin take the wall).

**Per-panel base light for a scene.** `sceneLight(scene, k, n, t) → PanelLight` gives the light for position k (0-based) of n.

- **Off:** `{ rgb: WARM_WHITE, level: 0 }`.
- **Fill amount p:**
  - With progress: `f = min(fraction, 1)`, `filled = f·n`, `p = clamp(filled − k, 0, 1)`.
  - Without progress: `p = 1`.
- **Fill level.** `fill = progress && (track || bare) ? TRACK + (1 − TRACK)·p : p`, where `bare` is a pinned scene whose fraction is 0: a pinned goal with nothing done yet shows its track even with the track off, so the plugin never holds the wall dark (a live session is at nothing for a second at most).
- **Live:** `level = fill`. While `0 < fraction < 1`, the panel at `k = floor(filled)` (the one filling) breathes: `level = min(1, level + EDGE_BOOST·(0.5 − 0.5·cos(2πt/EDGE_MS)))`.
- **Pinned, glow:** `level = scene.level · fill`.
- **Pinned, pulse:** `level = scene.level · fill · w`, where `w = PULSE_LOW + (1 − PULSE_LOW)·(0.5 − 0.5·cos(2π(t/PULSE_MS − PULSE_SPREAD·k/max(n−1,1))))`.
- **Colour:** `scene.rgb`.

**`renderFrame(state, order: number[], t, opts?: { reducedMotion?: boolean }): Map<number, PanelLight>`.**
- **Crossfade.** While `previous` exists, each panel at position k fades after a delay `d = min(k·STAGGER_MS, STAGGER_MAX_MS)` (0 for an adjustment):
  - `u = easeInOutCubic(clamp((t − changedAt − d)/FADE_MS, 0, 1))` (`ADJUST_FADE_MS` for an adjustment);
  - blend the from side → `sceneLight(scene)`: rgb by `mix(…, u)`, level linearly. The from side is `from` drawn at `t` (recursively) when the fade interrupted another, else `sceneLight(previous)` at `t`.
  - If one side has level 0, take the other side's rgb so there's no fade through grey.
- **Goal-met shimmer.** For each goal-met moment, a bright wave travels along the order, on top of the crossfade:
  - `s = (t − at)/SHIMMER_MS · (n + 5) − 3` and `bump = exp(−(k − s)²/2)`, left out where `bump < 0.02`, so it arrives and leaves off the ends of the order and no panel steps;
  - `rgb = mix(rgb, [255,255,255], 0.5·bump)` and `level += (1 − level)·bump`.
- **Preview.** A preview replaces the scene, fading over `PREVIEW_FADE_MS` from `previewFadeAt`: from the layer it replaced (`previewFrom`, recursively, weighted as it was at the replacement) or from the scene. `c = preview.rgb ?? the scene's colour (crossfading with it) ?? WARM_WHITE`.
  - **identify:** listed panels are `{c, 1}` and the others `{c, 0.06}`. During the first 600 ms, listed panels blink twice: `level·(0.35 + 0.65·|cos(π·(t−previewAt)/300)|)`.
  - **fill:** the live rules with `fraction = preview.fraction`, track on, no edge breathing.
  - **order:** a looping sweep that replays the fill along the order. The period is `P = clamp(700 + 110·n, 1200, 4200)`, `h = ((t − previewAt) mod P)/P · (n + 2)`, and `level = 0.1 + 0.9·clamp(h − k, 0, 1)`.
- **Schedule alert.** Over everything, a preview included, and the same on every panel (no stagger: the wall moves as one). Constants: `ALERT_BEAT_MS = 900`, `ALERT_BEATS = 2`, `ALERT_LOW = 0.06`, `ALERT_IN_MS = 250`, `ALERT_OUT_MS = 500`, `ALERT_QUEUE = 3`; an alert lasts `ALERT_MS = 2·900 + 500 = 2300`. With `dt = t − at`:
  - its level is `ALERT_LOW + (1 − ALERT_LOW)·(0.5 − 0.5·cos(2π·dt/ALERT_BEAT_MS))` during the beats (`dt < 1800`), then `ALERT_LOW`: two swells to full, the first peak 450 ms in, nearly dark between them so it reads over a wall that was already full;
  - its weight over what is underneath is `easeInOutCubic(dt/ALERT_IN_MS)` during the beats and `1 − easeInOutCubic((dt − 1800)/ALERT_OUT_MS)` after them, so it starts from and returns to the frame underneath without a step;
  - `level += (alertLevel − level)·w` and `rgb = mix(rgb, alert.rgb, w)`; a dark panel takes the alert's colour.
  - `withAlert(state, rgb, now)` starts one now, or, while another runs, as that one's beats end (they crossfade, so schedules that fire together play one after the other); with `ALERT_QUEUE` there it returns `state`. `alerting(state, t)` is true while one runs or waits. `advance` drops finished ones and keeps the rest across scene changes.
- **Reduced motion.** `opts.reducedMotion` is used only by the UI:
  - a schedule alert holds `0.6` instead of swelling;
  - no crossfade stagger (a 150 ms fade instead);
  - no pulse wave (a steady `level·0.6`);
  - no edge breathing, no shimmer;
  - identify has no blinks.
- **Unordered panels.** Panels present in `order` but missing from the map are dark. The caller passes the resolved order, and n = order.length.
- **`isAnimating(state, t): boolean`** is true while a crossfade, moment or schedule alert is running, a preview is active or fading, the scene is a pinned pulse, or the scene is live with `0 < fraction < 1`.
- **Cost.** A frame allocates its result map, one light per panel, a few objects per layer (one per interrupted fade or replaced preview still running) and the odd mixed colour. Everything is deterministic in (state, order, t).
- `"arrive"` moments have no maths yet: they are pruned and counted by `isAnimating`, but not drawn.

### protocol.ts
- `encodeExtControlV2(lights: Iterable<readonly [id: number, rgb: Rgb, transitionDs?: number]>, transitionDs = 1): Uint8Array` is big-endian (a light's own transition overrides the default): u16 nPanels, then per panel u16 id, u8 R, G, B, u8 W = 0, u16 transition (in 100 ms units). The doc example (§5 in nanoleaf-api.md) must round-trip byte for byte.
- `decodeExtControlV2(bytes): { id, rgb, transitionDs }[]` is used by the emulator and tests; it throws on a malformed length.
- `staticAnimData(lights, transitionDs = 5): string` produces `"<n> <id> 1 R G B 0 T …"`. Callers must pass **every** light panel, because a static write that leaves panels out turns them off.
- `parseAnimData(s): Map<id, {r,g,b,w,t}[]>` is used by the emulator and tests.
- `staticDisplay(animData)` builds the `write` body for a static display; `API_PORT`, `EXT_CONTROL_PORT` and `EXT_CONTROL_V2_COMMAND` are exported.

### lan.ts
- `addressKind(host): "lan" | "loopback" | "link-local" | "outside" | null`: what kind of address `host` is (IPv6 without brackets), or null for a host name. `lan` is 10/8, 172.16/12, 192.168/16 and fc00::/7; `loopback` 127/8 and ::1; `link-local` 169.254/16 and fe80::/10; `outside` everything else, the unspecified addresses included. An IPv4-mapped IPv6 address is the kind of its IPv4 address.
- `parseIPv4(text)` (four dotted decimals, leading zeros read as decimal) and `parseIPv6(text)` (eight groups, or fewer around one `::`, the last two optionally dotted IPv4).
- `isHostOnly(host)`: whether it is a host and nothing more: a name or dotted IPv4 address (letters, digits, dots, hyphens) or an IPv6 address without brackets or zone. Anything else would mean something in `http://<host>:<port>/…` (a path, a port, a login). Main's host check and its REST client both refuse what fails it.
- `lanProblem(host, kind)`: why the plugin won't pair with it, and what to enter instead. Main (`main/src/lan.ts`) and the address field (`ui setup/address.ts`) both say it.
- `zonedAddress(host)`: for an address written with a zone (`fe80::1%en0`), the address before the `%` and its kind; null when there is no `%` or what precedes it isn't an IPv6 address (then it isn't a zone). `zoneProblem(address)` says to enter it without the zone, for an address that would otherwise do.

### ui-channel.ts
The private channel's types and input schemas; see [Commands and the channel](#commands-and-the-channel). It is the one shared file that imports the SDK (type-only, to augment `PluginUiRequests` and `PluginUiMessages`); the schema constants are plain data.

## Main

### http.ts: `NanoleafClient`
- `new NanoleafClient({ host, port = 16021, token?, timeoutMs = 4000, retryDelaysMs = [250, 750] })`. Uses global `fetch` with `AbortSignal.any([timeout, callerSignal])` and `redirect: "manual"`: a redirect (301, 302, 303, 307, 308) is never followed and fails as `rejected`. A controller doesn't send one, so one means the address isn't a controller's, and following it would take the request (a 307 or 308 with its method and body) somewhere nobody entered. Requests to one controller (`host:port`, across every client in the process) are serialised, one at a time; the timeout starts when a request's turn comes, and a queued request its caller aborts rejects without running.
- Methods:
  - `info()` → `GET /api/v1/<t>/`
  - `layout()` → `GET /panelLayout`, returns `{globalOrientation, positionData}`
  - `state()` → `GET /state` (a missing `on` or `brightness` reads as on and 100, so a hand-back never turns a wall off by mistake)
  - `select()` → `GET /effects/select`
  - `setState(patch)`: puts `on` last in the JSON
  - `selectEffect(name)`
  - `write(body)` → `PUT /effects {write}`
  - `enterExtControl()` → the v2 `display` write; it must return 2xx
  - `requestStatic()` → `write {command:"request", animName:"*Static*"}`, returning animData, or null on a 4xx refusal (404 no static scene, 400 a dynamic effect runs). A 5xx or no answer throws, so a transient failure never loses the user's static scene.
  - `write()` returns the body text when the answer isn't JSON
  - `identify()`
  - static `probe(host, port)`: any HTTP answer means it's reachable, except a redirect
  - static `requestToken(host, port, signal)` → `POST /api/v1/new`, which returns the token on 200, null on 401/403 (pairing window closed), and throws when unreachable
  - `revoke()` → `DELETE /api/v1/<t>`
- Errors are `NanoleafError` with an HTTP `status` when there is one and a `kind`:

  | kind | When | Transient (`isTransient`) |
  |---|---|---|
  | `unreachable` | No answer: refused, reset or unresolvable. Also a host nothing can be sent to, which fails before it queues and is never retried: a link-local IPv6 host with a zone (a WHATWG URL can't carry one), and a host that is more than a host (`shared/lan.ts` `isHostOnly`), which in the URL would choose the path, the port or a login | yes |
  | `timeout` | No answer within `timeoutMs` | yes |
  | `server` | A 5xx: the controller failed on its side (busy, rebooting) | yes |
  | `unauthorized` | 401: the token is bad | no |
  | `rejected` | Any other 4xx: the controller understood and refused. Also a redirect, which is never followed | no |

  Callers treat only `rejected` as a refusal ("the effect is gone"); `server` is a failure to retry later, like `unreachable`.
- **Retries.** A request that fails transiently is tried again after each `retryDelaysMs` (250 ms, then 750 ms), keeping its turn in the controller's queue, so a retried PUT can never land after a request made later. Each attempt gets the whole timeout. Retried: every GET, and the PUTs that are safe to send twice because they set absolute values or read: `setState` without an `increment`, `selectEffect`, and `write` for `display`, `displayTemp`, `add`, `request` and `requestAll` (so `enterExtControl`, static displays and `requestStatic`). Never retried: `setState` with an `increment` (it would apply twice), `write` `delete`/`rename`, `identify` (one flash was asked for), `revoke` (DELETE) and `requestToken` (POST; pairing polls it).

### stream.ts: `ExtControlStream`
- `new ExtControlStream(host, { port = 60222, createSocket?(type), lookup?, resolveRetryMs = 5000, now?, log?, onError? })`. Uses an **unconnected** `dgram` socket bound to an ephemeral port: `udp4` for an IPv4 address, `udp6` for an IPv6 one (bare or in brackets).
- **Host names are resolved once, never per frame.** A `dgram` send to a name runs getaddrinfo on libuv's small thread pool, shared by the whole plugin host, so at 10 Hz a slow resolver would stall every DNS lookup in the process (other plugins, REST reconnects). The stream looks the name up when it is created (`dns.lookup(host, { all: true })`, IPv4 preferred as in discovery) and sends to that address, from a socket whose own lookup is a pass-through. Frames sent before an address is known are dropped (`send` returns false), never queued. A failed lookup, or a failed send to a resolved name, triggers another lookup, one at a time and at most once per `resolveRetryMs`; frames keep going to the old address meanwhile.
- `send(lights, transitionDs)` encodes with protocol.ts. `close()`. `address` is where frames go (null while a name is unresolved).
- Send and lookup errors are counted and logged (the first, then every 100th), never thrown. `onError(error)` is told when frames start failing: the first error since creation or since a frame last went out.

### events.ts: `EventStream`
- Uses `node:http`, not `fetch`: undici's body timeout would kill a quiet stream. Requests `GET /api/v1/<t>/events?id=1,2,3,4`.
- Parses SSE into `onEvent({ id: 1|2|3|4, events: [...] })`, with typed helpers for state attributes, layout, effect name and touch gestures (0 tap, 1 double-tap, 2–5 swipe up/down/left/right).
- Reconnects with backoff [1, 2, 5, 10, 20, 30] s, reset after 60 s connected. `onStatus(open: boolean, error)` fires only when the stream opens or drops, never on `close()`. It starts connecting in its constructor. A 401 before the stream ever opens shows only in the log; the Controller detects 401 through `info()`. Failed attempts carry the same error kinds as http.ts (a 5xx answer is `server`).

### discovery.ts
`discover({ timeoutMs = 2500, createSocket?, signal?, log? }): Promise<FoundController[]>` runs SSDP and mDNS together, then merges and dedupes by host (mDNS data wins). `signal` ends it early.

**SSDP.**
- Send an M-SEARCH to 239.255.255.250:1900 from an ephemeral socket, with ST values `ssdp:all`, `nanoleaf:nl42` and `nanoleaf_aurora:light`, sent twice 300 ms apart.
- Accept responses whose ST or NT matches `/nanoleaf/i`, or that carry `nl-deviceid` / `nl-devicename`. `Location: http://ip:port`, `nl-devicename` and `nl-deviceid` supply the fields, and the model comes from the ST suffix (for example `NL42`).

**mDNS.**
- Send a one-shot query from an ephemeral port: a PTR query for `_nanoleafapi._tcp.local` with the unicast-response bit set, to 224.0.0.251:5353. Responders answer unicast to the querying port (legacy unicast; RFC 6762 §6.7).
- Parse PTR, SRV, TXT (`md`, `id`, `srcvers`) and A records, including name compression.
- Prefer IPv4. A PTR without SRV/TXT gets one follow-up query; without an A record the sender's IPv4 address is used. Link-local IPv6 is skipped.

**Exported pure parsers:** `parseSsdp(text, from)`, `buildMdnsQuery()`, `parseMdns(bytes, from)`.

### claims.ts
A module-level `Map<controllerId, owner>`, where owner is `{ token: symbol, label }`. `acquire(controllerId, owner): boolean` succeeds if the controller is free or already held by the same owner. `release(controllerId, owner)`. `holder(controllerId)`.

**Yield marks.** A yield to someone outside the plugin (the Nanoleaf app, HomeKit, Home Assistant) belongs to the controller, not to the instance that noticed it: `markYielded(controllerId, reason)` records a mark with a unique id, `yieldedMark(controllerId)` reads it, and `clearYielded(controllerId)` ends it when any instance takes the controller again. Without it, an instance that was `busy` (it never sees device events) would find the claim free the moment the holder yielded and take the wall straight back.

### controller.ts: `Controller`
`Controller` owns the connection and publishes `connection` state on every change, through a callback that index.ts wires to `ctx.state.set`.

**Lifecycle.** It starts from `readController(storage)`:
1. `unconfigured` if there is none.
2. Otherwise `connecting`, then the host check (`checkHost`, which index.ts wires to `assertLanHost`: the rule `pair` applies, since storage `controller` can hold a value from an older version or one written by hand), then `info()`, which leads to one of:
   - **connected:** write storage `layout` if `!sameLayout`, then open the `EventStream`;
   - **unauthorized** on 401;
   - **unreachable,** with backoff [2, 5, 10, 20, 30, 60] s and `retryAt` published; after the second failure in a row it also searches for the controller at another address (below);
   - **unreachable with no retry** (`retryAt` null) when the check refused the host: nothing was sent, `error` says what to enter instead, and nothing changes until the address does (the interface shows `error` and offers Edit address). A name nothing answers to is an ordinary `unreachable`, retried.
3. While connected:
   - **Layout event (id 2):** re-read the layout.
   - **State and effect events (ids 1, 3):** forward to the Director.
   - **Touch events (id 4):** `ctx.events.emit("touch", …)`.
   - **Stream closed:** check with `info()`, which moves to `unreachable` on failure. When it answers, its effect and power go to the Director as a device event: the controller doesn't replay events, so a change made while the stream was down would otherwise go unnoticed (the Director also reads the wall when the stream opens again).
   - **Health check:** every 30 s while the event stream is down.
   - **`reportError(error)`:** the Director hit a device error (a failed request, or extControl frames failing to send): check with `info()` now, so a revoked token shows as `unauthorized` and a vanished controller as `unreachable`. `rejected` errors are ignored.

**`pair(host, port, signal, deadline, onStep?)`.**
1. Check the host (`checkHost`): a host outside the local network fails with `PluginError("invalid", …)` before anything is sent. Then probe. If the controller can't be reached, fail with `PluginError("unavailable", …)`. Once it answers, `onStep("waiting")`.
2. Poll `requestToken` every 1 s until `deadline − 1500` ms. If no token arrives, fail with `PluginError("failed", "The controller didn't open its pairing window. Hold its power button for 5–7 seconds until the lights flash, then try again.")`. With a token, `onStep("connecting")`.
3. On success, read `info()`. If that fails, the fresh token is revoked (best effort) before the error is passed on: nothing was stored, so nothing would ever use it. When the pairing replaces a controller at another address, the Director hands the old one back first.
4. Quiet the old link (generation bumped, timers cleared, event stream closed), write storage `controller` (and `layout`), then adopt the new controller, publishing its config and controller id together (the Director never sees one controller's address with another's id), and return `{ name, model, panels }`.

`signal` is the request's `meta.signal`: it aborts at the deadline, when the interface gives the pairing up (it left the step), and when the instance starts stopping. The Controller also has its own stop signal, and pairing's host check, probe, token requests and waits use `AbortSignal.any([meta.signal, stop])`; after every await it checks that it hasn't stopped. Before a token is issued an abort ends the pairing with the signal's reason, and nothing was stored. Once a token was issued only a stop cancels, not the caller's deadline or its giving up: step 3's `info()`, revoke and hand-back use the stop signal alone, so the token is never left on the controller unused and the hand-back never strands the Director on the old controller. A request whose deadline passes meanwhile answers `timeout` and the pairing still completes (the interface treats that as "may have paired"). A pairing still running when the instance stops fails with `PluginError("stopped")` and stores, adopts and opens nothing; a token issued by then stays on the controller, since a stop ends the revoke too.

**`forget()`.** Asks the Director to hand back, then revokes the token (best effort, and only at a host that passes the check), sets storage `controller` and `layout` to null, and moves to `unconfigured`. The saved order is kept. While it hands back and revokes, nothing reconnects, re-reads the layout, checks or refreshes (a `refresh` then fails with `invalid`); afterwards it bumps the generation and closes the event stream again, so whatever a concurrent `pair` opened meanwhile goes too.

**`refresh()`.** Reconnects, re-reads the layout and returns `{ panels }`. It fails with `invalid` when the controller was forgotten meanwhile. Asked while the controller is `unreachable` (the notice's "Search again"), it also starts a search at once, whatever the 60 s pacing, and answers as soon as either the stored address or a found one connects.

#### Finding the controller again

A controller keeps its serial number and its tokens when its address changes; only storage `controller` is stale. So the Controller looks for the same controller elsewhere (`#startSearch`, `#searchFor`):

- **When.** In `#failed`, once `searchAfterFailures` (2) connection attempts in a row have failed and at least `searchEveryMs` (60 s) have passed since the last search started. With the backoff above that is: first failure, retry after 2 s, second failure → search; then no more than one search per retry and per minute (failures at 7, 17 and 37 s start none; the one at 67 s does; after that the retries are a minute apart). The retries of the stored address go on regardless. `refresh()` while unreachable starts one at once. Why the second failure: one failed request is routinely a busy controller or a Wi-Fi blip, and discovery costs 2.5 s of multicast.
- **Never** without a stored serial number (`controller.id` null: nothing to tell the controller by), while a `pair` or `forget` is in progress (starting either ends a search under way, and failures meanwhile start none), after `stop()` (which ends one under way), or when the token is refused (`unauthorized`). When the host check refused the stored host (`unreachable` with no retry: nothing was sent) the Controller starts none by itself, since nothing retries; Search again still does.
- **How.** `discover(signal)` (index.ts: SSDP and mDNS for 2.5 s, or the plugin option `discover` in tests), then for each address found other than the stored one, at most 8: the host check (`checkHost`, as for every connection), then `info()` with the stored token. Discovery's own `id` is a device id, not the serial number, so it decides nothing; the answer to `info()` does.
- **Adopting.** Only when `info().serialNo` equals the stored `id`. Then, as at the end of `pair`: the old link goes quiet (generation bumped, retry timer cleared), `#config` and storage `controller` get the new host and port (token, id, name and model unchanged), and `connection` goes straight to `connected` at the new address, in one step. The Director sees a new link and carries on (a leftover hand-back included). The interface follows through `connection` and storage `controller`; no message is posted, since nothing was paired or forgotten.
- **Not adopting.** Another serial (even if that controller accepted the token), no serial reported, a refused token (401), a host the check refuses (never contacted) or one that doesn't answer: logged at `info`, and the next candidate is tried. With no match nothing changes: the status stays `unreachable`, the stored address and its retries stay.
- **Giving way.** A search adopts nothing once its signal aborted, the stored controller changed (storage, `pair`, `forget`), or the controller answered at its stored address after all (connecting there ends the search).
- **What it sends.** The stored token goes, in a request path, to each address discovery reported as a Nanoleaf controller on the local network. Another controller in the house learns a token that isn't its own and refuses it. That is accepted for a home network.
- **Unverified on hardware:** that a real controller keeps its tokens across a new DHCP lease. It should (the token is the controller's, not tied to its address), and if it doesn't the search simply finds nothing to adopt (401) and the notice's Pair again path remains.

**Stop.** Clears the timers, closes the event stream, aborts its requests, pairing and search, and never opens an event stream afterwards (nothing would close it).

**Also:**
- `refresh` while connected keeps the status `connected`, so `output` doesn't blink to disconnected. Storage moving to another address is another connection: it goes through `connecting`, so nothing that runs while connected goes to a host that hasn't passed the check: not the Controller's checks and re-reads, and not the Director, which sends to a connected link's address (a leftover hand-back, a takeover).
- **`connected` is only ever shown with a host that passed the check.** `connection` and the Director's link carry the address of the stored controller as it is now, so a change of address and the move to `connecting` are one step, with the event stream closed silently inside it. Closing the stream first, as its own change, would show the old `connected` once more with the new address (and the Director acts on that at once). The same holds where a connection ends: a failed refresh, check or reconnect goes straight to `unreachable` or `unauthorized`, with `events: false` in that same change.
- After a 401 it stays `unauthorized` with no automatic retry, until the user pairs again.
- On connect it rewrites storage `controller` when the serial, name or model changed.
- `controllerIdOf(config, info?)` is the serial number, else `host:port`.

### director.ts: `Director`

**Inputs.** The Director reads:
- ctx data: `activities.list({ includeArchived: true })` data (a live session of an archived activity still glows, as core's live-activity-slot shows it; `decideScene` ignores archived pins), and `sessions.list()` data mapped to `SessionLike`;
- settings, order, layout, connection;
- the controller's state and effect events;
- preview leases and brightness overrides.

**Ticks.**
- A 100 ms `setInterval`, started in `onStart` and stopped in `onStop`.
- Every 1000 ms, and on any data, storage or connection change, it recomputes `decideScene` and calls `advance`.
- Each tick while in control:
  1. Run `renderFrame` over the resolved order.
  2. Convert with `deviceRgb`.
  3. Send when any channel changed by ≥ 1, or when 1000 ms have passed (keep-alive), with transition 1 (100 ms). A frame the stream drops (a host name not resolved yet) counts as unsent, so the next tick tries again.

**Wanting control.** It wants control when all of these hold:
- settings are enabled and the controller is connected;
- a non-off scene, an active preview or a schedule alert (playing, or waiting for the wall) exists;
- it has not yielded for this scene key;
- the claim can be acquired.

`output.mode` then shows what's happening (`busy` when the claim is held elsewhere, and so on).

**Takeover** (serialised, never re-entered):
1. Acquire the claim.
2. Build a `Handback` from `info()` (plus `requestStatic()` when the effect is `*Static*`). If storage already holds a handback for this controller and the wall still shows the plugin's own output (`stillOurs`: `*ExtControl*`, a restart while streaming; or `*Static*` while the stored scene wasn't static, the static fallback's frozen frame), keep the stored one. Write it to storage.
3. `setState({ brightness: { value: max, duration: 0 }, on: { value: true } })`.
4. `enterExtControl()`, then open the stream.
5. Mark in control (ending any yield mark on the controller) and send a full frame at once.
6. **Echo window.** For 2 s after the takeover, a report that would make it yield (another effect, `on=false`) may be an echo: the old effect announced again as the wall powers on, or another instance's hand-back just before. It is neither acted on nor dropped: when the window ends the Director reads the wall (`info()`: effect and power) and judges that. Only the takeover opens the window; brightness and static writes don't (their echoes, a brightness change and `*Static*`, never look like someone else).
7. If `enterExtControl` returns 4xx, fall back to **static mode**: `staticAnimData` of every panel at most every 1500 ms, with transition 10 when changed. A 5xx or no answer is a failed takeover, not a refusal.

**Release.** Release happens after not wanting control for 1500 ms (the grace period that avoids flicker between session end and pin, or between previews). The hand-back always puts the scene back first, in both modes:
1. Restore the effect:
   - a named effect (not `*…*`) → `selectEffect(effect)`;
   - `*Solid*` → set hue and sat (hs) or ct;
   - `*Static*` with animData → a static display write;
   - anything else → select the first saved effect.
2. Then restore brightness, with `on: false` in the same request when `settings.idle` is `off` or the wall was off before (`restore`).

Turning the wall off without the scene would leave the controller in `*ExtControl*` on the grace's last frame, which is black: the next power-on (the button, the Nanoleaf app, HomeKit) would show dark panels, and the user's scene would be lost for good. The price is that the scene shows for a moment before the wall goes off.

Afterwards it clears the storage `handback`, closes the stream and releases the claim. When the controller is unreachable it can only drop its local control state. When a hand-back fails (no answer, a timeout, a 5xx after the client's own retries), the stored `handback` stays and the leftover check below tries again after 2, 5, 10, then every 30 s (at once when the connection comes back).

**Yield.** While in control, yield when the controller reports an effect other than its own (`*ExtControl*`, or `*Static*` in static mode) or `on=false`, at once, except inside the takeover's echo window (step 6), where the report is read again when the window ends. Reports come from:
- the event stream (state and effect events);
- a read of effect and power whenever the event stream opens again, and the Controller's check when it drops (no events are replayed, so a change made in the gap is still seen);
- without the event stream, a `select()` poll every 15 s.

On yield: stop streaming, release the claim, don't restore, set `yieldedKey = scene.key`, mark the controller yielded (claims.ts), and report `output.mode = "yielded"`. Every other instance on the controller adopts the mark once: its current scene counts as yielded too, so an instance that was `busy` doesn't take the wall back from the Nanoleaf app. A yield clears when the scene key changes, on `resume` or an `enabled` toggle, and when any instance takes the controller again (the mark ends).

**`preview(request, owner)`** (the `preview` request; `owner` is the copy that asked, `meta.client.id`).
- Anything but `none` sets a lease `{ preview, until: now + (ttlMs ?? 4000), owner }`, whoever held the wall before: the latest request wins. The colour comes from `activityId` → that activity's colour, else the scene colour.
- `mode: "none"` clears the lease only when `owner` holds it (or nobody does): a copy closing its editor lets go of its own preview, not of another copy's.
- `endPreviewsExcept(open)` clears a lease whose holder is no longer among the open copies (index.ts calls it from `ctx.ui.onClientsChange`). A closed copy is reported about 5 s after its connection drops, so the lease's own time limit stays the backstop: the interface leases 4 s at a time.
- It returns `{ shown }`: whether the Director is (or is becoming) in control.

**`alert(activityId)`** (a schedule fired: `ctx.schedules.onTriggered`, every behaviour, pin or queue).
- Nothing happens when `settings.enabled` or `settings.scheduleAlert` is off. The colour is the activity's, else warm white.
- In control and streaming: `withAlert` at once. A live session doesn't suppress it; the scene underneath carries on and shows again afterwards.
- Not in control: the alert waits (`{ rgb, until: now + alertWaitMs }`, 5000 ms) and counts as something to show, so the Director takes the wall. `#tookOver` starts the waiting alerts from the takeover's time, not the trigger's, so the swell is whole however long the takeover took. Once it is over the wall is released after the usual grace.
- An alert that can't start in time is dropped, never played late: the wall is yielded for this scene, another instance holds the claim, the controller isn't connected, or the takeover failed. Static mode drops it too (writes 1.5 s apart can't swell).
- `output.mode` stays the scene's (`idle` with `inControl: true` on an otherwise idle wall): an alert is 2.3 s long and not worth a mode other plugins would have to learn.
- It returns `{ shown }`: it plays, or the wall is being taken for it.
- The interface's drawing doesn't show alerts: it derives what it draws from data, and an alert isn't in the data.

**`brightness(value)`** (the `brightness` request). Sets an override `{ value, until: now + 3000 }` and applies `setState({brightness:{value, duration: 0}})` right away when in control. Writes are throttled to one per 150 ms, and the trailing value always lands: a value counts as applied only once its write succeeds, and a failed write is tried again after 2, 5, 10, then every 30 s. When `settings.maxBrightness` changes while in control, it is applied the same way.

**Published `output`.** `{ mode, activityId, fraction (clamped 0–1.5, null without a goal), inControl, detail, since }`, published only when it changes (ignoring `since`). `fraction` is rounded to 0.001.

**Stop.** `onStop` closes the tick, stream and event stream. If it was in control, it hands back according to `settings.idle`, within the 5 s budget with a 3 s timeout, and releases the claim.

**Also** (the code is split into director.ts, policy.ts, wall.ts, takeover.ts, handback.ts and session.ts):
- **Fade-in.** A takeover fades the tracked render state in from dark (`fromDark`), so the wall fades in rather than jumping, a goal met by the change that caused the takeover still shimmers, and a restart in the middle of a session whose goal was met long ago doesn't replay the shimmer.
- **Failed takeover** (anything but a 4xx on extControl): it puts back what it had changed, frees the claim and retries after 2, 5, 10, then every 30 s, explaining in `output.detail`. `resume` (the declared command) resets the retries.
- **Leftover hand-back.** When storage holds a hand-back for this controller (a crash, a drop-out mid-stream, or a hand-back that failed) and nothing should show, it restores the wall if it still shows the plugin's output (`stillOurs`: `*ExtControl*`, or the static fallback's frozen `*Static*` frame over a scene that wasn't static), otherwise it just deletes the record. After a hand-back that failed partway, the scene it had already put back counts as the plugin's output too, until the connection moves, so brightness and power still follow. A failed attempt is tried again with the backoff above.
- **`handBack()`** (forget, or pairing another address) releases at once and takes nothing until the connection changes: its status, controller, address or token (so re-pairing the same controller at another address lifts it).
- **Output modes.** `yielded` and `busy` show only while something would otherwise be on the wall; otherwise `idle`. A layout without Shapes panels is `idle` with detail "The controller reports no Shapes panels". `preview` with `none` returns `{ shown: false }`.
- **Hand-back fallbacks.** Without a stored hand-back, for `*Solid*` without a colour, for other `*…*` effects, or when `select` is refused, it selects the first saved effect whose name isn't `*…*`. The stored hand-back is cleared on yield.
- **Static mode** counts a `*Static*` effect event as its own write.
- **Order.** The fill order is `resolveOrder(order, placeLayout(layout, settings.viewRotation).panels)`, exactly as the UI resolves it, because sweeps and the path's start and tie-breaks follow the wall as it hangs (a random order doesn't depend on the rotation).

### index.ts
- `onStart` must be fast. It builds the Controller and Director, registers the channel's handlers (`ctx.ui.handle`) and the `resume` command first, subscribes to `ctx.onDataChange`, `ctx.schedules.onTriggered` (→ `director.alert`, SDK 0.2.5) and `ctx.storage.onChange`, and publishes the initial `connection` and `output` state.
- It then starts connecting without awaiting it (`onStart` has a 15 s limit).
- Every async task has a `.catch` that logs.
- Handlers map device errors to `PluginError` codes (`requestError`): `unavailable` for anything worth trying again later (`isTransient`: no answer, a timeout or a 5xx), `failed` for the rest (a refusal, a bad token). Everything else passes through for the platform to answer: a `PluginError` (`invalid`, `stopped`) with its code and message, a request's own abort reason as `timeout` or `stopped`, and a bug as `failed` with a reference, its stack in the plugin's console.
- Messages to the interface go through `tell`, which logs a post that can't be sent (the instance is stopping) rather than failing the request that made it.
- The Controller's `discover` (for [finding the controller again](#finding-the-controller-again)) is `discovery.ts` listening for 2.5 s (`SEARCH_MS`), or `NanoleafPluginOptions.discover` when a test or tool supplies one.
- Device errors the Director hits while driving (REST failures, and `ExtControlStream`'s `onError` when frames start failing) go to `controller.reportError`.

### Commands and the channel

**Rule: declare a command only when something other than the plugin's own interface should run it.** A declared command is offered to Home Assistant as an action and to every plugin that lists this one in `uses`. The channel is routed only between this installation's main code and its own open interfaces, for the same user in the same workspace.

| Name | Where | Input (checked before the handler runs) | Answer |
|---|---|---|---|
| `resume` | Declared command (`manifest.json`), `ctx.commands.handle` | `{}` | Nothing. Stops yielding and takes the wall back |
| `takeControl` | Declared command | `{ effect, ttlMs?: 1000–120000, requestId? }` | `{ granted, reason, shown, holder, leaseId, effectId, expiresAt }`. See [Control](#control-another-plugin-holds-the-wall) |
| `releaseControl` | Declared command | `{ leaseId? }` | `{ released }` |
| `clock` | Channel | none | `{ now }`: main's time, for a controller's effect in the drawing |
| `discover` | Channel | `{ timeoutMs?: 500–8000 }` | `{ controllers: FoundController[] }`. Listens until 500 ms before the deadline at the latest; an abort ends it early |
| `pair` | Channel | `{ host, port?: 1–65535 }` | `{ name, model, panels }`. Refuses a host outside the local network (`invalid`) |
| `forget` | Channel | none | Nothing |
| `refresh` | Channel | none | `{ panels }` |
| `preview` | Channel | `{ mode, panelIds?, fraction?: 0–1, activityId?, ttlMs?: 500–15000 }` | `{ shown }`. Held by the copy that asked |
| `brightness` | Channel | `{ value: 1–100 }` | `{ applied }` |

- **Types** are in `shared/ui-channel.ts`, as a module augmentation of `PluginUiRequests` and `PluginUiMessages` that main and the UI both import: names, inputs, outputs and payloads are checked on both sides. Nothing is generated and nothing is in the manifest.
- **Inputs** are checked by the platform against `DISCOVER_INPUT`, `PAIR_INPUT`, `PREVIEW_INPUT` and `BRIGHTNESS_INPUT` (the manifest's schema subset, closed objects): a mismatch answers `invalid` and the handler never runs. The bounds are the ones the manifest declared before. Types aren't checks, so nothing relies on them.
- **Messages main posts** (`ctx.ui.post`, at most once, never replayed):
  - `pairing { step: "waiting" | "connecting" }`, to the copy that asked only (`to: meta.client.id`): the controller answered and main waits for its pairing window, then it handed out a token and main reads its layout. A post made before a handler returns reaches that copy before the answer.
  - `controllerChanged { change: "paired" | "forgotten" }`, to every open copy on every device (the one that asked included), once a pairing or a forgetting went through. The durable truth is still storage `controller` and the `connection` state; the message says it happened now. It doesn't say who did it, and the interface doesn't guess.
- **Which hosts `pair` accepts** (`main/src/lan.ts` `assertLanHost`, before anything connects). The check is there to catch mistakes (a mistyped address, a public one, a name that leads off the network) and explain them; it is not a defence against anyone:
  1. The host must be a host: a name or dotted address of letters, digits, dots and hyphens, or an IPv6 address. Anything a URL would read as a port, a path, a query or a login is `invalid` (`http.ts` builds `http://<host>:<port>/…`). So is an address with a zone (`fd00::1%eth0`): it is refused as the address itself would be (`fe80::1%en0` as link-local), else for the zone, which a URL can't carry. A `%` anywhere else isn't a host.
  2. It is judged as `fetch` will read it: `0x7f.1` and `2130706433` are 127.0.0.1, and `010.0.0.1` is 8.0.0.1.
  3. An address must be `lan` (`shared/lan.ts` `addressKind`): 10/8, 172.16/12, 192.168/16 or fc00::/7 (an IPv4-mapped IPv6 address counts as its IPv4 address). `loopback` (127/8, ::1) passes only in a development build. `link-local` (169.254/16, which includes cloud metadata addresses, and fe80::/10) and everything else are refused.
  4. A name is resolved (`dns.lookup`, all addresses) and every address must pass; a link-local IPv6 address beside the others is skipped (controllers advertise one, and it can't leave the link). A name nothing answers to is `unavailable`.
  - Each refusal says what to enter instead (`lanProblem`), and the address field refuses the addresses it can already judge in the same words.
  - **The stored controller passes the same check before every (re)connection** (the Controller's `checkHost`), and so does an address a search found: storage `controller` can hold a value from an older version or one written by hand, so it is judged like a host given to `pair`. One that fails is not contacted, nor shown as `connected` while it is being judged (the Controller's lifecycle, above).
  - **A redirect is never followed** (`http.ts`): a controller doesn't send one. The event stream (`node:http`) and the UDP frames don't follow anything either.
  - **The REST client refuses a host that is more than a host by itself** (`http.ts`, with `isHostOnly`), before anything is sent: whatever way a host reached it, it can't add a path, a port or a login to the URL.
  - **What it is not: a security boundary.** A name is looked up for the check and then again by every connection: each REST request, each (re)connect of the event stream, and the frame stream (once when it opens and after failures). Nothing pins those lookups to the checked answer, so the plugin goes wherever the name leads at that moment, and a name that changes its answer in between isn't caught. That is accepted: the people who can enter or store a host are the workspace's members, who are trusted. Someone who wants a fixed target enters the IP address and reserves it in the router.
- **Budgets** (the interface's `ctx.main.request` `timeoutMs`): `pair` 30 s, `discover` its listening time plus 2 s, `forget` and `refresh` 15 s, `preview` and `brightness` 1.5 s. A slider sends one request every 120 ms, and a copy may have 16 in flight: the short budget keeps the ones still waiting while main starts under that.

## UI

### Stack and rules
- The stack is copied from the siblings: React 19, HeroUI **v2** (2.8.3), Tailwind v4 + `hero.ts`, lucide-react icons, and `motion` 12 (`motion/react`). Colours come from the host theme: `../theme.css` maps the app's `--db-*` tokens (dark defaults before the app sends its theme) onto HeroUI's, so the UI follows a light or dark app. Use theme tokens, never hard-coded white or black; the pairing drawing of the controller is the one depiction that keeps its own dark colours.
- Bootstrap: `HeroUIProvider` > `MotionConfig reducedMotion="user"` > `App`.
- **Sandbox:** there's no `<form onSubmit>` (handle Enter and `onPress`), no `localStorage`, no `alert`/`confirm`, and no LAN fetches. All state goes through the model.
- **Motion** uses the tokens in `ui/src/motion.ts`:
  - EASE_OUT for enter and exit, with exits faster (0.12–0.15 s) than entrances (0.2–0.25 s).
  - Animate `transform` strings (`"translateY(8px)"`, `"scale(0.96)"`).
  - `AnimatePresence initial={false}`: `popLayout` for lists, `wait` plus a `blur(2px)` crossfade for swaps.
  - `layout` with SPRING_SETTLE for reorders.
  - CSS press feedback: `active:scale-[0.97]`, with 0.9 for small icon buttons.
  - Hover only for a real mouse (`pointerType === "mouse"` or `@media (hover:hover) and (pointer:fine)`).
  - Loops only for things that are live or waiting.
  - `useReducedMotion()` everywhere motion is more than an opacity change.
  - Timers tick; they never animate.
- **The wall preview is not React state per frame.** `useLights` runs one `requestAnimationFrame` loop that calls `renderFrame` and writes each panel's `fill`, `fill-opacity` and glow opacity through refs.
- **Visual language** (siblings):
  - Surfaces: stage `var(--db-surface)` (`STAGE_BG`; `.wall-stage` in wall.css keeps it a dark wall with dark tokens inside it in a light theme), cards `bg-content1`, `ring-1 ring-default-100`, hover `ring-default-200`.
  - Radii: `rounded-3xl` stage, `rounded-2xl` cards, `rounded-xl` buttons and chips, `rounded-full` pills.
  - Text: eyebrow labels `text-[10px] font-semibold uppercase tracking-wider text-default-400`, and `tabular-nums` for numbers.
  - Activity colour: tile `${c}26`, wash `linear-gradient(135deg, ${c}26, transparent 70%)`, glow `0 10px 30px -10px ${c}88`. Build these with `cssRgb`/alpha helpers, because the colour may not be hex.

### Data model (ui/src/model.ts)
The view never touches `ctx` directly. It reads a `NanoleafModel` from React context (`ModelProvider`, `useModel()`), so the prototype harness can render the real UI over a simulator.

```ts
export interface NanoleafModel {
  readonly userId: string;
  /** Every activity, archived included, app order: a live session on an archived activity still glows (as core's
   *  live-activity slot shows it). Lists and pickers filter `!archived`; `decideScene` ignores archived pins. */
  readonly activities: readonly ActivityLike[];
  readonly sessions: readonly SessionLike[];      // all, newest first
  readonly settings: Settings;
  readonly order: PanelOrder;
  readonly layout: Layout | null;
  /** The paired controller without its token. */
  readonly controller: { readonly host: string; readonly port: number; readonly name: string | null; readonly model: string | null } | null;
  readonly connection: ConnectionInfo | null;     // null until main publishes it
  readonly output: OutputInfo | null;             // null while main isn't running; the wall shows a scene only when `inControl`
  /** The platform's status, plus `connecting` while the page hasn't heard main's real status yet. */
  readonly mainStatus: "connecting" | "running" | "starting" | "unavailable" | "disabled" | "incompatible" | "not-installed";
  readonly mainStatusReason: string | null;
  /** The app sends goals and pins (SDK 0.2.2): some activity row has a `pinnedBy` array, or there are no activities. */
  readonly supportsGoals: boolean;
  readonly actions: {
    /** Applies locally at once; rejects (the SDK rolls back) when the app refuses. The model logs a refusal, so
     *  dropping the promise is safe; a control that can snap back catches it and says so. */
    saveSettings(patch: Partial<Settings>): Promise<void>;
    saveOrder(order: PanelOrder): Promise<void>;
    /** Aborting `signal` ends the search in main too. */
    discover(timeoutMs?: number, signal?: AbortSignal): Promise<readonly FoundController[]>;
    /** `signal` gives the pairing up (in main too, until the controller has handed out a token); `onStep` hears
     *  "waiting" (the controller answered) and "connecting" (it handed out a token). */
    pair(host: string, port?: number, options?: { signal?: AbortSignal; onStep?: (step: PairingStep) => void }): Promise<PairResult>;
    forget(): Promise<void>;
    refresh(): Promise<void>;
    resume(): Promise<void>;
    /** Fire and forget: the wall shows it for ttlMs (default 4000). */
    preview(request: PreviewRequest): Promise<void>;
    brightness(value: number): Promise<void>;
  };
  onTouch(listener: (panelId: number, gesture: TouchGesture) => void): () => void;
  /** The controller was paired or forgotten just now, by any copy (this one included): listeners are idempotent. */
  onControllerChanged(listener: (change: "paired" | "forgotten") => void): () => void;
  /** Main may have lost what this copy asked of it, or told it something it missed: ask again for what still matters. */
  onResync(listener: () => void): () => void;
}
```

- **Live implementation** (`useLiveModel()`): built on `useDriftBeacon()`, which re-renders on `ctx.onDataChange`; the SDK fires that after main's status and state change too, so there's no separate peer subscription.
  - Storage is read through the shared `read*` functions, and `connection`/`output` come from `ctx.plugins.self.state`.
  - **Values are kept by value, not identity** (`stableReader`): the SDK hands out a fresh copy of every stored object and published state value on each push, the host's echo of the page's own writes included. Each reader returns its previous object while the new value is equal (`sameLayout` for the layout, JSON for the rest), so rotating the drawing doesn't re-lay the wall out mid-turn and a slider release doesn't re-render every light.
  - Activities come from `ctx.activities.list({ includeArchived: true })`. Lists are memoised on the SDK list identity (it keeps it until the data changes).
  - **Main's status at open.** Before the hub's first report the app gives every peer a placeholder `unavailable` ("Waiting for Drift Beacon"). An `unavailable` the page opened with reads as `connecting` until the status changes or 3 s (`STATUS_WAIT_MS`) pass, so opening the page never flashes "isn't running"; `connecting` shows a neutral pill and no notice.
  - Storage writes go through `loggedWrite`: a refusal is logged and still rejects for the caller, and `saveSettings`/`saveOrder` return the SDK's promise itself (not an async wrapper), so a caller that drops it can't cause an unhandled rejection.
  - **Requests go over the private channel** (`createMainChannel(ctx.main)`, one per page): `ctx.main.request` for `discover`, `pair`, `forget`, `refresh`, `preview` and `brightness`, with the budgets in [Commands and the channel](#commands-and-the-channel). Inputs are clamped to what main accepts. A failed `preview` is swallowed (it is a nicety); everything else rejects with main's `PluginError`.
  - **`pair`** listens to `pairing` messages (`ctx.main.onMessage`) only while it runs and passes them to `onStep`; its `signal` is the request's, so aborting it rejects at once and reaches main's `meta.signal`.
  - **`onControllerChanged`** passes on every `controllerChanged` message, this copy's own pairing and forgetting included (main posts to every copy before it answers the one that asked). Nothing is suppressed: telling "ours" from "theirs" by whether a request of this copy was in flight dropped another copy's change made meanwhile, and for good when this copy's request then failed. Listeners are idempotent instead: they do what the news calls for only if it isn't done yet. The one consumer is the setup (`setup/closing.ts` `stepsAside`): only a setup still at Find closes, and only for `paired`; a copy's own pairing happens at Pair, where the news changes nothing, and closing is `setSetup(null)`, so hearing it twice closes once.
  - **`onResync`** is `ctx.main.onResync`, whatever the reason (`reconnected`, `missed`, `main-restarted`). Nothing the model shows comes from a message alone (controller, layout, connection and output are storage and published state, which the app delivers again by itself), so a resync only re-asserts what this copy holds in main: the wall preview is sent again at once, and a search that failed runs again.
  - Listening (from the first render) makes the page one of main's open copies (`ctx.ui.clients`).
  - `resume` is the one declared command: `ctx.plugins.self.command("resume")`, 3 s.
  - `onTouch` uses `ctx.plugins.self.onEvent("touch")`.
- **Simulator implementation:** see Prototypes.

### Hooks (ui/src/hooks)
- `useNow(ms, enabled)`.
- `useMediaQuery(query)`.
- `useScene(): Scene` runs `decideScene` from the model, recomputed every 1 s and on model change. It passes every activity, archived ones included, as main does: a live session of an archived activity still glows, and `decideScene` ignores only archived pins.
- `useRenderState(scene, preview): RenderStateRef`: a ref updated with `advance`/`withPreview` (`lib/renderState.ts` `stepRenderState`). A new preview object equal to the running order sweep restarts it from panel 1: a second save or Play asks for a fresh sweep, and `withPreview` alone would treat it as a renewal and end it part-way. A re-render or scene tick hands back the same object and keeps the phase.
- `useLights(stateRef, order, onFrame)`: the rAF loop, paused when the document is hidden. The drawing writes `fill-opacity = lightOpacity(level)` (`lib/light.ts`), the same curve and floor main drives the LEDs with, so a dim or part-filled panel looks as dim as on the wall; the bloom and floor glow use the same opacity.
- `useWallPreview(): { local, showLocal(preview, ms?), showWall(request, ms?) }`: two channels, because tap-to-order flashes the tapped panel on the wall while the drawing shows the editor's own marks. `local` is what the drawing shows; `showWall` sends leased `preview` requests (`lib/lease.ts`): it renews every 1500 ms with a 4000 ms lease while a request stands (and at once on the model's `onResync`, since main may have lost it), sends `mode:"none"` when cleared or unmounted, and throttles to one request per 120 ms (the latest always lands).

### Components
1. **`App.tsx`: the layout.**
   - Narrow (<768px, the iframe's own width): the stage is pinned to the top of the view, its drawing capped at 30% of the frame's height, and everything else is one list of sections under it (`PhoneSections`): Now on your wall, Fill order (the goal preview and the order editor as one card), What the wall does (the settings card), Controller. Each row says its current state and opens in place, one at a time; opening one brings it up under the stage. Every control shows its effect on the drawing, so the drawing stays in view. Notices sit above the stage and scroll away.
   - Wide: the `Board`. Two cards on top, `grid-cols-[minmax(0,1fr)_380px]` and equal height: the wall as one thing (the stage with its drawing capped at 300px, the Now card, the controller as one line with the Drive switch, Refresh and Forget, and Max brightness) and how it fills (the goal preview, then the order editor). Under them, "What the wall does": the settings as the wall's situations, one card each in three columns (an activity pinned, spanning two rows; a session live; a schedule firing; nothing going on; other plugins). The cards that make up one thing share a corner radius and ring and are separated by rules.
   - The two are separate trees: crossing 768px with a paired wall remounts the wall section, which a phone never does.
   - Setup (no controller yet, or pairing again) has no wall to pin, so it keeps one tree for both widths (CSS order): the controller card and the setup on the left with Now and Settings in a 320px column beside them (360px from 1280px), one column when narrow. Crossing 768px never remounts a setup in progress.
   - Unconfigured: the Setup flow replaces the wall.
   - A `Notice` strip covers unreachable (host, retry countdown, Search again/Edit address/Forget; when main won't connect to the stored address at all, `retryAt` is null and the notice shows `connection.error` instead), unauthorized (Pair again), busy, yielded (Take it back), paused, "main isn't running" (the plugin's status and reason) and "this Drift Beacon doesn't send goals or pins yet" (when `!supportsGoals`).
     - **Unreachable.** Main retries and searches by itself, so the notice needs no action; it says so, and suggests reserving a fixed address in the router (the fix where discovery can't see the network). "Search again" runs `refresh`: main tries the stored address and searches for the same controller elsewhere at once. When that finds nothing it says "Still can't find it…" rather than the device error; a request that outlives its budget says the search goes on. "Edit address" opens the setup, which pairs again.
     - Nothing about main or the controller shows while `mainStatus` is `connecting`. A platform reason becomes a sentence (`sentence`: it adds the full stop platform reasons lack) before what it means for the wall.
     - Only a notice's words (title, body, a failed action's message) are a `role="status"` live region, not its buttons. The retry countdown ticks on screen but is `aria-hidden`, with a steady sr-only "It keeps trying again by itself.", so a screen reader hears state changes, not a number every second.
2. **`NowCard`: what the wall shows now.**
   - Activity icon tile and name in its colour, and a status pill (`status.ts` `wallStatus`: Live / Pinned · Pulse / Idle / Paused / Offline / Busy / …). Live and Pinned only while main drives the wall (`output.inControl`); before main has heard, `Connecting` or `Starting` in a neutral tone, never danger.
   - **Only claims the wall while it shows it** (`onWall`, from `lib/showing.ts`). Otherwise the heading reads "Would show on your wall", the tile, wash and bar are greyed and still, and a line says what the wall really does: "Not on your wall: can't reach The Duck." (not paired, paused, starting, someone else driving, changed elsewhere, the plugin isn't running…).
   - For goals: `35% · 21 min of 1 h today` (from `describeProgress`, whose percent is the shared `progressPercent`, rounded as the app rounds) and "Panel 2 of 5 filling", in tabular numbers ticking every second.
   - A thin segmented bar mirroring the panels: segment k is as full as panel k and lit by the wall's own `sceneLight` drawn through `lightOpacity` (`bar-light.ts`), on the drawing's epoch-ms clock (`useLightClock`), so a pinned pulse and the filling panel's breath keep step with the drawing and the wall. The pinned pill's dot pulses on the same clock.
   - With nothing to show: "Nothing live or pinned" (start a session or pin an activity), "Driving is paused", or "Previewing on your wall" while a preview from the page holds it.
   - Swaps between states with a blur crossfade (`mode="wait"`).
3. **`WallSection`: the hero.**
   - **Stage.** A responsive SVG of `placeLayout(layout, settings.viewRotation)` fitted to its container (ResizeObserver), with a max height of about 60vh.
     - Each panel is a rounded-corner polygon (inset about 3 units so seams show) in the stage colour.
     - A light layer draws `fill = cssRgb(light.rgb)` and `fill-opacity = lightOpacity(light.level)` (what the wall shows, not the raw level), plus a blurred copy behind it (SVG `feGaussianBlur`) for bloom.
     - The controller is a small rounded marker; unsupported shapes are dashed ghosts.
     - A soft floor glow in the lit panels' colour (weighted by how bright each is drawn) sits under the wall.
     - **Theme.** The stage uses the theme's surface tokens in a dark theme. In a light theme it stays a dark wall (lights glow on dark; a white stage washes every colour out): `.wall-stage` in wall.css swaps the neutral `--db-*` tokens for the theme's dark defaults and re-derives HeroUI's from them, so its labels, switch and buttons read on it. Everything outside the stage (editor, list, thumbnail) uses theme tokens only, and accent colours tint over a neutral fill (a pale activity colour or warm white stays readable on a light card); text on the card stays in the theme's ink.
     - **Not on the wall.** The wall shows the scene only while `output.inControl` (`lib/showing.ts` `wallShowing`; a null output means main isn't running). Otherwise the drawing is what the wall *would* show: the light is drawn at 45% and desaturated, the wash goes, a line under the drawing says "Not on your wall · Can't reach The Duck" (or not paired, paused, starting, someone else driving, changed elsewhere…), and the drawing's label says "it would glow…, but isn't showing it". The first mute waits 700 ms, so connecting at load never flashes it. Previews and tap to order draw normally.
     - **Zoom.** When the smallest panel is under a 32px finger target (a big wall on a phone) a zoom button appears: the drawing grows by `zoomFor` (quarter steps, at most 3×) and pans inside the same frame. Tap to order on a coarse pointer zooms in by itself and back out after.
   - **Numbers.** Sequence numbers (1…n) are badges sized per panel by `fitBadges` (1.25 × inradius, 16–32px; 18px for two digits, 22px for three) with the digits never under 11px. Badges that would overlap are nudged apart (at most about half the panel's inradius, so each stays on its panel), and whatever still overlaps is hidden, the smaller panel first, until its panel is hovered or focused (or a drag needs every target). They show fully while editing, while a list row or the drawing is hovered and for 2.4 s after an order change, otherwise sit at 42% (or hide with the toggle).
   - **Controls.** Rotate the drawing by 30° (animated rotation, saved to `settings.viewRotation`) and show or hide numbers.
   - **Preview scrubber.** "Preview a goal", 0–100%, with a "Show on wall" switch. Scrubbing drives the local preview (`fill`) and, when the switch is on, the wall's. Percentages use the shared `progressPercent`, so the scrubber and the Now card never differ by one. Its "Back to what's live" button hands keyboard focus to the range as it leaves.
   - **Order editor**, a compass: the wall in miniature (`OrderThumb`: panels shaded from the first to fill to the last, the route drawn through them, a dot where it starts) with an arrow button on each side for the way the light travels (→ Left→Right, ← Right→Left, ↑ Bottom→Top, ↓ Top→Bottom), and under it the three orders that aren't a direction: Path, Shuffle (Random; choosing it again re-rolls the seed, the die turns and the numbers fly to their new panels) and My own (Custom). One choice, not a mode and then a kind. A line under it says what the chosen order does; My own shows the tap to order buttons there instead.
     - **Choosing:** the seven are one radio group with roving tabindex: one Tab stop, the arrow keys (wrapping), Home and End move the choice (`lib/roving.ts`), in the order Path, Shuffle, My own, then the four directions.
     - **The hand-made order is kept.** `PanelOrder.ids` holds the custom order and survives Auto and Random, which ignore it (`resolveOrder`), so choosing My own again brings it back (`orderModes.ts`); with none yet, Custom freezes the order showing now. Leaving it for any other order shows "Your own order is kept: My own brings it back · Undo" above the compass for 6 s.
     - **Tap to order** starts Custom:
       - numbers clear to dashed outlines, and a hint reads "Tap the panels in the order they should fill";
       - started from the keyboard (a click with `detail === 0`), focus goes to the drawing's first panel (the panels are buttons: Enter or Space numbers one); from a pointer, the draft panel takes focus. Done, Cancel and Escape hand focus back to the button that started it;
       - each tap assigns the next number with SPRING_POP, draws the path segment from the previous centroid (pathLength animation), and flashes that panel on the wall (identify preview);
       - Undo, Start over and Done are available, with a "k of n" counter; with nothing to act on they are `aria-disabled` (faded, still focusable), so undoing to zero never drops focus to the page;
       - at Done, unassigned panels are appended in path order, with a toast saying so (it wraps; a phone-width stage fits about 40 characters a line).
     - **Swap:** drag a number badge onto another panel to swap the two. Pointer capture, a 6 px threshold, a ghost badge follows the pointer, the target panel highlights and its number slides over. On drop the number now labelling the target snaps (it is already under the pointer) instead of flying in again.
     - **Order list:** `Reorder.Group` rows (number, shape glyph, "Mini triangle 15767"; in a narrow editor the name truncates before the id), with a drag handle and earlier/later buttons (`aria-disabled` at the ends, so focus stays). Hovering or focusing a row highlights the panel on stage and, after 140 ms, on the wall (a renewed identify). The identify is let go as soon as the wall can't be driven, a draft/Play/goal preview takes the channel, or the row loses hover and focus; a drag by the grip (touch never moves focus) clears it on drop unless the row keeps focus or a mouse still hovers it (`pointing.ts`).
     - **Tap on your wall** (when `connection.events`): assigns numbers as physical panels are touched, through `onTouch`.
     - **Play order:** the order sweep, locally and (with Show on wall) on the wall.
   - **Saving.** Every change saves through `saveOrder` and plays a short order sweep locally; a second change or Play during a sweep restarts it from panel 1. An order or rotation the app refuses rolls back (the SDK does) and a stage toast says "Couldn't save the order: …" (or the rotation).
   - **Also:** Drag-swap works in any mode and switches to Custom. Play order runs two sweeps. The goal preview ends after 15 s idle; "Show on wall" is local UI state (default on). Clicking a panel, or touching it on the wall, flashes it on the wall and its list row. During tap-to-order, Backspace undoes and Escape cancels. The drawing's scale is capped at 1.45 px per layout unit, so a small wall in a wide column stays life-sized. Instructional text is `text-default-500` (4.5:1 or better in both themes); `text-default-400` is for eyebrow labels only. Every `transform` animation has a reduced-motion branch (opacity only): `MotionConfig reducedMotion="user"` doesn't cover transform strings.
4. **`SettingsPanel`.** Both sliders show on the wall while they move; everything else saves at once. A save the app refuses rolls back (the SDK does) and says "Couldn't save that: …" in the header for 6 s.
   - **Drive my Nanoleaf** (master switch).
   - **Max brightness** slider, 5–100%. While dragging it sends `brightness` requests (every 120 ms; main overrides the maximum for 3 s). With nothing live or pinned it also holds a full `fill` preview, lit at that brightness, and lets it go on release. Its hint says which (`brightnessFeedback`): "The wall shows it as you drag", "The wall lights up to show it as you drag, then goes back", or, while main can't drive the wall (offline, busy, stepped aside, paused, main down), "The wall uses it whenever the plugin drives it". Saved on release.
   - **When an activity is pinned:** a Glow / Pulse segmented control with a live mini preview of three panels on each option (`render.ts` drawn through `lightOpacity`, on the drawing's clock), a pinned-brightness slider (10–80%, shown as "35% of max": it scales under Max brightness) and a "Show goal progress" switch. Pinned brightness saves as it moves (every 300 ms), so the drawing and a pinned wall follow the thumb.
   - **Unfilled panels:** a "Faint track" switch, with a demo bar.
   - **When nothing is going on:** a Restore my scene / Turn off segmented control.
   - **Controller** row: name, model, host, and Refresh / Forget.
   - Switch rows are the switch's own `<label>` (clicking the words toggles it): the input is `aria-labelledby` its label text and `aria-describedby` its description. Slider values read as percents (`formatOptions`).
5. **`SetupFlow`** (unconfigured, or re-pairing).
   - **Step 1, Find.** Discovery starts on mount, with a radar sweep while listening. Controllers found appear as cards ("Shapes 6297 · NL42 · 192.168.1.40", popLayout). "Search again" and "Enter address" (host[:port]) are also offered. `setup/address.ts` accepts an IPv4 address (sent without leading zeros), a host name or a bracketed IPv6 address (`[fd00::40]:16021`, or a pasted URL). It refuses, with what to enter instead: link-local IPv6 (fe80::/10, with a zone or without: main's fetch can't carry a zone, nanoleaf-api.md §1), any other address written with a zone, and every address outside the local network that it can judge (`shared/lan.ts`: public, 169.254/16), in main's own words. Loopback and host names are left to main, which accepts loopback in a development build and resolves names. A search that is replaced or left is aborted (main stops listening), and one that failed runs again on the model's `onResync`. A line explains that inside the Home Assistant add-on discovery can't see the network, so the user should enter the address.
   - **Step 2, Pair.** Pairing starts as soon as the step opens. A drawing of the controller's power button, a "hold for 5–7 s" ring that fills over 6 s (the loop only while waiting), and a 30 s countdown while `pair` runs (its seconds are `aria-hidden` inside the step's live region). The countdown's label follows main's `pairing` messages: "Listening" (said once as "Listening for up to 30 seconds"), "Reaching the controller…" when it hasn't answered after 700 ms, and "Paired. Reading the layout…" once it handed out a token. Leaving the step (Back, Try again, the setup closing) aborts the request, which ends the pairing in main too; from "Paired…" on there is no Back, since main finishes whatever happens (closing the setup then doesn't stop it either: the controller shows as paired a moment later). Failure shows the message and a Try again button. A `timeout` means the answer was lost, not that nothing happened: the message says so, and if the connection then shows the controller connected, the step goes on to Done by itself.
   - **Step 3, Done.** Panels pop in along the path order (stagger capped), then it hands over to the wall.
   - A `FlowStepper` shows the progress through these steps.
   - **Paired from another copy.** A setup still at Find closes for the wall when `onControllerChanged` says the controller was paired (another tab or device did it; this copy's own pairing reaches it at Pair, where it changes nothing). A first-run setup at Find also closes whenever a controller is stored, which covers the news having been missed.

### Prototypes (ui/prototype.html → src/prototypes/harness.tsx)
- The page is served by `pnpm dev` at `/prototype.html` and is never built. The same pattern as the siblings: a `Frame` standing in for the control room, `PickerHarness` (copied from magic-cube, keys 1..n, ←/→, R) and `SimPanel` (copied chrome, fixed bottom-right).
- Variants render the **production `App`** inside a `ModelProvider` fed by `useSimModel(fixtureKey)`. They differ only in fixtures and starting state:
  - "Mixed wall", from theduck;
  - "Triangles", from wings;
  - "Hexagon honeycomb" (synthesised, 12 hexagons);
  - "Big mixed" (synthesised, 30 or more panels);
  - "First run" (unconfigured, with discovery finding two controllers after 1.2 s).
- `useSimModel` keeps every piece of state locally: settings, order, layout, connection, output, sessions, a simulated clock and a simulated controller.
  - It opens with main's status `connecting` for 700 ms, like the app's placeholder before the hub's first report.
  - `activities` include an archived one the user still has pinned (the wall must ignore that pin).
  - `pair` resolves after about 4 s, telling its steps (`waiting` after 0.5 s, `connecting` 0.5 s before the end), refuses an address outside the local network as main does, and stops when its `signal` aborts.
  - `preview` updates `output`.
  - `onResync` fires when main starts again (`M`), and `onControllerChanged` whenever the controller is paired or forgotten: by this copy's own `pair` and `forget`, as main tells every copy, and by another copy (`D`).
  - `onTouch` is driven from SimPanel.
- SimPanel keys and buttons: Start a session on a goal activity (`S`), Start one without a goal (`G`), End (`E`), Pin or unpin (`P`), Archive or restore the activity you're live on (`X`, it keeps glowing), +10% progress (`+`), Time ×60 (`T`, fast-forwards the sim clock), the app's light or dark theme (`L`, writes the `--db-*` tokens as the SDK does), Unreachable (`U`), Unauthorized (`A`), Someone took over (`Y`), Tap a random panel on the wall (`W`), plus Busy (`B`), main not running (`M`), another copy of the interface pairing or forgetting the controller (`D`) and an older app without goals or pins (`O`), so every notice can be seen.
- **The prototypes must type-check.** `pnpm release` runs `tsc` over `ui/src`.

## Emulator (tools/fake-nanoleaf.mjs)
`node tools/fake-nanoleaf.mjs [--layout mixed|triangles|hexagons|minis|big|<GET / dump.json>] [--port 16021] [--udp 60222] [--wall 16022|none] [--host 127.0.0.1] [--pairing button|open] [--ssdp] [--serial S123] [--token <token>]… [--quiet]` (`pnpm emulator`). It has no dependencies and imports `shared/*.ts` for geometry and protocol, relying on Node's type stripping. Tests use `startEmulator({ port: 0, … })` from the same file; `extControl: false` makes it refuse streaming (main's static fallback), and `lights({ settled, overlays })` reads the wall.

- **A controller that moved.** `serialNo` (`--serial`) sets the serial number it reports and `tokens` (`--token`, repeatable) the tokens it already knows. Closing an emulator and starting another on a different port with the same serial and tokens is the same controller at a new address; another serial is a different controller, with or without the tokens.
- **REST on `--port`.** Every endpoint in nanoleaf-api.md §3 with token checks (401), pairing (`POST /api/v1/new` returns 403 unless the pairing window is open), state (on, brightness with `duration`), effects (select, effectsList, write display static/custom/extControl, and request `*Static*`), panelLayout, identify, and SSE `events` with ids 1–4.
- **UDP 60222.** Decodes extControl v2 frames (dropping the whole frame when any id is unknown, like the real device) and applies transitions.
- **Virtual wall** at `http://127.0.0.1:<wall>/`: a live SVG of the panels with brightness applied and bloom, plus the current mode, effect and brightness. It has buttons for:
  - Hold power button (opens pairing for 30 s)
  - Power
  - Pick effect (simulates the Nanoleaf app taking over)
  - Rearrange (sends a new layout)
  
  Clicking a panel sends a touch event. The page updates over its own SSE. It shows RGB × brightness as it is (no gamma): the emulated controller maps colour perceptually, as the real one most likely does (nanoleaf-api.md §11.13), so the page matches the UI's drawing.
- Logs one line per request and a frame rate summary for UDP.
- **Quiet event streams.** `keepAliveMs` defaults to 0: the real controller isn't known to send SSE comments (nanoleaf-api.md §11.6), so clients must cope with a stream that says nothing for hours. Pass `keepAliveMs` to get `: keep-alive` comments.
- **Fault injection** (for tests of a busy or flaky controller; none by default). `startEmulator({ faults })` sets faults from the start; at run time:
  - `emu.faults(spec)` adds faults and returns the current `FaultState` (`{ pending, delay, refuseExtControl, dropFrames }`); `emu.faults()` only reads it; `emu.faults(null)` clears everything.
  - Counters add a rule for the next n REST requests that `match` selects. Rules apply in the order they were added, one per request, and are used up (`pending` lists what's left; `Infinity` lasts until cleared):
    - `dropNext: n`: reset the connection without an answer (a busy controller dropping the request). It never reaches the device.
    - `hangNext: n`: never answer (the client times out). It never reaches the device; `close()` ends it.
    - `failNext: n` with `failStatus` (default 503): answer that status without doing anything.
  - `delayMs: ms` holds every matching request that long before handling it, until changed (0 clears). A held request still runs when its time comes, even if the client gave up, as a slow controller's would.
  - `match` (for the counters and `delayMs` of that call; default every request): `{ method?, path?, body? }` or a function of `{ method, path, body }`. `path` is what follows `/api/v1/<token>` (`"/"` for info and revoke, `"/state"`, `"/effects"`, `"/effects/select"`, `"/events"`, …; `"/new"` for pairing) and must match exactly unless it is a RegExp; `body` is a substring or a RegExp. Example: `emu.faults({ dropNext: 1, match: { method: "PUT", path: "/effects", body: '"select"' } })` drops the next select.
  - Switches that stay until changed: `refuseExtControl: true` makes the extControl write answer 400 (like `extControl: false`, at run time); `dropFrames: true` loses every UDP frame (counted in `emu.lostFrames`, never applied).
  - `emu.closeEvents()` cuts every open event stream without a clean end, like a Wi-Fi hiccup, and returns how many it cut. Clients reconnect; add `faults({ failNext: n, match: { path: "/events" } })` to make the reconnects fail for a while.
  - `emu.requests()` shows a dropped or hung request with status 0 and reason `fault: reset` / `fault: hang`, and a failed one with its status and `fault: injected <status>`.

## Tests (node --test tests/*.test.mjs)

| Area | What is tested |
|---|---|
| geometry | Fixtures place edge to edge. Adjacency counts on theduck and wings. Rotation keeps adjacency. Hexagon corners are flat top and bottom at o=0. Bounds. |
| order | Each auto order is a permutation. `path` visits neighbours consecutively wherever a Hamiltonian path exists; every prefix of it is one piece of the wall (all fixtures, every rotation, grown mini-triangle walls); on big.json its jumps stay few and short at every rotation. `shuffle` is deterministic per seed. A random order is the same at every rotation. `resolveOrder` handles added and removed panels. |
| color | Every accepted format parses. `toLedRgb`. `deviceDrive`/`lightOpacity` (no gamma, lifted floor). `deviceRgb` keeps dim lights visible and in their hue. |
| progress | Period starts, including week-start Sunday and month and year boundaries. Duration sums with a live session. Other members' live sessions are excluded. Count goals for point and span activities. No goal gives null. |
| scene | Live beats pinned. Newest live wins. Disabled gives off. An archived activity's live session glows; its pin is ignored. `pinnedProgress` off drops progress. `progressPercent` matches the app's rounding. |
| render | The 35%-of-5 example as levels and as the wall's device colours (track visible, hue kept); the default pinned glow and pulse on the wall (trough visible). Pulse bounds. Crossfade endpoints. Interrupted fades, replaced previews and same-key adjustments never jump (exact frame at each change, seeded sequences). The goal-met moment, including a count goal met by starting its final session. `fromDark`. A schedule alert: two swells on every panel together, from and back to the frame underneath without a step, its own colour on a dark wall, over a preview; alerts that fire together queue and crossfade; `advance` sheds finished ones and then returns the same state; reduced motion holds it steady. |
| protocol | The doc's example packet byte for byte. Round trips. `staticAnimData` format. |
| storage | Defaults, clamping and garbage input. |
| discovery | SSDP response parsing. mDNS query bytes. mDNS response parsing, including name compression. |
| http | Real answers normalised. Error kinds (401, 4xx, 5xx, refused, timeout). Which requests retry and how often, counted client-side so a slow machine can't race the count. A retry keeps its queue turn. A zoned link-local host fails before sending, and so does a host that is more than a host (a path, a port, a login), for every kind of request, with no `fetch` made. A redirect (301, 302, 303, 307, 308) is `rejected` for every kind of request, never retried, and nothing reaches the server it points to. |
| stream | Frames reach a real listener. A host name is looked up once (never per frame, not even inside dgram), with rate-limited re-lookups after failures. udp6 for IPv6 hosts. `onError` once per failing run. Lookups and clocks are driven by hand. |
| events | SSE parsing, backoff, reconnects, and error kinds (a 5xx is `server`). |
| emulator | The REST, SSE and UDP contract, and every fault: `dropNext`, `hangNext`, `failNext`, `delayMs`, `refuseExtControl`, `dropFrames`, `closeEvents`. Main's clients against those faults (PUT retries, 5xx kinds, event reconnects). |
| lan | `addressKind` for private, loopback, link-local and outside addresses in IPv4, IPv6 and IPv4-mapped form; the IPv4 and IPv6 parsers; `isHostOnly`; each refusal's wording. `assertLanHost`: private addresses pass without a lookup, names by where they lead (a link-local IPv6 address beside an IPv4 one is skipped), public, loopback, link-local and unspecified addresses are `invalid`, the odd forms `fetch` reads as an address are judged as that address, anything a URL would read as more than a host is refused, an address with a zone is refused as its address would be or for the zone (and a `%` elsewhere isn't a host), loopback passes only for a development build, an unresolvable name is `unavailable`, and an abort ends a lookup. |
| effects | Reading a request (colours, defaults, refusals). Pulse spread and wave, shuffle never holding a colour twice, one-colour palettes, the reveal's lock, swells and hold, determinism, reduced motion. In the engine: a control scene swaps in and out without a jump, pulse to shuffle adjusts, the outgoing effect keeps its clock through settled and interrupted fades, a state built late draws the effect where it has got to, alerts and previews draw over it. |
| control (in director) | Grant, renew, change, refuse and release; lapse on its tick; a repeated `requestId`; a stale `leaseId`; an old reveal's end leaving a newer effect; taking an idle wall and handing it back; over a live session; over a yielded wall; refused or ended by the settings; granted but not shown; a reveal covered by an alert, a preview or a slow takeover; `control` published once per change. Against the emulator: a plugin caller's palette on the panels, Home Assistant refused then granted, schema refusals, `clock`. |
| director | The Director over a fake clock, device and stream: policy (wanting, output, yield, echo window, frame changes), capture and hand-back plans, takeover and release sequences, static fallback, leftover and failed hand-backs, yields across instances, previews and who holds them (`none` from another copy, `endPreviewsExcept`, the latest request winning), brightness throttling and retries, the takeover's fade-in (a goal-met wave plays once, not on a restart), stop. A schedule alert over a live scene (peaks, trough, the scene back) and on an idle wall (takeover, the swell counted from it, grace, hand-back); dropped when switched off, paused, busy past its wait, or in static mode. |
| ui-wall | The wall editor's pure parts: the preview lease (renewals, throttling, `resend`), svg and naming helpers, stage layout at phone and desktop widths, badges on big walls (≥ 11 px digits, no overlaps, zoom to 32 px targets), the drag-swap drop, sweep restarts, order modes keeping a hand-made order, list pointing, roving radio keys, the scrubber's `progressPercent`, hint contrast in both themes, no hard-coded white on the editor card, the "would show" state and label, and light drawn at `lightOpacity`. |
| ui-render | Components bundled with vite's esbuild and server-rendered: notices keep live-region words steady while countdowns tick and keep buttons outside the region, an address main won't connect to shows its reason and no retry, the unreachable notice offers Search again (main's `refresh`, with plain words when it finds nothing) and suggests a fixed address in the router, no main-status notice while connecting, switches named by their own label, the Now card's "Now…" versus "Would show…" in each output state, and the rounded goal percent. |
| ui-live-model, ui-status, ui-bar, ui-address, ui-format | Storage readers keep objects across the host's echo (the real SDK client); refused writes are logged and never unhandled; main's status (a placeholder `unavailable` reads as connecting); status pills and brightness feedback; the Now card's bar lit by `sceneLight` in phase with the wall; address parsing (bracketed IPv6, link-local and outside addresses and zones refused with what to enter instead, IPv4 without leading zeros); formatting helpers. |

## Core change (SDK 0.2.2, additive, API 0.2)
`ActivityData` gains, all optional (`undefined` = the app predates them, which is how a plugin detects it):
- `goal?: ActivityGoal | null`. Points always use `count`. Spans use `spanTargetType`.
- `period?: GoalPeriod | null`. Null when progress is disabled.
- `pinnedBy?: readonly string[]`.

The internal wire row keeps them required (`ActivityRow = Required<ActivityData>`), so the app's projection must send them.

`Activity` gains `isPinned`: the current user has it pinned. 0.2.2 models always return a boolean, but main code on an app older than 0.2.2 runs that app's models (the SDK is external in main), where it is `undefined`: test it for truthiness.

The app computes the three fields. On the server, where the store has no user, `pinnedBy` lists every user; on the web, only the current user. On an older app both main and the UI get `undefined` for the three fields, which `ActivityLike` allows.

Main code's goal periods start at midnight in the server's `TZ`, not the user's zone: on a UTC server the panels' goal fill for a user in UTC−7 resets at 17:00 local. The SDK docs tell operators to set `TZ`; `ctx` may get a time zone in a later API.
