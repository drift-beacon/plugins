import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BRIGHTNESS_SETTINGS, brightnessState, saveBrightness } from "../main/src/brightness.ts";
import { DEFAULT_SETTINGS, readSettings, SETTING_RANGES } from "../shared/storage.ts";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

function memoryStorage(initial) {
  const values = new Map(Object.entries(initial));
  return { values, get: (key) => values.get(key), set: async (key, value) => void values.set(key, value) };
}

test("a brightness command saves its one setting and keeps the others", async () => {
  const saved = { ...DEFAULT_SETTINGS, maxBrightness: 60, pinnedBrightness: 20, track: false };
  const storage = memoryStorage({ settings: saved });
  await saveBrightness(storage, "session", 45);
  assert.deepEqual(storage.values.get("settings"), { ...saved, maxBrightness: 45 });
  await saveBrightness(storage, "pinned", 90);
  assert.deepEqual(storage.values.get("settings"), { ...saved, maxBrightness: 45, pinnedBrightness: 90 });
  assert.deepEqual(brightnessState(readSettings(storage.values.get("settings"))), { session: 45, pinned: 90 });
});

test("nothing saved yet: a brightness command starts from the defaults", async () => {
  const storage = memoryStorage({});
  await saveBrightness(storage, "pinned", 50);
  assert.deepEqual(storage.values.get("settings"), { ...DEFAULT_SETTINGS, pinnedBrightness: 50 });
});

test("the brightness controls are ranges over the settings' own ends, set by latest-mode commands", () => {
  const { commands, state, controls } = manifest.provides;
  const settingFor = { sessionBrightness: "session", pinnedBrightness: "pinned" };
  for (const [name, which] of Object.entries(settingFor)) {
    const control = controls[name];
    assert.equal(control.kind, "range");
    assert.deepEqual(control.value, { state: "brightness", path: which });
    const command = commands[control.set.command];
    assert.equal(command.mode, "latest");
    const { min, max } = SETTING_RANGES[BRIGHTNESS_SETTINGS[which]];
    const field = command.input.properties[control.set.field];
    assert.deepEqual([field.type, field.minimum, field.maximum], ["integer", min, max]);
    const property = state.brightness.schema.properties[which];
    assert.deepEqual([property.type, property.minimum, property.maximum], ["integer", min, max]);
  }
});
