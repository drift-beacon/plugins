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
- **Who it's for:** the cube can't tell who rolled it, so you pick who every roll is for, with the people button by Pin/Track. One or more members, never nobody. A roll that starts something starts it for them, moving them out of whatever they were in; one that marks something marks it for them and leaves them where they were. Starting or marking a kept roll yourself in the plugin does the same. If someone you picked leaves the workspace, the roll is for the others; with none of them left, it's for the workspace's owner. In a workspace of one, every roll is yours.
- **Discard:** anyone in the workspace can throw away the roll's session from the plugin, as in the app.
- **Nanoleaf:** with the Nanoleaf plugin, the wall pulses in the faces' colours while you hold the cube, shuffles as you shake it and shows the winner's colour when it lands.
- **Preset control:** the plugin declares its presets as a list and the active preset as a control, so an app connected to Drift Beacon that reads plugin controls can offer the presets by name and show which one is active.

## What you need

- Drift Beacon with plugins shared by the whole workspace (plugin SDK **0.4.1** or later). An earlier Drift Beacon can't install this version of the plugin.
- An **Aqara T1 Cube**, paired with **Zigbee2MQTT**.
- An **MQTT broker** connected to Drift Beacon.

## Set up

1. In the plugin's settings, enter the cube's Zigbee2MQTT topic, for example `zigbee2mqtt/MagicCube`.
2. Open the plugin, pick how the cube should choose and assign activities or categories to its faces.
3. Hold, shake and set the cube down.
