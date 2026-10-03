# Cartridge Player

A physical player with one slot. Slide a labelled NFC cartridge in and its activity starts tracking; pull it out and it stops.

Based on the cartridge player from [StockPot](https://www.thestockpot.net/cartridge-player).

## How it works

- **Insert to start:** the cartridge's activity starts. If it is already running, the cartridge takes that session over.
- **Eject to stop:** taking a cartridge out ends only the session it started or took over.
- **Point activities:** a cartridge for a point activity marks it once when it goes in.
- **Labelling:** a new cartridge shows up in the plugin as "Seen, not labelled". Pick an activity for it there.
- **Forgetting:** removes a cartridge's label. Take it out of the player first.
- **Stats:** plays, time tracked and when each cartridge was last seen.

## What you need

- Drift Beacon **0.2.4** or later.
- A Cartridge Player on **firmware 2.x**, on the same local network as your hub.
- A **workspace API key** (Workspace settings → API Keys).

## Set up a player

1. Open the plugin and choose **Set up a player**. Paste your API key to get a setup code.
2. Power the player and join its Wi-Fi network **Cartridge-XXXX** from your phone. The setup page opens by itself.
3. Choose your Wi-Fi, paste the setup code and press **Connect**.

To set a player up again, hold its BOOT button for 3 seconds.

[player/README.md](player/README.md) covers the hardware: wiring, and what the light and sounds mean.
