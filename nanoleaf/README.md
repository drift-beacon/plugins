# Nanoleaf

Lights up Nanoleaf **Shapes** panels (Hexagons, Triangles, Mini Triangles) in the colour of your current activity, and fills them as you work towards your goal.

## How it works

- **Live session:** the wall glows in the colour of the activity you are tracking.
- **Goal progress:** with a goal, panels fill one after another, in an order you choose.
- **Pinned activity:** when nothing is live, the wall can show a pinned activity and its progress.
- **Schedules:** when a schedule for the person it follows fires, the wall pulses twice in that activity's colour. On a split wall, only the zones of the people the schedule is for pulse.
- **Other plugins:** Magic Cube can show its faces' colours on the wall while you roll.
- **Your brightness:** you set the maximum. The wall steps aside when you change it from the Nanoleaf app, HomeKit or Home Assistant.

## Who the wall follows

In a workspace with more than one person, pick the person the wall follows under **This wall follows**. It glows for their sessions, and a touch on the wall acts for them. Until you pick, it follows the workspace's owner.

You can also split the wall into zones, one per person: each zone is a group of panels that belongs to one person, and each person has at most one zone. Press **Split the wall**, choose whose zone it is, then tap or drag across the panels that belong to it. Each zone has a card where you can change whose it is, choose its panels again, or remove it, and **Add a zone** adds another.

Each zone glows for its own person's session and fills towards its goal, in an order you choose for that zone. When its person has nothing running, it shows the pinned activity. Remove zones until one is left and you're back to one wall that follows one person.

## Gestures on the wall

You choose what a tap, a double tap or a swipe on the panels does. Each one acts for the person the wall follows:

- **Pause or stop** acts on the session the wall is showing, for everyone in it.
- **Start an activity** starts it for them. If they're already in a session of it, nothing changes.
- **Resume** starts the pinned activity again for them.
- **Pin an activity** pins it for the workspace.

On a split wall, a tap or double tap acts for the zone you touch. A swipe acts for the zone it starts in, if your wall reports where swipes happen; if it doesn't, swipes do nothing on a split wall. On a wall that isn't split, everything works as it always has.

## What you need

- Drift Beacon **0.2.4** or later.
- A Nanoleaf Shapes controller on the same local network as your Drift Beacon server. Canvas, Elements and the old Light Panels don't light.

## Set up

1. Open the plugin and pick your controller, or enter its IP address.
2. Hold the controller's power button for 5–7 seconds, until the lights flash. The plugin pairs.

If your controller doesn't show up (it's on another network than your Drift Beacon server, say), enter its IP address, and reserve that address in your router.
