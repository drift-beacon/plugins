# Nanoleaf

Lights up Nanoleaf **Shapes** panels (Hexagons, Triangles, Mini Triangles) in the colour of your current activity, and fills them as you work towards your goal.

## How it works

- **Live session:** the wall glows in the colour of the activity you are tracking.
- **Goal progress:** with a goal, panels fill one after another, in an order you choose.
- **Pinned activity:** when nothing is live, the wall can show a pinned activity and its progress.
- **Schedules:** when a schedule fires, the wall pulses twice in that activity's colour.
- **Other plugins:** Magic Cube can show its faces' colours on the wall while you roll.
- **Your brightness:** you set the maximum. The wall steps aside when you change it from the Nanoleaf app, HomeKit or Home Assistant.

## What you need

- Drift Beacon **0.2.4** or later.
- A Nanoleaf Shapes controller on the same local network as your Drift Beacon server. Canvas, Elements and the old Light Panels don't light.

## Set up

1. Open the plugin and pick your controller, or enter its IP address.
2. Hold the controller's power button for 5–7 seconds, until the lights flash. The plugin pairs.

On the Home Assistant add-on the plugin can't find controllers by itself: enter the controller's IP address, and reserve that address in your router.
