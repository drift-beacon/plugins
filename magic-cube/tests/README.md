# Magic Cube checks

Run `pnpm test` for mode-to-face resolution and main-runtime tests. The tests exercise real production functions with an in-memory host; they do not contact hardware or a workspace.

With `pnpm dev` running, open `/tests/host.html` for integration checks. This development-only fixture embeds the real `/index.html` entry through the SDK handshake. Its sample data is isolated in browser session storage and is not included in release bundles. It provides controls for an empty collection, many presets, external selection, hardware state changes and a rejected save.

Check preset create/rename/duplicate/delete, mode editing, reload persistence, search, save failure rollback, and Hold → Shake → Land → Start/Mark → Discard/Undo. Below 600px wide the phone layout takes over: verify the cube stays pinned under the preset name and Pin/Track while the options scroll, the name opens the preset sheet (load, rename, duplicate, delete, new), tapping a face opens its picker along the bottom, picking the cube up gives it the whole view, and there is no horizontal overflow.

Production data uses one `settings` record containing `presets`, `activePresetId`, `setup` and `autoStartEnabled`. Each preset stores its own setup and Pin/Track value. The main runtime resolves six faces from this setup, including roulette exclusions. `cubeStatus` and `lastRoll` remain separate live records. Previous storage formats are not migrated.

## Nanoleaf lights

With the Nanoleaf plugin (0.3 or later) installed, the cube takes its wall while it is in hand: `main/src/lights.ts` runs that plugin's `takeControl` and `releaseControl`, and `shared/palette.ts` turns the six faces into colours (an activity's, or a category's; each once).

| Cube | Wall |
|---|---|
| Picked up (`held`) | A slow pulse of the faces' colours |
| Shaken (`activated`) | Every panel shuffles through them; a second shake goes back to the pulse |
| Lands on a face that picks an activity | A reveal that locks the wall to that activity's colour, then the wall is let go |
| Lands on an empty face, put down, or `1_min_inactivity` | Let go |

A hold is a 75 s lease that any message from the cube renews (at most every 15 s); 70 s without one lets the wall go, so a missed inactivity report can't keep it. That deadline only lets go of the lights: the cube's own state is untouched. The `lightNanoleaf` setting (the lightbulb beside Pin/Track, shown where the Nanoleaf plugin is installed) switches it off; it belongs to the cube, not to a preset. A Nanoleaf plugin that isn't installed, enabled or running is logged once and otherwise ignored.

`pnpm test` covers the palette for every mode, the driver (ordering, retries with one request id, renewal, the silence deadline, a missing Nanoleaf) and the calls each cube transition makes.
