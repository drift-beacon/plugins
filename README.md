# Drift Beacon Plugins: The official repository

Plugins extend Drift Beacon with new ways to choose activities, track your time, and connect your physical devices. Roll an activity with a cube, start tracking with an NFC cartridge, or watch your goal progress light up on your wall.

Plugins can be installed and configured from the Drift Beacon dashboard.

## Installation

1. Open **Plugins → Repositories** in your Drift Beacon dashboard.
2. Select **Add repository** and enter [https://github.com/drift-beacon/plugins](https://github.com/drift-beacon/plugins).
3. Choose a plugin, install it, and follow its setup instructions.

Some plugins require additional hardware. See the linked guides for details.

## Plugins provided by this repository

- **[Cartridge Player](cartridge-player/README.md)**

  Based on the cartridge player from [StockPot](https://www.thestockpot.net/cartridge-player). Start tracking an activity by inserting its NFC cartridge into a physical player. Remove the cartridge to stop. See the [player guide](cartridge-player/player/README.md) for hardware and setup.

- **[Magic Cube](magic-cube/README.md)**

  Choose activities with an Aqara T1 Cube. Assign activities or categories to its faces, or shake it to roll a choice. Connects through Zigbee2MQTT.

- **[Nanoleaf](nanoleaf/README.md)**

  Light up Nanoleaf Shapes panels in the colour of your current activity and watch them fill as you work towards your goal.
