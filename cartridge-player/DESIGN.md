# Cartridge Player: design

A physical player with one slot. Slide a labelled cartridge in and its activity starts; pull it out and it stops.
Three parts: the **player** (ESP32-S3 + MFRC522 firmware in `player/`), **main** (the plugin's server side, the only
writer of its storage) and the **interface** (the Deck: a live replica of the player above a shelf of cartridges).

The contract between them lives in `shared/` and is imported by main, the interface and the tests:

| File | What |
|---|---|
| `shared/tags.ts` | A cartridge's identity: canonical UID text (`04:A2:3B:1C`), `normalizeTag` |
| `shared/protocol.ts` | Player ↔ main over HTTP: reports, replies and the probe |
| `shared/storage.ts` | `tagMappings` and the `player` record, their readers, and where a cartridge is (`activeDevice`, `slotHolding`) |
| `shared/state.ts` | Published state (`player`, `slot`) and events (`inserted`, `ejected`) |
| `shared/ui-channel.ts` | The private channel: `label`, `forget`, `dismiss`, `start`, the `reading { tag, deviceId, entry }` message, and the sentence a refused save is answered with (`SAVE_REFUSED`) |
| `shared/setup-code.ts` | The one-string setup code the interface builds and the player's setup page accepts |

## Principles

- **Main is the reconciler, and the only writer.** The player says what is in its slot; main decides what that means
  for sessions. The interface asks main to change things through the private channel. One writer, one queue: no
  device event and no label can overwrite another. A change storage refused is answered `failed`, never as done.
- **Level, not edges.** A player reports its slot's contents, not "inserted" and "removed". A lost, repeated
  or late report is harmless: the next one says the same thing. What a report says its reader found in the slot wins
  over what main remembers having applied, so whatever main missed, the next heartbeat puts right. Nothing replays
  history, because sessions can't be backdated (`start()`/`end()` take no time).
- **A cartridge ends only what it started.** The slot remembers the session its cartridge started or adopted; taking
  the cartridge out ends that session if it's still live, never another one.
- **Settings survive.** `tagMappings` keeps its key and shape; the player keeps its `cartridge` Preferences namespace
  and keys, so updating either side never asks the user to set up again.

## Main

`main/src/`: `index.ts` wires one instance (`createPlugin({ now?, timers? })` for tests, the default export for the
app); `player.ts` is the slot state machine: it runs the queue, performs session actions and writes storage;
`policy.ts` holds its decisions as pure functions (ordering and whether a report agrees with the slot, resolution,
phase, played time); `record.ts` the pure edits to the `player` record; `presence.ts` who has been heard
(in memory, with the offline timers); `routes.ts` the HTTP routes; `channel.ts` the interface's requests; `queue.ts`,
`ports.ts` the plumbing. All state lives inside `onStart`, which is synchronous.

### Routes (under `ctx.plugin.apiPath`)

| Route | For | Answer |
|---|---|---|
| `GET player` | probe before the player saves a hub | `probeReply()`; no side effects |
| `POST player` | report | 200 `playerReply(...)`; 400 `ErrorReply{code:"bad_request"}`; 503 `ErrorReply{code:"retry", retry_ms}` |
| `POST cube-preset` | `{ preset }` → magic-cube `selectPreset` | unchanged contract: 200 `{ success: true, …output }`, 400 for a bad body; errors `{ success: false, code, error }` mapped by `PluginError` code: `not-found` 404, `invalid` 400, didn't run (`not-installed`, `disabled`, `incompatible`, `unavailable`, `unsupported`, `loop`) 503, may have run (`timeout`, `stopped`, `failed`, anything else) 504 |

Domain refusals (deleted activity, failed start) are answered 200 with what happened: a 404 or 500 from plugin code
would read as "path wrong" or "hub broken" to the player. Only malformed input is a 400. `POST player` answers 503
`retry` (2 s) while main is stopping or 32 steps are already queued, (5 s) when applying a report threw, and (60 s)
to a player main has no place for (see Presence). A report
answered 503 changed nothing the player's retry won't finish: the retry carries the same `(boot, seq)` and is applied
like any report that disagrees with the slot (step 1).

Every report is logged in one line (`ctx.log.info`) with the device, what it reported and the result, for
example `Player cp-a1b2c3 (change #12): 04:A2:3B:1C → started (Deep work)`; never the key (handlers never see it). The one exception is a heartbeat that changed
nothing (one arrives from every player every 30 s): the log shows transitions, so a player coming online or going
quiet and its reader failing (`warn`) or recovering get a line of their own instead. A refused body is a `warn`, as
is every degraded path ("Couldn't …": a failed start, end or storage write); a throw or a state the manifest refuses
is an `error`.

### One queue

Reports, interface requests and presence writes run one at a time through a per-instance queue, so a
removal always sees the session its insert started and main stays the only writer of storage. A report whose
`(device, boot, seq)` was already applied, and which says what the stored slot holds, answers from a small per-device
cache without queueing behind slow work (after a restart the first such report goes through the queue once and fills
the cache; a `pair` report always takes its turn, since it may change the shown player).

Storage writes are optimistic, and the host rolls a rejected one back to the server's value: that change is lost.
Main therefore reads the record again at every step and never assumes a write of its own is there. For a device
report the next report heals it (step 1); the one thing main keeps in memory for that is an insert whose write was
refused, so the heal doesn't perform it twice. An interface request (`label`, `forget`, `dismiss`) is answered only once its
writes landed, and rejects with `failed` ("Couldn't save it; try again", `SAVE_REFUSED`) otherwise; sending it again is
safe. `label` and `forget` write both keys, one after the other, and the second only once the first landed (step 6), so
a refused write never leaves a cartridge nowhere. A `forget` that emptied a slot waits for its second write inside its
queued step, so it can put the slot back.

### The slot state machine (per device)

Input: the tag now in a device's slot (`null` = empty), from a report.

1. **Ordering.** Same `boot` as stored and `seq` below the stored one → `stale`, ignored. Same `boot` and
   `seq`, saying what the stored slot holds → a repeat that applies nothing: with `reason` `change`, `boot` or `pair`
   it's a retry of the report whose reply was lost, and it gets that reply again while main still holds it (so the
   player plays the cue it missed); a `heartbeat` or `reconnect` gets `unchanged`, and so does a retry after main
   restarted, since the replies are kept in memory. Same `boot` and `seq` but another tag than the stored slot's, with
   `reader: "ok"` → main fell out of step: the reported slot wins, and it is applied like a new report, so the next
   heartbeat heals what the last report couldn't. That covers a restart or a throw between a swap's eject and its
   insert, a storage write the host rolled back, and a reader that was dead when the report was first sent. One
   exception, so that the heal never performs an insert twice: when the record write of an insert was refused, main
   remembers (in memory, per device) the slot it resolved and the `(boot, seq)` that reported it. A report repeating
   that `(boot, seq)` and tag while the stored slot is empty writes that slot back as it was resolved, with the
   history entry and stats the insert had written, and is answered as a repeat (`unchanged`, or the missed reply to a
   retry). The cartridge is not resolved again: that would mark a point twice, start a span the user has ended since,
   and turn main's own `started` into `resumed`. The memory goes when the
   write-back lands, with any other report from that player, when the cartridge goes into another player, when its
   label changes or is forgotten, and with a restart (after which the heal is the plain one). With
   `reader: "fault"` a report under the applied `(boot, seq)` is a repeat whatever tag it carries: a blind reader only
   repeats the last value it read, and its cartridge may since have been read in another player's slot (step 4), which
   the blind player would otherwise take back at every heartbeat. Main heals once the reader reads the slot again. A
   fault report with a newer `boot` or `seq` is still applied, by step 2's rule (never "out"), unless the tag it names
   is in another known device's slot: the report that said so was lost before the reader failed, and the cartridge has
   been read elsewhere since. Then main records the `(boot, seq)`, ejects what the blind player's own slot held (step
   3: the last value read was another tag) and inserts nothing; the cartridge stays where it was read, and the blind
   player's first `reader: "ok"` report settles it by the rule above. A different `boot` → the player restarted; apply
   it.

   Trusting the reported slot over `(boot, seq)` rests on two things the player guarantees (see Player, Reading and
   Reporting). `seq` goes up on every slot change, so one `(boot, seq)` never carries two tags and a disagreement
   can only be main's. And `reader: "ok"` is only said of a slot the reader has read, so "empty" with `"ok"` means
   it was found empty: sent on a guess (a reader that just came back and hasn't read yet), it would end the session
   of a cartridge that never left, and the report that follows would start another.
2. **Same tag as the slot** → `unchanged`. Never restart anything: a cartridge left in through a reboot, or labelled
   while in, or whose session the user ended in the app, stays as it is. (`resumed` is answered on a reboot when its
   session is still live, so the player chirps.) A report saying empty with `reader: "fault"` keeps the slot's
   cartridge: a reader fault is never "out".
3. **The slot held another tag (or is emptying)** → *eject* it: if `slot.sessionId` is a live span of this user, end
   it; add its tracked time to `cartridges[tag].playedMs`; history `eject` with `durationMs`; event `ejected`. The
   result is `ended` when it ended a session, `empty` otherwise, and `error` when ending failed and the session is
   still live (the slot empties anyway: the cartridge is out). `durationMs` is the session's time while the cartridge
   was in: from the later of its start and the insert, to its end; null for no session or a point. One widening of
   "ends only what it started": a slot in outcome `error` has no session, but the start it was refused may have run
   (the host stops waiting for an action after 10 s), so if its activity is live for this user at eject, that
   session counts as the slot's and is ended. Every rule that asks whose a session is uses the same definition
   (`slotSession`): such a slot counts as playing for `forget`, `label` and the shown player. (`start` still resolves
   it, which adopts the session.) Published `slot` holds its last value while the session is being
   ended (the end reaches main before the emptied slot is written), so it goes `playing` → `empty`, never through
   `ready`.
4. **A new tag goes in** → post `reading { tag, deviceId, entry }` to the interface at once (`entry` is the id of the
   history entry this insert will write, so the interface can tell the outcome has arrived whichever of the message
   and the storage write reaches it first), then resolve it:
   - not labelled → outcome `unknown`; add or refresh it in `unknown` (newest first, at most 20); history `new`
   - labelled, activity gone → `orphan`; archived → `archived` (nothing starts)
   - a point activity → `mark()` → `marked`
   - a span activity already live for this user → adopt that session (no new start) → `resumed`
   - otherwise `track()` → `started`
   - an action that rejects → `error` with its message; the player gets `cue: "error"` and the slot stays, so the
     interface can offer Start again
   - for a labelled cartridge: `plays += 1` for started/resumed/marked; `seenAt` = now; history `insert`. Event
     `inserted` for every insert. `active` = this device.
   - a cartridge is in one slot at most: any other device's slot still holding this tag (a player that stopped
     reporting) is emptied in the same write, ending nothing and with no `ejected`
     event; the time its session tracked there is added to the cartridge.
5. **Presence.** Every accepted report marks its device heard (in memory). `player` state flips to offline
   `OFFLINE_AFTER_MS` after the last report (a timer per device, cleared in `ctx.onStop`), and then writes
   the exact last-heard time. `lastHeardAt` is written to storage with every change, and on its own at most every
   `PRESENCE_WRITE_MS`; published `lastHeardAt` is the stored one. `hubHost` is the request's `Host` header, written
   when it changes. After a restart a stored player is neither online nor offline (`online: null`): it
   gets the same `OFFLINE_AFTER_MS` to report before it counts as offline, so a plugin update or a hub restart never
   reads as an outage.
   - **The shown player** (`active`) is the one whose slot changed last. A player heard for the first time, or set
     up again (`reason: "pair"`), becomes the shown one too, unless that would take the stage from another player
     that is online and playing.
   - **Four players at most** (`LIMITS.devices`). A fifth takes the place of one that isn't online: the
     longest-quiet with an empty slot, else the longest-quiet (by what main heard, not the stored time, which is up
     to 15 minutes old for an online player); main forgets that one's reply cache and timer. If it is still there
     after all, its next report is applied like a new player's. While all four are online (a stored player main is
     still waiting to hear after a restart keeps its place too), a fifth player's reports are answered 503 `retry`
     (60 s), change nothing and don't count as hearing from it: four players are served well instead of five taking
     turns in the record.
6. **Interface requests.**
   - `label {tag, activityId}`: the tag must be a UID and the activity must exist and not be archived (`invalid`
     otherwise). Writes the mapping (canonical key), drops the tag from `unknown` (its stats' `seenAt` starts from
     when it was last seen there), history `label` or `relabel` (nothing when the label is unchanged). If the tag is
     in a slot (as `slotHolding` sees it) and its session isn't live: the slot gets the new `activityId`, outcome
     `idle`, no session (the time an ended session tracked is added to the cartridge first); labelled again with the
     activity it already started or marked there, the slot stays as it is. A playing cartridge keeps its slot too:
     relabelling changes what it starts next time; the running session carries on and still ends on eject.
   - `forget {tag}`: refused (`invalid`, "Take it out of the player first") only while the cartridge is in a player for
     certain: the slot holding it (any device's) has a live session, or the player holding it is online, as Presence
     counts it in memory. Otherwise that slot is only what the record last heard (its player is offline or hasn't been
     heard since main started), and forget goes
     through: it removes the mapping and `cartridges[tag]` and, in the same record write, empties that slot, with no
     session action and no `ejected` event; history `forget`. Without this a cartridge in the record of a player that
     is gone for good could never be forgotten. The slot goes all or nothing: if the mapping write is refused after
     the record landed, the emptied slot is written back before the request rejects (`failed`), since a cartridge still
     labelled but out of its slot would be a new insert at its player's next report and start its activity again
     (against step 2). If that player reports the cartridge still in after all, the reported
     slot wins (step 1) and it is in the slot as an unlabelled cartridge. `{ forgotten: false }`, and nothing changes,
     when it wasn't labelled.
   - `dismiss {tag}`: drops it from `unknown`; history `dismiss`. `{ dismissed: false }` when it wasn't listed.
   - `start {deviceId?}` (the shown device by default): a slot already playing its own session answers `resumed`
     and does nothing, whatever the cartridge is labelled now. Otherwise the slot must hold a labelled cartridge
     whose activity exists (`not-found` otherwise; `invalid` when it's archived); same resolution as step 4 from "a
     point activity" on; history `start`, `plays += 1`. A rejected action leaves outcome `error` and rejects the
     request with the action's `PluginError`.
   - `label`, `forget` and `dismiss` are answered once their storage writes landed, and reject with `failed` when one
     was refused (One queue, above). `label` and `forget` write two keys, and the write that takes the cartridge away
     from where the user would ask again goes last, only once the other landed: `label` writes the mapping and then the
     record (which drops the cartridge from `unknown`), `forget` the record and then the mapping (which takes it off
     the shelf). So a label storage refused leaves the cartridge listed as seen, and a forget storage refused leaves it
     on the shelf (without its stats when the record had landed, but still in the quiet player's slot it was in); the
     same request again finishes either.
7. **Data changes** never trigger actions. Whether a slot is playing is derived from the workspace each time it's
   needed (`ctx.sessions.get(slot.sessionId)?.isLive`), and `slot` state is republished on `ctx.onDataChange` (and on
   a `player` or `tagMappings` write from elsewhere) when that derived phase changes.
8. **Start-up.** Read storage through the readers; prune
   `cartridges` to labelled tags and `unknown` to unlabelled ones; write only when that changed something; republish
   `player` (`online: null` for a stored player until it's heard or its wait runs out) and `slot`.
   `tagMappings` is never rewritten at start-up. Routes register synchronously, before storage is read, so the
   probe never waits on anything.

### Storage and published state

See `shared/storage.ts` and `shared/state.ts`. History keeps 50 entries; the interface reads the latest `eject` for
its "Saved" moment. A labelled cartridge has a `cartridges` entry once it has been labelled, gone in or come out;
before that it reads as `NO_STATS`.

Published state (both always present while main runs):

| Name | Shape | Changes |
|---|---|---|
| `player` | `PresenceState { online, lastHeardAt, deviceId, name, firmware, reader }` of the shown device (`activeDevice`); `online` is null when it isn't known: before any player is heard, and for a stored player not heard yet since main started (then `false` once its wait runs out) | when it comes online, goes offline, its reader's health or the shown device changes, or a stored field changes |
| `slot` | `SlotState { phase, tag, activityId, sessionId, since, deviceId }` of the shown device | when its slot or its derived phase changes (held while an eject ends its session) |

Events: `inserted { tag, activityId, result }` after every insert is resolved, `ejected { tag, activityId,
durationMs }` after every eject. `manifest.json` declares them with schemas matching those types exactly (every
field required, nullable through type lists). `uses` keeps `magic-cube` for the `cube-preset` route.

### Tests

`tests/protocol.test.mjs` and `tests/storage.test.mjs` cover `shared/`.

## Player (firmware 2.x)

Hardware: Waveshare ESP32-S3-Zero, MFRC522 on SPI (SCK 12, MISO 10, MOSI 11, SS 13; RST has no GPIO and is tied to
3V3), active buzzer on GPIO2, on-board WS2812 on GPIO21, BOOT button on GPIO0. Arduino ESP32 core 3.3.6; the only
library besides the core is MFRC522 1.4.12. `player/sketch.yaml` pins both.

Layout: `player.ino` only calls `src/app.cpp`, which wires the pure core to the hardware. `src/core/*.h` is header-only
C++17 with no Arduino in it and no heap (tag tracker, the feed from reader polls to reports, reporter, protocol,
JSON, HTTP body reader, settings rules, setup code, the Connect flow with the setup page's form fields and
`/api/state` body, the page's network scan, link state machine, light and sound, inputs), so `player/tests/*.cpp`
run it on the host and `tests/firmware.test.mjs` checks it against `shared/*.ts`, through the same calls `app.cpp`
makes. `src/hal/*.cpp` are thin adapters (reader, settings store, Wi-Fi, hub client task, setup portal, buzzer and
LED, log).

### Behaviour

- **Reading.** Poll every 50 ms without blocking: WUPA + select + HALT per poll, so a cartridge answers every poll
  (the reader's receive timeout is cut to 10 ms, so an empty poll costs 10 ms, not 25). A cartridge counts as in after
  two identical reads, and as out after it has been missing for ≥ 3 polls and ≥ 400 ms. A different UID is out(old)
  then in(new): two changes, so `seq` goes up by two. 4-byte UIDs starting `0x08` (random-ID cards, phones) count as
  nothing. A poll the reader fails (version register reading 0x00 or 0xFF, or the chip found reset to its defaults by
  a brown-out: both checked every poll) is never "out": the slot keeps its last value and the misses before it are
  forgotten. A chip that reset itself is set up again on the spot and reads again at the next poll; a reader that
  stopped answering, or resets again within 10 s, is set up again with backoff (1 s doubling to 30 s, back to 1 s only
  once it has held for 10 s, so a loose wire isn't retried every second for ever). A failed poll also means the slot
  is no longer *read*: a cartridge can come or go while the reader is blind. It is read again once its cartridge is
  seen (one poll), another one is in (two reads), or nothing has been there for 3 polls and 400 ms. The reader counts
  as faulty once the slot has gone unread for 1 s: then the report says `reader: "fault"` and the light goes red and
  blue in turn, until the slot is read again (a poll that merely works doesn't end it). A reader dead from power-up
  settles the slot after 3 s without having read it, so the hub hears from the player and shows the fault: that boot
  report says `tag: null` with `reader: "fault"`.
  **What a report guarantees** (main's step 1 relies on it): nothing is reported before the slot has settled, and
  `reader: "ok"` is only said of a slot the reader has read, so `tag: null` with `reader: "ok"` always means the
  reader found the slot empty, never "not read yet". With `"ok"` the tag is what the reader found there, at most about
  a second ago (the 1 s above: a shorter gap goes unreported, and a report inside it carries the last value read). A
  slot the player couldn't read, at power-up or after a fault, goes out with `reader: "fault"` and the last value read
  (`null` when there never was one), and the first `"ok"` after it carries the slot as just read: a `heartbeat` with
  the same `seq` when the slot is what the fault report said (the same cartridge, or still empty), a `change` with a
  higher `seq` when it isn't (a cartridge that sat in a dead reader since power-up, or one that came, went or was
  swapped while the reader was blind).
- **Reporting.** Protocol 2 only, to `POST <base>/player`: on boot (once the slot has settled: at the first read, or
  after 3 s of a dead reader; reason `boot` until the hub has heard this boot), on every slot change, on Wi-Fi
  reconnect, after setup saves a hub (`pair`), on a reader fault or recovery (reason `heartbeat`, same `seq`), and
  every `heartbeat_s` (from the last reply, default 30, kept within 5 s to 1 h). Always the current state, never a
  queue of edges. `seq` starts at 0 and goes up on each slot change; `boot` is random per power-up. When several
  reasons are pending, the report carries the strongest: pair, boot, change, reconnect, heartbeat. What becomes wanted
  while a report is out goes in a follow-up under its own reason once that report is answered (a retry of an
  unanswered one keeps the stronger of the two): a follow-up that repeated the answered report's reason and `seq`
  would be answered from the plugin's reply cache, and its cue would play twice.
- **Delivery.** One request in flight, on its own FreeRTOS task (the loop never blocks): connect timeout 1.5 s, at
  most 2.5 s of silence while the headers arrive, the whole body within 3 s (plain or chunked), at most 512 bytes of
  answer read, `User-Agent: CartridgePlayer/<fw>`, `Authorization: Bearer`, no `Origin`. Network error, 502/503/504,
  `code:"retry"`, any other status, or a 2xx whose body isn't the plugin's reply (`ok: true`; a proxy's page, a reply
  cut short) → retry the latest state with backoff 0.5 s doubling to 30 s (`retry_ms` honoured, up to 60 s). 400 →
  don't retry that report. 401/403/404 → a hub that is starting up answers these for a moment, so the first three in a
  row are retried after 2 s, 5 s and 15 s and shown as "unreachable" (the violet pulse); a fourth in a row is the
  hub's real answer: "key rejected" (401/403) or "plugin path not found or plugin off" (404), steady red, retry every
  60 s, no reconfiguration. A reply from the plugin (2xx or 400) or new hub settings start the count again. A slot
  change or Wi-Fi coming back cuts any wait short; a reader fault or recovery doesn't (it goes with the next report,
  at once when nothing is being waited out).
- **Feedback.** On a reply, play its `cue` on the buzzer (if enabled) and LED. The buzzer is active (one pitch), so
  cues differ by rhythm: `ok` an 80 ms chirp (green); `bye` a 15 ms tick (soft white); `unknown` two 50 ms beeps
  (amber); `error` a 600 ms beep (red); `none` nothing. If the hub can't be reached for 3 s after an insert, play
  `error` once and keep retrying quietly (the reply's own cue still plays when it gets through); if the hub refuses it
  (400/401/403/404), `error` plays at once. A cartridge found in the slot at power-up is not new: no reading blink, no
  error. A Connect that finishes plays `ok`; one that fails, `error`.
- **The light between cues** says what the cartridge in the slot is doing, the way the interface draws its replica
  of the player (Interface, Phases; `ui/src/components/scene/Led.tsx`), so the device and the screen agree:

  | Light | Cartridge | Replica phase |
  | --- | --- | --- |
  | fast blue blink (420 ms) | a report about a new cartridge is unanswered | `reading` |
  | breathing green (2.4 s) | answered `ok`: its session is tracking | `playing` |
  | steady green | answered `ok` with result `marked`: a point, nothing running | `marked` |
  | slow amber blink (1.1 s) | answered `unknown`: not labelled | `unknown` |
  | slow red blink (1.1 s) | answered `error`: orphan, archived, or the start failed | `orphan`, `archived`, `error` |
  | faint white | nothing to show: an empty slot | `empty` |

  The cartridge keeps the light of the hub's last answer about it until it comes out; a `none` cue (a heartbeat's
  `unchanged`) leaves it, and an answer about a slot that has changed since plays its cue but doesn't colour the new
  cartridge. Only the hub's own answers count: the `error` the player plays for want of one doesn't. Blinks dim to a
  fifth rather than go dark, so every light reads as powered; the faint white of an empty slot is no colour on purpose
  (green means tracking). `tests/firmware.test.mjs` holds the table against `Led.tsx` and `deck.css`, answer by
  answer, with replies built by `playerReply`. Two things the replica knows and the player can't: the replica's blink
  stops after six and holds, where the LED keeps on; and the player only hears about its cartridge in replies with a
  cue, so what changes on the hub while the cartridge stays in (a session ended in the app, an unknown cartridge
  labelled and started there, a slot kept through a power cut that wasn't playing) reaches the screen but not the
  light until the cartridge goes in again.

  The player's own states come first, most important first, and none looks like a cartridge's: each differs from every
  row above in colour or in pattern (`player/tests/test_indicator.cpp`). Breathing blue in setup mode (slow and never
  the fast blink of reading, and a cartridge's light isn't shown in setup mode at all); red and blue in turn for a
  reader fault (the only light with two colours); the reading blink; a slow violet pulse while Wi-Fi is joining or the
  hub can't be reached or hasn't answered yet (violet is nothing else's colour); steady red when the hub refuses the
  key or the path (after the three quick retries) or the last report (400, until the next answered one), where a
  cartridge's red blinks. A cartridge's light never covers one of these: green over a hub that can't be reached would
  promise that pulling the cartridge out ends its session now.
- **Setup mode.** The access point, DNS and setup page exist only in setup mode: when not configured (then it never
  closes by itself); after a BOOT long-press (3 s); the serial `CONFIG` command; or when saved Wi-Fi hasn't connected
  since power-up for 5 minutes (the station keeps retrying meanwhile and setup mode closes itself when it connects; if
  it closes on idle first, it opens again after another 5 minutes). Wi-Fi lost after it once worked never opens it:
  the router comes back. Open network named `Cartridge-XXXX` (the first four hex digits of the id's MAC suffix,
  `cp-a1b2c3` → `Cartridge-A1B2`), one client, at `10.123.45.1/24` (not the core's default 192.168.4.1: some home
  routers hand out that range, and the hub would then be looked for on the access point's side). It closes after 10
  minutes without a request from the page itself (never during a Connect). A request is the page's own when it
  carries the setup token, which no other page in the phone's browser can read or send: loading the page, a
  `/api/state` without the token, captive-portal probes and other stray requests don't count. It also closes 60 s
  after a Connect succeeds, and 0.8 s after Leave setup (so the answer still reaches the phone). BOOT or `CONFIG`
  while it is open means "keep it open": it calls off a close that was on its way, and the page starts from the form
  again (a Connect started in the moment after Leave setup calls that close off too). Setup
  opened for want of Wi-Fi also stays once someone has used it (a Connect, BOOT, `CONFIG`), so a Connect that joined
  Wi-Fi but failed at the hub can still show why. Entering setup forgets the last Connect's result. In run mode the
  radio is station-only, nothing listens but mDNS (`cartridge-a1b2c3.local`), modem sleep is off, and the station's
  own reconnect is off: the loop rejoins with backoff (2 s doubling to 60 s; 1 s after a drop; a join that neither
  connects nor fails in 20 s is retried). Every join first drops whatever join was going on, and Wi-Fi events carry
  their network's name, so a late answer from the network before is never taken for the one asked for now. A name
  doesn't tell two networks apart that share it (a failed Connect's network named like the saved one), so after the
  player's own leave no address counts until it joins again (`Link::expectsUp`); a join that failed or timed out may
  still come up, since the driver retries a first failed join by itself and a slow lease still arrives. Credentials
  are never written to the Wi-Fi driver's flash (`persistent(false)`).
- **Who the setup page answers.** Only clients of the access point, and only requests addressed to the player's own
  address. A client is told by both ends of its connection: the address it asked for is the access point's, and its
  own address is on the access point's subnet (the stack takes a packet for the access point's address on the station
  side too, so a machine on the home network could route to it through the player's station address; an answer to an
  address on the access point's subnet only leaves through the access point). Any other connection is closed as it
  is accepted, unread (the core reads and parses a whole request before a handler runs, waiting up to 5 s on every
  silence and keeping every field, so a 403 alone would leave the home network able to stall the loop or run the
  player out of memory); the handlers make the same check again and answer 403. So the token can't be read from the
  home network while setup is open. The core has no limit to set for the access point's own clients: while setup is
  open, one that sends a request slowly or oversized can freeze the player for up to 20 s (the loop watchdog) and
  make it restart, which closes setup on a set-up player. A request for any other host name (every name resolves to
  the player there) gets the redirect or 403, so a page from elsewhere can't call the API as its own origin. A form is
  read from its own request alone. The Arduino core's web server parses a body before any handler has checked the
  request, and keeps what a multipart body left when it couldn't be read to the end; its lookup by name (`arg(name)`,
  `hasArg`) then finds that first for every later request, so one multipart POST from anyone, with no token, would
  have stood in for the fields of every later Connect and of the erase confirm. So the portal never looks a field up
  by name: it walks the request's own pairs by position (which hold only that request's query and urlencoded body)
  into the core's form readers (`readConnectFields`, `confirmsErase`), refuses any body that isn't urlencoded before
  reading a field of it, and after every pass of the server drops what the request left there (those leftovers, the
  last form, the last `Host`), so nothing a refused or malformed request leaves behind is there for the next one.
- **The saved key stays where it was proven.** The API key is only ever sent to the saved host, port and base over the
  saved Wi-Fi (name and password). The loop starts a request only with the station up, and the hub task, which
  connects later, closes any connection whose own end isn't the station's address before writing to it (a station
  that dropped in between would leave the open access point as the only way out). A Connect may keep it only with the saved Wi-Fi password kept too, not typed: a
  typed password held against the saved one would tell anyone at the open page, as fast as they could ask, whether a
  guess at it was right (an open network has none to guess). A player that has a key takes a new network only together
  with a hub that answered over it: nothing is saved on joining, a Connect that fails leaves that network at once and
  the station goes back to the saved one, and reports wait while a Connect runs. The radio changes network only
  between requests. A Connect whose network drops while the hub is being asked fails at once ("Lost Home before the
  hub answered"): no probe is sent without the station up on the network that Connect joined, since it carries the key
  and would leave by whatever interface is left (in setup mode, the open access point); the answer to a probe that was
  out when that happened is dropped. A first setup, with no key to protect, saves Wi-Fi as soon as it has joined.
- **Settings.** Preferences namespace `cartridge`: `ssid` (string), `password` (string), `host` (string), `port`
  (uint16), `base` (string, the plugin's API base), `key` (string, the API key) and `buzzer` (bool, default on).
  What is saved loads by the setup rules: Wi-Fi when its name and password pass them, the hub only when host, port,
  base and key all do; with both the player is configured. A first setup writes Wi-Fi once it has joined. A
  finished Connect writes everything in an order that a power cut or a failed write can't turn into a mix of old
  and new: the saved `key` is removed first, then Wi-Fi, host, port and base are written, then the new `key`.
  Without a key nothing loads as a hub, so a cut part-way leaves a player that opens setup, never the old key paired
  with a new address or network. Every write is read back. Factory reset clears the namespace, then restarts.
- **Serial (115200).** `STATUS`, `CONFIG`, `RESET`, `FACTORY` (asks to repeat within 5 s), `BUZZER ON` / `BUZZER OFF`,
  `HELP`; case doesn't matter, lines end with CR, LF or both, and reading never waits. The key and the Wi-Fi password
  never appear in output, only `set`/`not set`.
- **Watchdog.** The loop feeds the task watchdog (20 s, panic and restart) and gives up the core for a tick every
  pass. The hub task is not on it: a request has no deadline the task could keep (a name lookup alone can take 21 s
  when DNS stays silent). Instead the loop restarts the player, saying so on the console, when a request has been
  out for 30 s.

### Setup page API (setup mode only, at `http://10.123.45.1/`)

All JSON answers carry `Cache-Control: no-store`. Mutating requests need the header `X-Setup-Token: <token>` from
`/api/state` (a per-boot random token) and a form-encoded body (`application/x-www-form-urlencoded`, which is all
the page ever sends: never multipart); anything else is 403. `GET /api/scan` needs the token too (403 without), and
the page sends it on every `/api/state` after its first: only a request with the token counts as the page being
used, which is what keeps setup open. Captive-portal probes (`/generate_204`, `/gen_204`,
`/hotspot-detect.html`, `/library/test/success.html`, `/ncsi.txt`, `/connecttest.txt`, `/redirect`, `/fwlink`) and
unknown paths redirect (302) to `http://10.123.45.1/`, as does `GET /` asked of any other host name; the API routes
below asked of another host name are 403 (the `Host` header must be `10.123.45.1` or `10.123.45.1:80`). A connection
that reached the player through its station address is closed unread, whatever it asks for.

- `GET /` — the page (gzipped, `Content-Encoding: gzip`), built from `player/portal/` by
  `node player/portal/build.mjs` into `player/src/portal_page.h`.
- `GET /api/state` →
  ```json
  { "device": { "id": "cp-a1b2c3", "name": "Cartridge-A1B2", "fw": "2.0.0", "reader": "ok" },
    "token": "8f3a…",
    "configured": true,
    "saved": { "ssid": "Home", "hasPassword": true, "host": "192.168.1.12", "port": 9001,
               "base": "/api/plugins/x/api", "hasKey": true },
    "attempt": { "id": 3, "phase": "idle", "message": "", "field": null, "ip": null, "ssid": null } }
  ```
  `device.reader` is the last poll's word. `configured`: Wi-Fi and a whole hub are saved, so the player can run and
  may leave setup. `saved` is null when nothing is saved; after a first setup that joined Wi-Fi but failed at the
  hub it holds the network, with `host`, `port` and `base` null. Secrets show only as `hasPassword` and `hasKey`.
  `attempt.id` goes up by one with every Connect, and `attempt.phase` goes `idle` → `joining` → `probing` → `done`
  | `failed`; entering setup mode again puts it back to `idle` and keeps the id. `failed` names the step's `field`
  (`ssid`, `password`, `host`, `port`, `base`, `key` or `code`; null when the settings couldn't be written) and a
  sentence in `message`. `attempt.ip` is the address the network gave (null before then). `attempt.ssid` is the
  network that Connect is for (null when there has been none since setup was entered): the checklist of a page
  opened part-way names it, not the network in the form or the saved one.
- `GET /api/scan` (with the token) → `{ "scanning": false, "failed": false, "networks": [ { "ssid": "Home", "rssi": -52, "secure": true } ] }`,
  de-duplicated by SSID (strongest kept), strongest first, the 20 strongest at most, hidden networks left out.
  Starts an async scan when the last list is older than 15 s; poll while `scanning`. A scan can't start while the
  station is joining (which holds still while one is wanted), so it is asked for every second for 12 s. Then it is
  given up: the next request is answered `scanning: false, failed: true` (`networks` is the last list, if any) and
  starts nothing; the request after that starts over. `failed` is said once.
- `POST /api/connect` — fields `ssid`, `password`, `keepPassword` (`1`: keep the saved password; only for the saved
  SSID), then either `code` (a setup code; one without a key takes `key` or `keepKey` beside it) or `host`, `port`,
  `base`, with `key` or `keepKey` (`1`: keep the saved key; only when host, port and base are unchanged and the
  network is the saved one with its password kept by `keepPassword`, not typed again: a typed password held against
  the saved one would tell anyone at the open page whether a guess was right. A saved open network has no password
  to keep, and its `password` is blank). Validates (the hub by the rules of
  `shared/setup-code.ts`; a network name is 1–32 bytes; a password is empty, 8–63 bytes without control characters,
  or 64 hex digits), answers 202 `{ "attempt": 4 }` or 400 `{ "error": "…", "field": "…" }` (`field` is null when no
  field is at fault, as for a Connect while one is running), then in the background joins Wi-Fi (keeping the access
  point up), saves Wi-Fi once joined while no API key is saved (a player that has one takes a new network only
  together with its hub), probes `GET <base>/player` with the key, and saves the hub, and the network with it, only
  when the probe answers `ok`, `player: "cartridge-player"`, `protocol: 2`. A Connect for the saved network while
  the player is on it goes straight to the probe. Joining gets two tries within 20 s; the probe three while the hub
  doesn't answer or says it is busy. Then `done`: the access point stays up 60 s so the phone can show the result,
  then the player leaves setup mode (no reboot needed). On `failed`, a player that has a key leaves the new network
  at once and goes back to its saved one.
- `POST /api/reset` — field `confirm=erase` (400 without it): answers 200 `{ "ok": true }`, then 0.6 s later clears
  the namespace and restarts.
- `POST /api/exit` — leave setup mode: answers 200 `{ "ok": true }` and closes 0.8 s later, so the answer reaches
  the phone; 400 with a sentence while a Connect is running ("Wait for Connect to finish") or when not `configured`
  ("Set the player up first"). A Connect, BOOT or `CONFIG` within those 0.8 s calls the close off.

The page: one screen, phone first, light and dark, no external requests, ≤ 12 KB gzipped. Wi-Fi first (scanned list,
signal and lock, "Other network…", password with show/hide, "Saved" for the saved one), then the hub (a single
"Setup code" field with Paste; "Enter details instead" reveals host, port, path and key), then Connect with a live
checklist (Joining Home → Got 192.168.1.57 → Plugin answered → Saved). Errors appear on the field they're about. All
device text goes into the DOM with `textContent`.

- **Checked before posting.** The page applies the player's own rules (the hub's, and the Wi-Fi ones counted in
  bytes) with the player's sentences, and its own where it can say more (no network chosen yet, a secured network's
  password left blank, a password typed beside a key to keep), so a Connect is rarely refused after the fact.
- **The network list.** The page asks for the list once `/api/state` has given it the token, and polls `/api/scan`
  every 1.5 s while `scanning`. On `failed`, on an answer that
  isn't the list, or after twelve answers of `scanning` in a row (about 17 s, longer than the player gives a scan),
  it stops, keeps the last list, says it couldn't get a new one and leaves "Scan again" and "Other network…" to
  carry on with. A saved network missing from the list is offered under "Other network…" as probably hidden, but
  only after a scan that worked.
- **Saved secrets.** A blank password keeps the saved one for the saved network. A blank key keeps the saved key
  only for the saved hub on the saved network with the password left blank (kept, or none for an open network):
  `keepKey` is never posted beside a typed password, the saved one included. Otherwise the key hint says, before
  Connect is pressed, that the key is needed again (typed, or in a setup code): for another network, or for a typed
  password, where it adds that leaving the password blank keeps the saved key. Pressed anyway, the page asks for
  the key instead of posting `keepKey`: in the player's words for a kept key off the saved network, in its own for
  a typed password. With nothing saved to keep, the key hint says where a key is made: Workspace settings → API
  Keys.
- **One thing at a time.** While the player works on a Connect, an erase or leaving setup, the form and the Advanced
  actions are off. A Connect the player refuses because one is already running (another page, a lost answer) is
  followed on the checklist like the page's own.
- **A Connect always ends on the page.** The page asks `/api/state` every second until the attempt it follows is
  `done` or `failed`, through any number of missed answers (after three it says the phone may have left the
  player's network). An attempt back at `idle` under the same id was forgotten when setup was entered again: the
  page stops asking, opens the form and says "The player started setup again. Check the settings and press
  Connect." A newer id means another page's Connect, which is followed instead. Whenever a Connect stops without
  the player's word on a step (refused with a 400, never received, forgotten, cut short by a restart), no step is
  left in progress on the checklist beside the sentence that says why.
- **A restarted player.** A 403 means the token is stale: the page fetches `/api/state` and sends the request (a
  POST or the scan) once more with the new token. After Erase it forgets what was saved, says "Restarting…" and waits for a state with a
  new token before it opens the form again.
- **Done** is final: the network closes 60 s later, so the card offers no way back to the form and says how to
  change settings later (hold BOOT for 3 seconds). Leave setup is offered when `configured`; the player's own
  refusal is shown when it gives one, and once the player has answered 200 the page is closed for good ("Setup
  closed"): the network goes 0.8 s later.

`tests/portal.test.mjs` runs the built page's script against a fake DOM and a fake player, and puts what the page
posts and shows to the firmware's own core through `player/portal/contract.cpp` (the form reader and planConnect,
the Wi-Fi rules, the field and phase names, the `/api/state` body, the scan's answers), so the page and the player
can't drift apart unnoticed. `player/portal/dev-server.mjs` is a stand-in player for working on the page in a
desktop browser. Its rules about kept secrets are held against planConnect by the same test; scan failure and
leaving setup it keeps by hand.

## Interface

The Deck prototype (now behind `?explore=1`) was chosen; this is it, built on real data. A live replica of the player
sits on a stage above a shelf of cartridges.

### Shape of the code

- `ui/src/view/` is pure TypeScript (no React, no DOM), run directly by `tests/ui-*.test.mjs`: the phase derivation
  (`phase.ts`), the shelf and its sorting (`library.ts`), the picker's groups (`picker.ts`), presence (`presence.ts`),
  the setup code's fields (`setup.ts`), main's status (`main-status.ts`), request errors, sticker and ink colours and
  formatting (no date library: `Intl.RelativeTimeFormat` and `Intl.DateTimeFormat`).
- `ui/src/model.ts` is the `PlayerModel` the components read; the view never touches `ctx`. `live-model.ts` builds it
  from `ctx`; `prototypes/sim-model.ts` builds it from a simulator, so `ui/prototype.html` renders the production
  `App`. `main-channel.ts` is the interface's side of the private channel with no React in it (`createMainChannel`):
  the four requests and the reading beat. Every model field keeps its identity until its value changes: stable
  readers over storage and state, and workspace rows kept per id while their value is the same (the SDK replaces every
  list whenever any collection changes, so a session starting anywhere would otherwise redraw every card). `App` is
  memoised on the model, so an update that changes nothing in it renders nothing.
- Components: `components/scene` (the player, the cartridge, the LED), `components/status` (the stage's words and
  actions, the clock), `components/shelf`, `components/setup` (guide, copy field, Player panel), plus a hand-rolled
  picker, segmented control, popover and sheet. No HeroUI components ship (only the Tailwind plugin from
  `@heroui/theme`, for the tokens), and no date library.

### Data

Storage (`tagMappings`, `player`) through the shared readers; workspace activities (archived included, so a cartridge
can still show one), categories and the user's live span sessions as plain rows;
`ctx.plugins.self.state.get("player")` for presence (undefined, read as null, while main isn't running);
`ctx.plugins.self.status` for whether main runs (an `unavailable` the page opened with counts as "connecting" for
3 s, so opening never flashes a false alarm); `ctx.main.onMessage("reading")` for the reading beat (dropped on
`onResync`).

The presence pill says one of five things: no player yet; online (or its reader's fault); offline; "Waiting for
player", for a player main hasn't heard since it started (`online: null`: a quiet dot, not a fault, since main itself
gives the player a heartbeat or two before calling it offline); and status unknown while main isn't running.

The stage's phase is derived from storage and live sessions with main's own rule (a slot plays only while the session
it started is live), not from the published `slot` state, so it is right while main is stopped too. It agrees with
main's published `slot.phase` through a whole session. Where the workspace changes under a cartridge that is already in, the interface is the fresher view: main's
`slot.phase` keeps what the insert resolved to (`marked`, `orphan`, `archived`, `error`), while the stage looks at
today's activities, because it is the one offering the next action. A marked cartridge whose activity is then deleted
reads `orphan` here; an archived one that is restored reads `ready`, and Start works.

An eject reaches an open copy as two pushes: main ends the session, then writes the emptied slot. Between them the
slot looks like one whose session was ended in the app. Main holds its published `slot` across that gap, and the
stage does the same: a playing stage whose session has just stopped, with the same stay of the same cartridge still
in the slot, is held for 400 ms (`holdStage`). The emptied slot shows the moment it arrives, so an eject goes from
playing straight to "Saved"; a session that really was ended in the app says so 400 ms later. The live region
follows the held stage, so it never announces "not tracking" on the way out.

The reading beat names the history entry its insert will get (`entry`, from main; for a main that doesn't send it,
the record's `nextId` as this copy has it when the message arrives). The beat ends when that entry is in storage. It
is not tied to the slot's contents, so pulling a cartridge straight out again does not bring it back, and in a swap
the old cartridge's eject does not end it early. The message and the storage write travel separately: a beat that
arrives after its outcome is dropped.

Every change is `ctx.main.request("label" | "forget" | "dismiss" | "start")`, with a pending state on the control
(which keeps keyboard focus: pending controls ignore input rather than being disabled) and its failure in a sentence
under it: main's own refusals verbatim (but for one forget, see Shelf), the platform's codes saying whether it may
have happened. Main's "Couldn't save it; try again" (storage refused a label, forget or dismiss) arrives under
`failed`, the code the platform also gives a handler that threw; it is recognised by its words (`SAVE_REFUSED`, the
one constant main throws and the interface compares) and shown as they are, because there nothing is in doubt and
the control is still there to press again. A start that main ran and that failed is different: main writes the
action's message on the slot and rethrows the action's error, whose code would read as a connection problem. The
interface recognises it by that message and shows the reason main recorded instead (the `error` phase's note already
does; a parked cartridge shows it under Start). While main isn't running the shelf and stage are read-only, under a
notice.

### Phases (the stage)

| Phase | When | Says / offers |
|---|---|---|
| `empty` | no cartridge | "Pick a cartridge"; for 90 s after an eject that saved time, "Saved · 52m of Deep work" (latest history entry) |
| `reading` | from main's `reading` message: at least 750 ms, then until main has written that insert's history entry, at most 12 s (past the 10 s the host gives the session action, plus the write) | the tag; NFC rings, blue LED |
| `playing` | the slot's own session is live | the session's activity (not today's label), start time, a ticking clock |
| `marked` | a point activity was marked, by the insert or by Mark now | "Marked at 10:42": the time of the history entry that carries the mark, not when the cartridge went in |
| `unknown` | unlabelled | suggestions (activities without a cartridge) and a search; nothing takes focus by itself |
| `ready` | labelled, nothing tracking: labelled here ("Labelled"), its session ended elsewhere ("Session ended") or idle | Start tracking (Mark now for a point activity) / Later |
| `parked` | the user said Later to this stay of this cartridge, in this open copy | Start tracking |
| `orphan` / `archived` | its activity was deleted / is archived | relabel picker |
| `error` | main couldn't start it | main's message, Try again / Later |

A cartridge that isn't playing shows today's label, because that is what `start` starts. After a relabel while
playing (which leaves the slot alone) and the session ending, the stage offers the new activity as `ready` / idle: its
session never ran, so it can't have "ended". "Later" and "Labelled" last until the cartridge tracks or marks; after
that the stage speaks for itself again.

A live region says each phase once, in words (never the ticking clock). After labelling from the stage, focus moves to
Start tracking; a session ending elsewhere never moves focus. On a phone, a cartridge that needs the user scrolls the
page back to its prompt.

### Shelf

Every labelled cartridge as an object: the shell's plastic is fixed, the sticker is the activity's colour fading a
little toward the shell under a thin black overlay (opaque, the same on the shelf and in the scene), and the text on
it is near-black or white by contrast with what is painted where the title sits, not with the solid colour. The
cartridge in the player is a dashed ghost: only its sticker's colour fades; its name stays at full strength in the
theme's text colours. An activity without an icon gets a plain tag everywhere.

Stats are per cartridge (`cartridges[tag]`: plays, played time, last seen). Sort: Recent (the one in the player
first), Most played (plays, then time), A–Z (deleted activities last), as a radio group. Past 12 cartridges a filter
appears; past 24 reorders stop animating. The shelf's cards stagger in when it first appears. "Seen, not labelled"
(`unknown` minus the one on the stage) lists the rest, each with Label and Dismiss.

A cartridge opens its details (popover on wide, sheet on phone), compact: stats, its label with Change, and Forget
behind a confirmation (off while it's tracking or in a player that's online). Change swaps the body for the activity
picker and back, so there is one scrolling region at a time and Forget stays in view. Relabelling is allowed while
playing: the running session carries on and the label applies next time; the card and the details then name both
activities ("Gym, in the player, tracking Deep work"). The picker's highlight starts on the current activity, so
Enter changes nothing until the user moves it or types, and shows only while the field has focus or the pointer is
over the list. On the stage the picker's list floats under its field, so using it never changes the stage's height.

Forget follows main's rule (`forgetState` in `view/library.ts`): main refuses only while the session the cartridge's
slot started is live, or while the player holding it is online. So Forget is off, as "Take it out of the player to
forget it", in two cases. The cartridge is in the shown player and that player is online (`presence.online` is true):
it will report the cartridge leaving. Or its session is live with no player known to be online; then a note adds the
other way out: "If it's already out and its player hasn't said so, end the session in Drift Beacon; then it can be
forgotten."

Otherwise Forget is on, also for a cartridge a slot still holds on the word of a player that isn't online: the shown
one is offline or still waited for after main started, or it is a stored player that isn't the shown one, whose
status isn't published. The record may be all that keeps such a cartridge "in the player", and main empties that slot
in the same write. The confirmation says so: "The player last reported this cartridge in its slot. Forgetting it also
clears that." Main has the last word, because it knows whether a player that isn't shown is online. When it refuses a forget this copy offered for a held cartridge,
the confirmation says why instead of repeating main's sentence: "Its player is online after all, so the cartridge
counts as in it. Take it out of the player first." If the cartridge starts tracking or its player comes online while
the confirmation is open, the confirmation gives way to the button's explanation.

Focus is never dropped to the page: it moves into the picker and back to Change, onto Keep and back to Forget, to the
neighbouring card (else the shelf's heading) when a cartridge is forgotten, to the next row when an unlabelled one is
dismissed or labelled, and to the guide's heading when "Set up a player" opens it. A popover that opens for another
card while one is closing is a new panel at its own card.

### Setup

No player ever heard, no cartridges and nothing seen → the setup guide is the whole status panel (the presence pill
would only offer the same guide again), and it holds the stage until the first cartridge goes in, so the moment the
player connects is the guide's to show. Afterwards the presence pill opens the Player panel (presence, name,
firmware, last heard) with "Set up a player", which opens the same guide.

The guide asks one question at a time, each with one main action:

1. **Where is your hub?** Only when the page can't work the address out (prefilled from a player's `hubHost`, else
   the page's host; port 9001 unless known). `localhost` is refused, since a player can't reach it: a page open on a
   loopback host starts empty, and the untouched field asks in a neutral hint; only what the user typed is marked as
   an error. Which steps there are is decided when the guide opens (`guideSteps`), so typing an address doesn't make
   its own step vanish.
2. **Paste an API key.** From Workspace settings → API Keys; kept in the component's state only. It can be skipped:
   the player's page then asks for it.
3. **Copy your setup code.** Built from the address, `ctx.plugin.apiPath` and the key. Copy is the step's main
   button and says Copied only when a copy succeeded, else the field is left selected with how to copy it by hand;
   Continue is available throughout and becomes the main button once the code is copied.
4. **Finish on your phone.** Three lines, which are the firmware's own facts (`tests/ui-render.test.mjs` reads the
   network prefix, the hold time and the address from the firmware's sources): plug the player in (its light
   breathes blue), join its open `Cartridge-XXXX` network, pick the Wi-Fi, paste, Connect; BOOT held 3 s to open
   setup again, and `http://10.123.45.1/` when the page doesn't open by itself. The guide then listens: a player
   that reports after the guide opened (`heardSince`: one it hadn't heard of, a newer report, or the shown one
   coming online) ends it on "… is connected".

Nothing moves between steps except the step: the guide is one fixed frame (progress on top, the step pinned under
it, the actions along the bottom), so the stage keeps its height, the player stays where it is and Continue stays
under the pointer; Back sits at the far edge, where its coming and going shifts nothing. A step leaves and arrives a
short way along the direction of travel (opacity only under reduced motion). The step the guide opens on takes no
focus (opening the page mustn't raise a phone's keyboard); a step the user moved to focuses its field, else its
heading. While the last step waits, the replica's light breathes blue like the real player's, and turns steady
green when it reports (`PlayerScene`'s `setup` light; a cartridge's phase always wins).

### Layout, theme, motion

- **Layout.** The frame's width decides (`(max-width: 599px)`). Wide: stage (scene + status) above the shelf, content
  1072 px at most; from 600 px the scene and status sit side by side and the status body reserves the height of its
  tallest phase (below 768 px the suggestions stay on one line and scroll sideways), so the shelf doesn't move when a
  cartridge goes in or out. Phone: a compact stage pinned at the top (cropped scene beside the presence pill and
  headline), the phase's note and actions under it, a two-column shelf, details and pickers as bottom sheets (the
  page behind is locked while one is open), 44 px targets on touch screens, no horizontal scroll at 375 px. The iframe
  is a fixed viewport and the document scrolls inside it.
- **Theme.** Host tokens through `theme.css` (`--db-*` → HeroUI classes); the stage is a themed surface. The player,
  the cartridges and the clock's amber are physical and keep their materials (the clock and the desk shadows adapt
  their strength to a light surface).
- **Motion.** `ui/src/motion.ts` holds the curves, springs and the scene's timings; CSS curves are `--cp-ease-*`.
  `deck.css` is outside Tailwind's layers, so a pressable's whole transition list (press, colours) lives in
  `.cp-press` and pressables carry no transition utilities. `MotionConfig reducedMotion="user"`, and every transform
  animation checks `useReducedMotionConfig()` itself: under reduced motion the cartridge fades in place, swaps are
  opacity only, and the CSS loops stop. Loops run only while something is live or waiting (reading, tracking, a few
  blinks for attention). A cartridge replacing another in one update leaves before the next goes in. While the tab is
  hidden, animations are created to skip (`lib/background.ts`), so what happened in the background settles on the
  first frame after it is shown instead of replaying. Only the clock re-renders every second.

### Tests

`tests/ui-phase.test.mjs` and `ui-model.test.mjs` run the view layer;
`ui-render.test.mjs` server-renders the real `App` (and the guide and a cartridge's details by themselves) and
checks the live region, the named controls per phase, read-only while main isn't running, the guide's first question
with and without a known hub address, its code step and its firmware facts, when the details offer Forget, and the
waiting pill.

### Harness

`ui/prototype.html` renders the production `App` over `prototypes/sim-model.ts`, a second implementation of main's
rules kept in step by hand (each function names the one in `main/src/` (`player.ts`, `policy.ts`, `record.ts`) it
stands in for). It answers requests like main, with its refusals and its failures (forget included: refused while
the cartridge tracks or the simulated player is online, else the slot is cleared with the label), and takes the
hardware and the workspace from a panel: insert, blank, eject, direct swap, a report that changes nothing (a player
just set up), end the session elsewhere, start
another, delete or archive the activity, player offline, main stopped (started again, it waits a few seconds to hear
from the player, as main does for 75 s), the next request timing out, storage refusing the next label, forget or
dismiss, the next start being refused by the app (main records the error on the slot), the reading message arriving
after its outcome, light/dark, forced reduced motion (Motion and the CSS loops). Its eject is one update, so the
gap the stage holds across (see Data) only shows against the real main. Variants: playing, first run, empty shelf,
seen but not labelled, 60 cartridges. `?explore=1` brings back the Deck, Marquee and Receiver
explorations, and `?setup` the four first-run directions the guide was chosen from (Guided, Ticket, Checklist,
Storyboard). The frame's version line is read from `manifest.json`. The shipped stylesheet leaves `prototypes/`
out, and nothing outside it imports from it.
