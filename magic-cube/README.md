# Magic Cube

Choose what to do next by rolling an Aqara T1 Cube. Hold it, shake it and set it down: the face that lands up picks an activity.

## How it works

- **Roll to choose:** hold the cube, shake it, then set it down. The face on top picks its activity, or a random one from its category.
- **Four ways to choose:**
  - **Feel vs Should:** two contenders, and the cube settles the argument.
  - **Shortlist:** a handful of things, shared out fairly across the faces.
  - **Roulette:** one category, and the cube surprises you.
  - **Manual:** every face hand-picked.
- **Presets:** save a setup and switch between them, for example one for your everyday routine.
- **Auto-start:** start tracking the moment the cube lands, or keep the result and start it yourself.
- **Nanoleaf:** with the Nanoleaf plugin, the wall pulses in the faces' colours while you hold the cube, shuffles as you shake it and shows the winner's colour when it lands.

## What you need

- Drift Beacon **0.2.4** or later.
- An **Aqara T1 Cube**, paired with **Zigbee2MQTT**.
- An **MQTT broker** connected to Drift Beacon.

## Set up

1. In the plugin's settings, enter the cube's Zigbee2MQTT topic, for example `zigbee2mqtt/MagicCube`.
2. Open the plugin, pick how the cube should choose and assign activities or categories to its faces.
3. Hold, shake and set the cube down.
