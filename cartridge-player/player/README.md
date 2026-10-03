# Cartridge Player firmware

Firmware 2.x for the physical Cartridge Player: an ESP32-S3-Zero with an MFRC522 NFC reader in a slot. Slide a
labelled cartridge in and the Cartridge Player plugin in Drift Beacon starts its activity; pull it out and it stops.
The player only says what is in its slot (and keeps saying it, so a lost message is harmless); the plugin decides
what that means. [../DESIGN.md](../DESIGN.md) "Player" is the behaviour this firmware implements.

## Parts and wiring

- Waveshare ESP32-S3-Zero
- MFRC522 reader module (RC522), 3.3 V
- Active buzzer (it beeps by itself when powered; a passive one stays silent), on GPIO2
- NFC tags for the cartridges (NTAG21x or MIFARE Classic stickers; any ISO 14443-A tag with a fixed UID)

| MFRC522 / part | ESP32-S3-Zero |
| --- | --- |
| 3.3V | 3V3 (never 5V) |
| GND | GND |
| SDA (chip select) | GPIO13 |
| SCK | GPIO12 |
| MOSI | GPIO11 |
| MISO | GPIO10 |
| RST | 3V3 (the firmware resets the chip over SPI; left floating, the chip may sit in power-down) |
| IRQ | not connected |
| Buzzer + / − | GPIO2 / GND (HIGH sounds it; use a transistor if it draws more than about 20 mA) |
| Status light | the on-board RGB LED (WS2812 on GPIO21), nothing to wire |
| Setup button | the on-board BOOT button (GPIO0), nothing to wire |

## Building and flashing

`sketch.yaml` pins everything: the board and its options, the ESP32 core **3.3.6** and **MFRC522 1.4.12**. Nothing
else is needed: networking and the setup page's web server come with the core, and the firmware reads and writes
JSON with its own code (`src/core/json.h`).

With [arduino-cli](https://arduino.github.io/arduino-cli/), from `cartridge-player/`:

```sh
arduino-cli compile --profile s3zero player
arduino-cli upload --profile s3zero -p /dev/cu.usbmodem1101 player   # your port: arduino-cli board list
```

The first profile build downloads the pinned core and library. With a core and library you installed yourself, the
same build without the profile is
`arduino-cli compile --fqbn "esp32:esp32:waveshare_esp32_s3_zero:CDCOnBoot=default,USBMode=hwcdc,PartitionScheme=default" player`
(the profile spells out the board's other options too; they are its defaults). The profile's board options matter:

- `CDCOnBoot=default` turns serial over the USB-C port **on** (on this board the option names are the other way round
  from the generic ESP32-S3: `cdc` turns it off).
- `USBMode=hwcdc` uses the chip's own USB serial port, so the console works from boot.
- `EraseFlash=none` keeps the saved settings when you flash an update. Erasing flash wipes Wi-Fi and hub settings.

In the Arduino IDE instead: board **Waveshare ESP32-S3-Zero** (esp32 by Espressif 3.3.6), *USB CDC On Boot*:
Enabled, *USB Mode*: Hardware CDC and JTAG, *Partition Scheme*: Default 4MB with spiffs, *Erase All Flash Before
Sketch Upload*: Disabled; library **MFRC522** 1.4.12 (by GithubCommunity). If an upload doesn't start, hold BOOT,
press RESET, let go of BOOT, and upload again.

The setup page is built into `src/portal_page.h` (gzipped). After changing anything in `portal/`, run
`node player/portal/build.mjs` from `cartridge-player/` and flash again. (`pnpm portal` is the same command.
`tests/portal.test.mjs` fails while the header is stale, and `node player/portal/dev-server.mjs` serves the page in
a desktop browser over a faked player.)

The firmware takes about 80% of the default 1.25 MB app slot (two app slots, so updates over the air stay possible
later).

## First setup

1. In Drift Beacon, open **Cartridge Player** and its setup guide ("Set up a player"). Create an API key in
   **Workspace settings → API Keys** (give it its own name, so you can revoke just the player's), paste it into the
   guide, and **copy the setup code**. Do this first: once your phone joins the player's network it can't reach
   Drift Beacon.
2. Power the player. With nothing saved it opens its own Wi-Fi network, **Cartridge-XXXX** (the light breathes
   blue). Join it from your phone; the setup page opens by itself (or go to `http://10.123.45.1/`).
3. Pick your Wi-Fi and type its password. Paste the setup code. (Or choose *Enter details instead*: the hub's address,
   port 9001 for the Home Assistant add-on, the plugin path and the key.)
4. Press **Connect** and watch the checklist: joining your Wi-Fi, the address it got, the plugin answering, saved.
   Your phone may drop off the player's network for a moment while it joins; rejoin to see the result. When it says
   saved, the player's network closes a minute later and the player runs. The plugin's page shows it online.

On a first setup nothing is saved from a failed step except Wi-Fi that did join; fix what the page points at and
press Connect again. A player that is already set up changes nothing until the hub has answered over the new
network: if a step fails it goes back to the Wi-Fi and hub it had.

## What the light and sounds mean

The buzzer has one pitch, so the sounds differ in length and rhythm. `BUZZER OFF` on the console silences them; the
light still flashes. A sound and its flash are the hub's answer to a cartridge going in or out:

| You hear / see | Means |
| --- | --- |
| Short chirp, green flash | The cartridge's activity started, was marked, or carries on |
| Tiny tick, white flash | Out: its session ended (or nothing was running) |
| Two quick beeps, amber | A cartridge the plugin doesn't know yet: label it in Drift Beacon |
| Long beep, red | Something went wrong: the activity was deleted or archived, starting it failed, the hub refused, or it couldn't be reached within 3 s |

Between sounds the light says what the cartridge in the slot is doing. It is the light the player drawn on the
Cartridge Player page shows, so the two agree:

| Light | The cartridge |
| --- | --- |
| Quick blue blinks | Reading: it just went in, and the hub hasn't answered yet |
| Breathing green | Its session is tracking |
| Steady green | It marked a point in time; nothing is running |
| Slow amber blinks | It isn't labelled yet: label it in Drift Beacon |
| Slow red blinks | It can't start: its activity was deleted or archived, or starting it failed. The page says which |
| Faint white | Nothing to show: the slot is empty. The player is on and online |

The light keeps the hub's last answer about a cartridge until you take it out. What you change in the app meanwhile
(ending the session there, labelling the cartridge and starting it) shows on the page at once, and on the player
when the cartridge next goes in. A cartridge left in through a power cut that wasn't tracking shows faint white.

Something of the player's own comes before any of those, and never looks like them:

| Light | The player |
| --- | --- |
| Breathing blue | Setup mode: the player's own network is open |
| Red and blue in turn | The reader hasn't answered for a second or more (check its wiring); cartridges can't be read. It stops once the reader has read the slot again |
| Slow violet pulse | Joining Wi-Fi, or the hub can't be reached (it keeps trying). Also the first seconds of a refusal: a hub that is starting up refuses for a moment |
| Steady red | The hub refuses the player: API key rejected, or plugin path not found or the plugin turned off (after four refusals in a row, about 20 s). Also when the hub refused the last report, until the next one is answered |

In setup mode the chirp and the long beep also end a Connect: saved, or failed (the page says why).

## Setup mode

The player's network, its DNS and the setup page exist only in setup mode. Otherwise the player is a plain Wi-Fi
client: it serves nothing, and only answers to its name on the network (`cartridge-xxxxxx.local`). Setup mode opens:

- when the player isn't set up (it stays open until it is);
- when you hold **BOOT** for 3 seconds;
- when you send `CONFIG` on the console;
- when its saved Wi-Fi hasn't connected for 5 minutes since power-up (for a new router, say). It keeps trying the
  saved network meanwhile and closes setup mode by itself when it connects, unless someone has started a Connect or
  pressed BOOT there by then.

It closes after 10 minutes without a request from the page, a minute after a successful Connect, or from the page's
*Leave setup*. Holding **BOOT** (or sending `CONFIG`) while it is open keeps it open: it cancels a close that was on
its way, and the page starts from the form again. The network is open (no password) and takes one phone at a time;
it exists only for those minutes. *Erase settings…* then *Erase and restart* on the page erases everything.

## Serial console

115200 baud over the USB-C port. Type a command and Enter (any case).

| Command | Does |
| --- | --- |
| `STATUS` | Firmware, id, reader, slot, Wi-Fi, hub and what the hub last said, setup mode, buzzer |
| `CONFIG` | Opens setup mode |
| `RESET` | Restarts |
| `FACTORY` | Erases every setting and restarts; send it twice within 5 seconds |
| `BUZZER ON` / `BUZZER OFF` | Sounds on or off (saved) |
| `HELP` | Lists these |

The console never shows the API key or the Wi-Fi password, only whether they are set.

## Troubleshooting

- **No light at all.** No power, or the firmware isn't running: check the USB cable carries data, and flash again.
- **Red and blue in turn.** The reader doesn't answer: check 3.3V, GND and the four SPI wires, and that RST is tied
  to 3V3. The player keeps trying (after 1 s, then twice as long each time, up to 30 s) and recovers by itself once
  the reader answers. Meanwhile it tells the hub that it can't read the slot, never that the slot is empty, so a
  session that was running keeps running; when the reader is back it reads the slot and reports what it finds.
- **Slow violet pulse that doesn't stop.** Wi-Fi can't join (wrong password or network gone: hold BOOT and connect
  again), or the hub doesn't answer: is Drift Beacon running, and is the address in `STATUS` still right? Something
  else answering at that address (another device that took the hub's IP, a proxy's own page) shows the same. The
  player retries by itself: the hub every 30 s at most, Wi-Fi every 60 s at most.
- **Steady red.** `STATUS` says which: *key rejected* (the API key was deleted or revoked: make a new one and connect
  again from setup mode), *plugin path not found or plugin off* (turn the plugin on for that workspace, update it,
  or set up again if it was reinstalled under another id), or *report refused* (the hub didn't accept the last
  report; it clears at the next answered one, and if it stays, the plugin and the firmware don't match: update
  both). The player asks again every minute, so the first two clear by themselves once fixed.
- **Long beep when a cartridge goes in, then slow red blinks.** The plugin answered `error`: open Cartridge Player
  in Drift Beacon; it shows why (deleted or archived activity, failed start) and offers to fix it. A long beep
  followed by the violet pulse or steady red is the hub not answering or refusing instead: see those.
- **Two beeps and amber blinks for a cartridge you labelled.** It's labelled in another workspace or plugin copy
  than the key's. Label it in the one the player reports to.
- **A cartridge isn't noticed.** Sit it closer to the reader; metal behind the tag blocks it. Phones and bank cards
  with random IDs are ignored on purpose.
- **The setup page doesn't open by itself.** Go to `http://10.123.45.1/` while joined to Cartridge-XXXX. Turn off
  mobile data if the phone keeps leaving the network.
- **The player restarts by itself** with `Hub: request stuck` on the console: a request to the hub hung for 30 s
  (a proxy holding the connection open, say). It restarts to free itself; check what sits between it and the hub.
- **"The player restarted since this page opened" (from Leave setup or Erase: "Reload the setup page and try
  again").** The player restarted while the page was open and the page couldn't fetch its new token. Press the button
  again, or reload the page.
- **"Lost Home before the hub answered"** (with your network's name). Wi-Fi dropped in the middle of a Connect, so
  the player stopped rather than ask the hub without it. Press Connect again, closer to the router if it keeps
  happening.
- **Settings gone after flashing.** The upload erased flash: use the profile, or set *Erase All Flash* to Disabled.
- **Nothing on the console.** USB CDC On Boot must be enabled (`CDCOnBoot=default` on this board).

## Security

The player talks to the hub over plain HTTP on your network, like the Home Assistant add-on's port 9001 itself, so
anyone who can watch that network can see the API key. Give the player its own key. During setup the player's
network is open, so stay nearby and finish within the few minutes it's up. The setup page only answers on the
player's own network and at the player's own address, and needs a per-start token for every change. While setup is
open, a device on the player's network that sends a request very slowly, or a very large one, can freeze the player
for up to 20 seconds and make it restart, which closes setup mode. A saved key is
only ever sent to the hub address it was saved with, over the Wi-Fi network (name and password) it was saved with:
to use it anywhere else, someone has to type it again. A set-up player doesn't take a new network until its hub has
answered over it, so a Connect that fails changes nothing.

## Host tests

The logic (reading, reporting, the protocol, settings rules, setup codes, the Connect flow, what the setup page is
told, its network scan, setup mode, light and sounds) lives in `src/core/` without any Arduino code, and runs on your
computer:

```sh
node --test tests/firmware.test.mjs   # from cartridge-player/; needs Node 24+ and a C++17 compiler (CXX picks one)
```

It builds each `player/tests/test_*.cpp` (with `-Wall -Wextra -pedantic -Werror`, and sanitizers where available)
and runs it, then checks the firmware against the plugin's own `shared/` code: the plugin parses the reports the
firmware writes, the firmware reads the replies the plugin builds, both decode the same setup codes the same way,
and the light shows each of the plugin's answers the way the page's player does. Without a compiler one test fails
saying so and the rest are skipped. Hardware still needs a real check: a cartridge in and out, a swap, Wi-Fi off and
on, and the hub stopped and started.
