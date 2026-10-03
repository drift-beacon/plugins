import { facePalette, type PaletteSource } from "../../shared/palette";
import { mappingsForSetup } from "../../shared/setup";
import { definePlugin, type MainContext, PluginError } from "@drift-beacon/plugin";
import { createLights, type LightEffect } from "./lights";
import type { CubePreset, CubeSettings, CubeStatusState, FaceMappings, LastRollState } from "./storage";
import { emptySettings, UNCATEGORIZED_ID } from "./storage";

type Context = MainContext;

/**
 * Magic Cube: listens to an Aqara cube over Zigbee2MQTT. Hold, then shake, then set the cube down:
 * the face that lands up picks an activity (or a random activity from a category) and, with
 * auto-start on, tracks it. While the cube is in hand it takes the Nanoleaf wall, when that plugin is there: the faces'
 * colours pulse when it is picked up, shuffle when it is shaken, and the winner's colour is revealed when it lands.
 */
export default definePlugin({
  onStart(ctx) {
    // One instance per user and workspace, so the cube's state lives here, not at module scope.
    let state: CubeStatusState["state"] = "idle";
    const lights = createLights({
      command: (name, input) => ctx.plugins.get(NANOLEAF).command(name, input, { timeoutMs: LIGHTS_TIMEOUT_MS }),
      log: ctx.log,
    });
    /** The wall follows the cube: a pulse while held, a shuffle while shaken, nothing when it is put down. */
    const light = (winner?: string | null) => {
      const colors = lightsOn(ctx) ? palette(ctx) : [];
      const effect: LightEffect | null =
        colors.length === 0 ? null
        : winner ? { type: "reveal", colors, color: winner }
        : state === "held" ? { type: "pulse", colors }
        : state === "activated" ? { type: "shuffle", colors }
        : null;
      if (effect) lights.show(effect);
      else lights.release();
    };
    const setState = (next: CubeStatusState["state"], reason: string, winner?: string | null) => {
      ctx.log.info(`State: ${state} → ${next} (${reason})`);
      state = next;
      ctx.state.set("cube", state);
      void ctx.storage
        .set("cubeStatus", { state, timestamp: new Date().toISOString() } satisfies CubeStatusState)
        .catch((error: unknown) => ctx.log.warn("Could not save cube status", error));
      light(winner);
    };
    ctx.onStop(() => lights.stop());

    // What other plugins see: the presets, the loaded one, the cube and its last roll. Published state lasts only while
    // this instance runs, so it's published from storage here and kept up as that changes. The UI's own edits arrive
    // through onChange; this instance's writes publish where they're made.
    publishPresets(ctx);
    publishLastRoll(ctx, ctx.storage.get<LastRollState>("lastRoll"));
    ctx.state.set("cube", state);
    ctx.storage.onChange((key) => {
      if (key !== "settings") return;
      publishPresets(ctx);
      // The faces or the lights setting changed with the cube in hand: the wall follows, or is let go.
      if (state !== "idle") light();
    });

    // Other plugins (and Home Assistant) can switch presets, as the preset picker in the UI does.
    ctx.commands.handle("selectPreset", async (input) => {
      const settings = ctx.storage.get<CubeSettings>("settings") ?? emptySettings();
      const wanted = input.preset as string | null;
      if (wanted === null) {
        await ctx.storage.set("settings", { ...settings, activePresetId: null });
        publishPresets(ctx);
        return { activePresetId: null, name: null };
      }
      const presets = settings.presets;
      const preset =
        presets.find((item) => item.id === wanted) ??
        presets.find((item) => item.name.toLowerCase() === wanted.toLowerCase());
      if (!preset) throw new PluginError("not-found", `No preset named "${wanted}"`);
      await ctx.storage.set("settings", { ...settings, setup: structuredClone(preset.setup), autoStartEnabled: preset.autoStartEnabled, activePresetId: preset.id });
      publishPresets(ctx);
      return { activePresetId: preset.id, name: preset.name };
    });

    const topic = ctx.config.mqttTopic;
    if (!topic) {
      ctx.log.warn("No MQTT topic configured");
      return;
    }

    ctx.mqtt.subscribe(topic, ({ payload }) => {
      ctx.log.info("MQTT message received", payload);
      let data: { action?: string; side?: number };
      try {
        data = JSON.parse(payload);
      } catch {
        ctx.log.error("Failed to parse MQTT payload");
        return;
      }
      const { action, side } = data;
      if (!action) return;
      // Anything the cube says while in hand keeps its hold on the lights alive.
      if (state !== "idle") lights.touch();

      if (action === "1_min_inactivity") {
        if (state !== "idle") setState("idle", "inactivity");
        return;
      }
      switch (state) {
        case "idle":
          if (action === "hold") setState("held", "hold");
          break;
        case "held":
          setState(action === "shake" ? "activated" : "idle", action);
          break;
        case "activated":
          if (action === "shake") setState("held", "shake again");
          else if (action === "side_up" && side != null) {
            // flip_to_side often fires before side_up; only side_up counts. The roll is saved before the cube goes
            // idle, so the UI has it when it sees that. Both happen before anything awaits: the cube can send side_up
            // again while the roll's track() is pending, and one activation is one roll.
            const winner = recordRoll(ctx, side);
            setState("idle", `rolled ${side}`, winner);
          }
          break;
      }
    });
  },
});

/** The activity a face picks: a mapped activity, or a random span activity from a mapped category. */
function resolveActivityId(ctx: Context, faceMappings: FaceMappings, side: number): string | null {
  const mapping = faceMappings[String(side)];
  if (mapping?.type === "activity") {
    const activity = ctx.activities.get(mapping.id);
    return activity && !activity.archived ? activity.id : null;
  }
  if (mapping?.type === "category") {
    const categoryId = mapping.id === UNCATEGORIZED_ID ? null : mapping.id;
    const excluded = new Set(mapping.excludedActivityIds ?? []);
    const candidates = ctx.activities.list({ categoryId, trackingType: "span" }).filter(a => !excluded.has(a.id));
    if (candidates.length > 0) return candidates[Math.floor(Math.random() * candidates.length)]?.id ?? null;
  }
  return null;
}

/**
 * Save the roll and, with auto-start on, track what it picked. The roll is saved as auto-started straight away, so the
 * UI shows it without waiting for the server; if tracking fails, it's saved again waiting for a manual start. Answers
 * the picked activity's colour, for the lights' reveal; null when the face picked nothing.
 */
function recordRoll(ctx: Context, side: number): string | null {
  const settings = ctx.storage.get<CubeSettings>("settings") ?? emptySettings();
  const faceMappings = mappingsForSetup(settings.setup);
  const autoStartEnabled = settings.autoStartEnabled;
  const activityId = resolveActivityId(ctx, faceMappings, side);
  const activity = activityId ? ctx.activities.get(activityId) : undefined;
  const autoStart = autoStartEnabled && activity !== undefined;

  const roll: LastRollState = {
    side,
    mapping: faceMappings[String(side)] ?? null,
    activityId,
    timestamp: new Date().toISOString(),
    presetId: settings.activePresetId,
    startMode: autoStart ? "auto" : null,
  };
  saveRoll(ctx, roll);
  ctx.events.emit("rolled", peerRoll(ctx, roll));

  if (autoStart) {
    void activity.track().then(session => {
      if (ctx.storage.get<LastRollState>("lastRoll")?.timestamp === roll.timestamp) saveRoll(ctx, { ...roll, sessionId: session.id });
    }).catch((error: unknown) => {
      ctx.log.error("Failed to auto-start activity", error);
      // Unless a newer roll has replaced it.
      if (ctx.storage.get<LastRollState>("lastRoll")?.timestamp === roll.timestamp) saveRoll(ctx, { ...roll, startMode: null });
    });
  }
  return activity ? String(activity.color) : null;
}

/** The Nanoleaf plugin (manifest.json `uses`), and how long one of its commands may take. */
const NANOLEAF = "nanoleaf";
const LIGHTS_TIMEOUT_MS = 3000;

const lightsOn = (ctx: Context) => (ctx.storage.get<CubeSettings>("settings") ?? emptySettings()).lightNanoleaf !== false;

/** The faces' colours, as the wall shows them: each mapped activity's or category's colour once. */
function palette(ctx: Context): string[] {
  const settings = ctx.storage.get<CubeSettings>("settings") ?? emptySettings();
  const source: PaletteSource = {
    activity: (id) => ctx.activities.get(id),
    category: (id) => ctx.categories.get(id),
    uncategorized: () => ctx.activities.list({ categoryId: null })[0]?.color,
  };
  return facePalette(mappingsForSetup(settings.setup), source);
}

function saveRoll(ctx: Context, roll: LastRollState) {
  void ctx.storage.set("lastRoll", roll).catch((error: unknown) => ctx.log.error("Could not record the roll", error));
  publishLastRoll(ctx, roll);
}

/** A preset as other plugins see it. */
const peerPreset = (preset: CubePreset) => ({ id: preset.id, name: preset.name, mode: preset.setup.mode });

function publishPresets(ctx: Context) {
  const settings = ctx.storage.get<CubeSettings>("settings") ?? emptySettings();
  const presets = settings.presets;
  const activeId = settings.activePresetId;
  const active = presets.find((preset) => preset.id === activeId);
  ctx.state.set("presets", presets.map(peerPreset));
  ctx.state.set("activePreset", active ? peerPreset(active) : null);
}

/** A roll as other plugins see it, with the activity's name. */
function peerRoll(ctx: Context, roll: LastRollState) {
  const activity = roll.activityId ? ctx.activities.get(roll.activityId) : undefined;
  return {
    side: roll.side,
    activityId: roll.activityId,
    activityName: activity ? String(activity.name) : null,
    startMode: roll.startMode,
    at: roll.timestamp,
  };
}

function publishLastRoll(ctx: Context, roll: LastRollState | undefined) {
  if (roll) ctx.state.set("lastRoll", peerRoll(ctx, roll));
}
