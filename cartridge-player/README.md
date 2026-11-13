# Cartridge Player

A physical player with one slot. Slide a labelled NFC cartridge in and its activity starts tracking; pull it out and it stops.

Based on the cartridge player from [StockPot](https://www.thestockpot.net/cartridge-player).

## How it works

- **Who a cartridge tracks for:** open a cartridge in the plugin and pick people under **Tracks for**. A newly labelled cartridge tracks for whoever labelled it. If everyone picked leaves the workspace, it tracks for the workspace's owner.
- **Insert to start:** the cartridge's activity starts for the people it tracks for. If they're all already in a session of that activity, the cartridge takes that session over; otherwise it starts a new one for all of them.
- **Eject to stop:** taking a cartridge out ends only the session it started or took over, for everyone in it.
- **Start in the plugin:** with a cartridge in that isn't tracking, Start starts it for the people it tracks for.
- **Point activities:** a cartridge for a point activity marks it once, for the people it tracks for, when it goes in.
- **Labelling:** a new cartridge shows up in the plugin as "Seen, not labelled". Pick an activity for it there.
- **Forgetting:** removes a cartridge's label. Take it out of the player first.
- **Stats:** plays, time tracked and when each cartridge was last seen.

## What you need

- Drift Beacon with plugins shared by the whole workspace (plugin SDK **0.4.1** or later). An earlier Drift Beacon can't install this version of the plugin.
- A Cartridge Player on **firmware 2.x**, on the same local network as your hub.
- A **workspace API key** (Workspace settings → API Keys).

## Set up a player

1. Open the plugin and choose **Set up a player**. Paste your API key to get a setup code.
2. Power the player and join its Wi-Fi network **Cartridge-XXXX** from your phone. The setup page opens by itself.
3. Choose your Wi-Fi, paste the setup code and press **Connect**.

To set a player up again, hold its BOOT button for 3 seconds.

[player/README.md](player/README.md) covers the hardware: wiring, and what the light and sounds mean.
