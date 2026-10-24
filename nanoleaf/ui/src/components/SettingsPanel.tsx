import { Slider } from "@heroui/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { parseColor, toLedRgb, WARM_WHITE } from "../../../shared/color.ts";
import { SETTING_RANGES } from "../../../shared/storage.ts";
import type { IdleBehaviour, PinnedStyle, Rgb, Scene } from "../../../shared/types.ts";
import { setBrightnessDrag, useDrafting } from "../hooks/useDrawnLight.ts";
import { useScene } from "../hooks/useScene.ts";
import { useWallPreview } from "../hooks/useWallPreview.ts";
import { useModel } from "../model.ts";
import { LightStrip, liveScene, pinScene, pluginScene } from "./LightStrip.tsx";
import { Segmented } from "./Segmented.tsx";
import { canPreviewBrightness } from "./status.ts";
import { SwitchRow } from "./SwitchRow.tsx";

/** Runs `fn` at most every `ms`: the first call at once, the last one always (a slider's final value must land). */
function useThrottle<T>(fn: (value: T) => void, ms: number): (value: T) => void {
  const latest = useRef(fn);
  latest.current = fn;
  const state = useRef<{ last: number; timer: number | null; pending: { value: T } | null }>({
    last: 0,
    timer: null,
    pending: null,
  });
  useEffect(() => () => window.clearTimeout(state.current.timer ?? undefined), []);
  return useRef((value: T) => {
    const s = state.current;
    const wait = s.last + ms - Date.now();
    if (wait <= 0 && s.timer === null) {
      s.last = Date.now();
      latest.current(value);
      return;
    }
    s.pending = { value };
    if (s.timer !== null) return;
    s.timer = window.setTimeout(
      () => {
        s.timer = null;
        s.last = Date.now();
        if (s.pending) latest.current(s.pending.value);
        s.pending = null;
      },
      Math.max(wait, 0),
    );
  }).current;
}

/** Main lets a `brightness` request override the wall's brightness for 3 s (`overrideMs`): a held thumb renews it. */
const HOLD_RENEW_MS = 1000;

/**
 * Keeps sending the last value while a slider's thumb is held: a thumb that stops moving sends nothing new, and the
 * wall would fall back to the saved brightness while it's still held.
 */
function useHeld(send: (value: number) => void, ms: number) {
  const latest = useRef(send);
  latest.current = send;
  const state = useRef<{ value: number; timer: number | null }>({ value: 0, timer: null });
  useEffect(() => () => window.clearInterval(state.current.timer ?? undefined), []);
  return useRef({
    hold(value: number) {
      const s = state.current;
      s.value = value;
      if (s.timer === null) s.timer = window.setInterval(() => latest.current(s.value), ms);
    },
    release() {
      window.clearInterval(state.current.timer ?? undefined);
      state.current.timer = null;
    },
  }).current;
}

/** A slider's local value while it's dragged, falling back to the saved one; saved on release. */
function useDraft(saved: number) {
  const [draft, setDraft] = useState<number | null>(null);
  return { value: draft ?? saved, set: setDraft, clear: () => setDraft(null) };
}

const first = (v: number | number[]) => (Array.isArray(v) ? v[0] : v);

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="font-semibold text-[10px] text-default-400 uppercase tracking-wider">{children}</div>;
}

/** A situation's title and what it is, at the top of its group. */
function Situation({ title, lede }: { title: string; lede: string }) {
  return (
    <div>
      <Eyebrow>{title}</Eyebrow>
      <p className="mt-1 text-default-500 text-xs leading-snug">{lede}</p>
    </div>
  );
}

/** A switch with a small live picture beside it of the wall as the switch leaves it: it changes as the switch does. */
function PreviewRow({ scene, alert = null, children }: { scene: Scene; alert?: string | null; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-[72px] shrink-0 rounded-lg bg-content2/60 px-1.5 py-1">
        <LightStrip scene={scene} alert={alert} className="h-8" />
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** How long a failed save stays on screen. */
const SAVE_ERROR_MS = 6000;

const SLIDER_CLASSES = {
  label: "text-sm font-medium",
  value: "text-sm tabular-nums text-default-500",
};

/** Screen readers hear "80%", not "80" (the values are whole percents, not fractions). */
const PERCENT: Intl.NumberFormatOptions = { style: "unit", unit: "percent" };

export type SettingsGroup = "brightness" | "pinnedBrightness" | "pinned" | "track" | "schedule" | "idle" | "plugins";

/**
 * Everything the user tunes, as groups a layout places: the two brightnesses (a session's, and a pin's own), then one
 * group per situation the wall can be in (an activity pinned, a session live, a schedule firing, nothing going on,
 * another plugin asking for it). Both sliders preview on the wall while they move, the same way whatever shows (a
 * session, a pin or nothing): a full `fill` preview (a pin's colour for Pinned brightness) driven at the dragged value
 * through `brightness` requests (at most every 120 ms, and every second while the thumb is held still). On release the
 * preview ends and the wall goes back to what shows, at its own brightness. Each saves when the thumb lets go;
 * everything else saves at once. A save the app refuses rolls back and says so in `saveError`.
 */
export function useSettingsGroups(): Record<SettingsGroup, ReactNode> & { readonly saveError: string | null } {
  const model = useModel();
  const scene = useScene();
  const { settings, actions } = model;
  const wall = useWallPreview();
  const [saveError, setSaveError] = useState<string | null>(null);
  const errorTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(errorTimer.current), []);

  /** Saves a patch; a refusal (the SDK has rolled the value back) shows for a few seconds instead of vanishing. */
  const save = (patch: Parameters<typeof actions.saveSettings>[0]) =>
    actions.saveSettings(patch).then(
      () => setSaveError(null),
      (e: unknown) => {
        setSaveError(`Couldn't save that: ${e instanceof Error ? e.message : String(e)}`);
        window.clearTimeout(errorTimer.current);
        errorTimer.current = window.setTimeout(() => setSaveError(null), SAVE_ERROR_MS);
      },
    );
  const brightness = useDraft(settings.maxBrightness);
  const pinnedBrightness = useDraft(settings.pinnedBrightness);
  // Tap to order holds the wall at its own brightness: a slider dragged meanwhile only saves.
  const drafting = useDrafting();
  const previews = canPreviewBrightness(model) && !drafting;
  const tryBrightness = useThrottle((value: number) => void actions.brightness(value).catch(() => {}), 120);
  const held = useHeld((value: number) => void actions.brightness(value).catch(() => {}), HOLD_RENEW_MS);
  /**
   * Lights the slider's preview at `value` while the thumb moves, on the drawings (`rgb`) and the wall (`activityId`);
   * null for both is the colour of what shows.
   */
  const tryOnWall = (value: number, activityId: string | null, rgb: Rgb | null) => {
    if (drafting) return;
    setBrightnessDrag({ value, rgb });
    if (!previews) return;
    tryBrightness(value);
    held.hold(value);
    wall.showWall({ mode: "fill", fraction: 1, activityId });
  };
  /**
   * Ends the preview, and sends the brightness of what shows (`showsAt`): the override would otherwise keep the
   * slider's value on it for a few seconds.
   */
  const letGo = (showsAt: number) => {
    setBrightnessDrag(null);
    held.release();
    if (!previews) return;
    wall.showWall(null);
    tryBrightness(showsAt);
  };

  // Previews use the pinned activity's colour when there is one, else whatever is showing.
  const pinned = model.activities.find((a) => !a.archived && a.pinnedBy?.includes(model.userId));
  const color = pinned?.color ?? scene.cssColor ?? "#a78bfa";
  const pinnedCss = pinned?.color ?? null;
  const pinnedRgb = useMemo(() => (pinnedCss ? toLedRgb(parseColor(pinnedCss) ?? WARM_WHITE) : null), [pinnedCss]);
  // A drag the layout cut short (the tab changed under the thumb) doesn't leave the drawings previewing.
  useEffect(() => () => setBrightnessDrag(null), []);

  // A pin as bright beside a session as it will be: the previews show a pin's light, not the wall's brightness.
  const pinLevel = Math.min(1, pinnedBrightness.value / Math.max(1, brightness.value));
  const pin = (style: PinnedStyle = settings.pinnedStyle) =>
    pinScene(color, style, pinLevel, settings.pinnedProgress, settings.track);
  const preview = (style: PinnedStyle) => <LightStrip scene={pin(style)} className="h-12 rounded-lg bg-content1" />;

  return {
    saveError,
    brightness: (
      <div className="p-4">
        <Slider
          size="sm"
          label="Session brightness"
          aria-label="Session brightness"
          minValue={SETTING_RANGES.maxBrightness.min}
          maxValue={SETTING_RANGES.maxBrightness.max}
          step={1}
          value={brightness.value}
          getValue={(v) => `${first(v as number | number[])}%`}
          formatOptions={PERCENT}
          onChange={(v) => {
            brightness.set(first(v));
            tryOnWall(first(v), null, null);
          }}
          onChangeEnd={(v) => {
            letGo(scene.kind === "pinned" ? pinnedBrightness.value : first(v));
            void save({ maxBrightness: first(v) }).finally(brightness.clear);
          }}
          classNames={SLIDER_CLASSES}
        />
      </div>
    ),
    pinnedBrightness: (
      <div className="p-4">
        <Slider
          size="sm"
          label="Pinned brightness"
          aria-label="Pinned brightness"
          minValue={SETTING_RANGES.pinnedBrightness.min}
          maxValue={SETTING_RANGES.pinnedBrightness.max}
          step={1}
          value={pinnedBrightness.value}
          getValue={(v) => `${first(v as number | number[])}%`}
          formatOptions={PERCENT}
          onChange={(v) => {
            pinnedBrightness.set(first(v));
            tryOnWall(first(v), pinned?.id ?? null, pinnedRgb);
          }}
          onChangeEnd={(v) => {
            letGo(scene.kind === "pinned" ? first(v) : brightness.value);
            void save({ pinnedBrightness: first(v) }).finally(pinnedBrightness.clear);
          }}
          classNames={SLIDER_CLASSES}
        />
      </div>
    ),
    pinned: (
      <div className="space-y-3.5 p-4">
        <Situation title="When an activity is pinned" lede="Nothing live, but a pin: a quieter light." />
        <Segmented
          label="Pinned style"
          value={settings.pinnedStyle}
          onChange={(pinnedStyle) => void save({ pinnedStyle })}
          options={[
            { value: "glow", label: "Glow", hint: "A steady, softer light", preview: preview("glow") },
            { value: "pulse", label: "Pulse", hint: "A slow wave across the panels", preview: preview("pulse") },
          ]}
        />
        <PreviewRow scene={pin()}>
          <SwitchRow
            label="Show goal progress"
            description="Fill the panels as for a live session, not just the colour."
            value={settings.pinnedProgress}
            onChange={(pinnedProgress) => void save({ pinnedProgress })}
          />
        </PreviewRow>
      </div>
    ),
    track: (
      <div className="space-y-3.5 p-4">
        <Situation title="While a session is live" lede="A goal fills the wall as the session runs." />
        <PreviewRow scene={liveScene(color, settings.track)}>
          <SwitchRow
            label="Faint track"
            description="Unfilled panels glow faintly, so the whole goal stays in view."
            value={settings.track}
            onChange={(track) => void save({ track })}
          />
        </PreviewRow>
      </div>
    ),
    schedule: (
      <div className="space-y-3.5 p-4">
        <Situation title="When a schedule fires" lede="A reminder that it's time." />
        <PreviewRow scene={liveScene(color, settings.track)} alert={settings.scheduleAlert ? color : null}>
          <SwitchRow
            label="Pulse the wall"
            description="The whole wall swells twice in the activity's colour, over whatever it shows."
            value={settings.scheduleAlert}
            onChange={(scheduleAlert) => void save({ scheduleAlert })}
          />
        </PreviewRow>
      </div>
    ),
    plugins: (
      <div className="space-y-3.5 p-4">
        <Situation title="Other plugins" lede="Magic Cube, Home Assistant and the like." />
        <PreviewRow scene={settings.allowControl ? pluginScene() : pin()}>
          <SwitchRow
            label="Let other plugins control the wall"
            description="A plugin can show its own effect for a while. A schedule still pulses over it."
            value={settings.allowControl}
            onChange={(allowControl) => void save({ allowControl })}
          />
        </PreviewRow>
      </div>
    ),
    idle: (
      <div className="space-y-2.5 p-4">
        <Eyebrow>When nothing is going on</Eyebrow>
        <Segmented<IdleBehaviour>
          label="When nothing is live or pinned"
          value={settings.idle}
          onChange={(idle) => void save({ idle })}
          options={[
            { value: "off", label: "Turn off" },
            { value: "restore", label: "Restore my scene" },
          ]}
        />
      </div>
    ),
  };
}

/** Some groups as one card, under an eyebrow that also says when a save was refused (the phone's tabs). */
export function SettingsCard({ title, groups: ids }: { title: string; groups: readonly SettingsGroup[] }) {
  const groups = useSettingsGroups();
  return (
    <section aria-label={title} className="rounded-2xl bg-content1 ring-1 ring-default-100">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
        <Eyebrow>{title}</Eyebrow>
        <span role="status" className="min-w-0 truncate text-danger text-xs">
          {groups.saveError}
        </span>
      </div>
      <div className="divide-y divide-default-100">
        {ids.map((id) => (
          <div key={id}>{groups[id]}</div>
        ))}
      </div>
    </section>
  );
}

/**
 * Some groups as a card each (the phone's Settings tab: one per situation, each under its own title), with a refused
 * save said above them.
 */
export function SettingsCards({ groups: ids }: { groups: readonly SettingsGroup[] }) {
  const groups = useSettingsGroups();
  return (
    <div className="space-y-3">
      {groups.saveError && (
        <p role="status" className="px-1 text-danger text-xs">
          {groups.saveError}
        </p>
      )}
      {ids.map((id) => (
        <section key={id} className="rounded-2xl bg-content1 ring-1 ring-default-100">
          {groups[id]}
        </section>
      ))}
    </div>
  );
}

/** The settings as one card, beside the setup flow: every group but what the wall does when idle (the controller card has it). */
export function SettingsPanel() {
  const groups = useSettingsGroups();
  return (
    <section aria-label="Settings" className="rounded-2xl bg-content1 ring-1 ring-default-100">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
        <Eyebrow>Settings</Eyebrow>
        <span role="status" className="min-w-0 truncate text-danger text-xs">
          {groups.saveError}
        </span>
      </div>
      <div className="divide-y divide-default-100">
        {groups.brightness}
        {groups.pinnedBrightness}
        {groups.pinned}
        {groups.track}
        {groups.schedule}
        {groups.plugins}
      </div>
    </section>
  );
}
