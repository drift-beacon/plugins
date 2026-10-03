import { useState } from "react";
import { blankSetup,type ModeId,type ModeState } from "../../../../shared/setup";
import { saveStorage,useDriftBeacon } from "../../drift-beacon";
import { emptySettings,type CubePreset,type CubeSettings } from "../../storage";

export interface Preset { id: string; name: string; setup: ModeState; autoStart: boolean }
const viewPreset = (p: CubePreset): Preset => ({ id: p.id, name: p.name, setup: p.setup, autoStart: p.autoStartEnabled });

/** Whether the Nanoleaf plugin (manifest.json `uses`) is installed for this user: an app that can't say counts as no. */
function nanoleafHere(ctx: ReturnType<typeof useDriftBeacon>): boolean {
  try { return ctx.plugins.get("nanoleaf").status.state !== "not-installed"; }
  catch { return false; }
}

/** Each edit reads the latest settings, including changes received from another UI or a preset command. */
export function useWorkspace() {
  const ctx = useDriftBeacon();
  const [error, setError] = useState<string | null>(null);
  const current = () => ctx.storage.get<CubeSettings>("settings") ?? emptySettings();
  const settings = current();
  const nanoleaf = nanoleafHere(ctx);
  const { activePresetId: activeId, setup, autoStartEnabled: autoStart } = settings;
  const presets = settings.presets.map(viewPreset);

  async function write(next: CubeSettings) {
    setError(null);
    try { await saveStorage({ settings: next }); return true; }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save the change. Please try again."); return false; }
  }
  function updateWorking(next: ModeState, auto: boolean) {
    const cur = current();
    return write({ ...cur, setup: next, autoStartEnabled: auto,
      presets: cur.presets.map(p => p.id === cur.activePresetId ? { ...p, setup: next, autoStartEnabled: auto, updatedAt: new Date().toISOString() } : p),
    });
  }
  function save(name: string, next: ModeState, auto: boolean) {
    if (!name.trim()) return Promise.resolve(false);
    const now = new Date().toISOString();
    const preset: CubePreset = { id: crypto.randomUUID(), name: name.trim(), setup: next, autoStartEnabled: auto, createdAt: now, updatedAt: now };
    const cur = current();
    return write({ ...cur, presets: [...cur.presets, preset], activePresetId: preset.id, setup: next, autoStartEnabled: auto });
  }
  return {
    presets, activeId, active: presets.find(p => p.id === activeId) ?? null, setup, autoStart,
    bootKey: activeId ?? "unsaved",
    error, clearError: () => setError(null),
    update(patch: Partial<ModeState>) { const cur = current(); return updateWorking({ ...cur.setup, ...patch }, cur.autoStartEnabled); },
    setAutoStart(value: boolean) { return updateWorking(current().setup, value); },
    /** The Nanoleaf plugin, when it is installed here: the cube can light its wall. Not part of a preset. */
    nanoleaf,
    lightNanoleaf: settings.lightNanoleaf !== false,
    setLightNanoleaf(value: boolean) { return write({ ...current(), lightNanoleaf: value }); },
    select(id: string | null) {
      const cur = current();
      if (!id) return write({ ...cur, activePresetId: null });
      const preset = cur.presets.find(p => p.id === id);
      if (!preset) return Promise.resolve(false);
      return write({ ...cur, activePresetId: id, setup: structuredClone(preset.setup), autoStartEnabled: preset.autoStartEnabled });
    },
    saveAsNew(name: string) { const cur = current(); return save(name, cur.setup, cur.autoStartEnabled); },
    create(name: string, mode: ModeId) { return save(name, blankSetup(mode), false); },
    rename(name: string, id = activeId) {
      if (!name.trim()) return Promise.resolve(false);
      const cur = current();
      return write({ ...cur, presets: cur.presets.map(p => p.id === id ? { ...p, name: name.trim(), updatedAt: new Date().toISOString() } : p) });
    },
    duplicate(id: string) {
      const cur = current(); const source = cur.presets.find(p => p.id === id);
      if (!source) return Promise.resolve(false);
      const now = new Date().toISOString();
      return write({ ...cur, presets: [...cur.presets, { ...structuredClone(source), id: crypto.randomUUID(), name: `${source.name} copy`, createdAt: now, updatedAt: now }] });
    },
    remove(id = activeId) {
      const cur = current();
      return write({ ...cur, presets: cur.presets.filter(p => p.id !== id), activePresetId: id === cur.activePresetId ? null : cur.activePresetId });
    },
  };
}
export type Workspace = ReturnType<typeof useWorkspace>;
