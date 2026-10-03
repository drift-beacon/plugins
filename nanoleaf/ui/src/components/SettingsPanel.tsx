import { Slider } from "@heroui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { parseColor, toLedRgb, WARM_WHITE } from "../../../shared/color.ts";
import type { IdleBehaviour, PinnedStyle, Scene } from "../../../shared/types.ts";
import { useScene } from "../hooks/useScene.ts";
import { useWallPreview } from "../hooks/useWallPreview.ts";
import { useModel } from "../model.ts";
import { PanelBar } from "./PanelBar.tsx";
import { PinnedPreview } from "./PinnedPreview.tsx";
import { Segmented } from "./Segmented.tsx";
import { brightnessFeedback } from "./status.ts";
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

/** A slider's local value while it's dragged, falling back to the saved one; saved on release. */
function useDraft(saved: number) {
  const [draft, setDraft] = useState<number | null>(null);
  return { value: draft ?? saved, set: setDraft, clear: () => setDraft(null) };
}

const first = (v: number | number[]) => (Array.isArray(v) ? v[0] : v);

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="font-semibold text-[10px] text-default-400 uppercase tracking-wider">{children}</div>;
}

const BRIGHTNESS_HINT = {
  adjust: "The wall shows it as you drag.",
  preview: "The wall lights up to show it as you drag, then goes back.",
  none: "The wall uses it whenever the plugin drives it.",
} as const;

/** The Faint track demo: a goal part-way at full level and holding still, so the switch's effect is plain to see. */
function trackDemo(color: string, track: boolean): Scene {
  return {
    kind: "pinned",
    key: "demo",
    activityId: null,
    cssColor: color,
    rgb: toLedRgb(parseColor(color) ?? WARM_WHITE),
    progress: { goal: { type: "count", count: 6 }, period: null, current: 2.52, target: 6, fraction: 0.42 },
    level: 1,
    style: "glow",
    track,
  };
}

/** How long a failed save stays on screen. */
const SAVE_ERROR_MS = 6000;

const SLIDER_CLASSES = {
  label: "text-sm font-medium",
  value: "text-sm tabular-nums text-default-500",
};

/** Screen readers hear "80%", not "80" (the values are whole percents, not fractions). */
const PERCENT: Intl.NumberFormatOptions = { style: "unit", unit: "percent" };

export type SettingsGroup = "brightness" | "pinned" | "track" | "schedule" | "idle" | "plugins";

/**
 * Everything the user tunes, as groups a layout places: Max brightness, then one group per situation the wall can
 * be in (an activity pinned, a session live, a schedule firing, nothing going on, another plugin asking for it).
 * Both sliders show on the wall while they move: Max brightness through `brightness` requests (at most every
 * 120 ms), lighting a short preview when nothing is on the wall; Pinned brightness by saving as it moves (at most
 * every 300 ms), which main applies to a pin at once. Everything else saves at once. A save the app refuses rolls
 * back and says so in `saveError`.
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
  const pinnedLevel = useDraft(settings.pinnedLevel);
  const feedback = brightnessFeedback(model, scene);
  const tryBrightness = useThrottle((value: number) => void actions.brightness(value).catch(() => {}), 120);
  const savePinnedLevel = useThrottle((value: number) => void save({ pinnedLevel: value }), 300);

  // Previews use the pinned activity's colour when there is one, else whatever is showing.
  const pinned = model.activities.find((a) => !a.archived && a.pinnedBy?.includes(model.userId));
  const color = pinned?.color ?? scene.cssColor ?? "#a78bfa";

  const preview = (style: PinnedStyle) => (
    <PinnedPreview
      style={style}
      level={pinnedLevel.value / 100}
      color={color}
      progress={settings.pinnedProgress}
      track={settings.track}
    />
  );

  return {
    saveError,
    brightness: (
      <div className="p-4">
        <Slider
          size="sm"
          label="Max brightness"
          aria-label="Max brightness"
          minValue={5}
          maxValue={100}
          step={1}
          value={brightness.value}
          getValue={(v) => `${first(v as number | number[])}%`}
          formatOptions={PERCENT}
          onChange={(v) => {
            brightness.set(first(v));
            tryBrightness(first(v));
            // Nothing on the wall to adjust: light it (at this brightness, main's override) while the thumb moves.
            if (feedback === "preview") wall.showWall({ mode: "fill", fraction: 1 });
          }}
          onChangeEnd={(v) => {
            wall.showWall(null);
            void save({ maxBrightness: first(v) }).finally(brightness.clear);
          }}
          classNames={SLIDER_CLASSES}
        />
        <p className="mt-2 text-default-500 text-xs leading-snug">{BRIGHTNESS_HINT[feedback]}</p>
      </div>
    ),
    pinned: (
      <div className="space-y-3.5 p-4">
        <div>
          <Eyebrow>When an activity is pinned</Eyebrow>
          <p className="mt-1 text-default-500 text-xs leading-snug">Nothing live, but a pin: a quieter light.</p>
        </div>
        <Segmented
          label="Pinned style"
          value={settings.pinnedStyle}
          onChange={(pinnedStyle) => void save({ pinnedStyle })}
          options={[
            { value: "glow", label: "Glow", hint: "A steady, softer light", preview: preview("glow") },
            { value: "pulse", label: "Pulse", hint: "A slow wave across the panels", preview: preview("pulse") },
          ]}
        />
        <Slider
          size="sm"
          label="Pinned brightness"
          aria-label="Pinned brightness, as a share of Max brightness"
          minValue={10}
          maxValue={80}
          step={1}
          value={pinnedLevel.value}
          getValue={(v) => `${first(v as number | number[])}% of max`}
          formatOptions={PERCENT}
          onChange={(v) => {
            pinnedLevel.set(first(v));
            savePinnedLevel(first(v));
          }}
          onChangeEnd={(v) => {
            void save({ pinnedLevel: first(v) }).finally(pinnedLevel.clear);
          }}
          classNames={SLIDER_CLASSES}
        />
        <SwitchRow
          label="Show goal progress"
          description="Fill the panels as for a live session, not just the colour."
          value={settings.pinnedProgress}
          onChange={(pinnedProgress) => void save({ pinnedProgress })}
        />
      </div>
    ),
    track: (
      <div className="space-y-3 p-4">
        <Eyebrow>While a session is live</Eyebrow>
        <SwitchRow
          label="Faint track"
          description="Unfilled panels glow faintly, so the whole goal stays in view."
          value={settings.track}
          onChange={(track) => void save({ track })}
        />
        <PanelBar scene={trackDemo(color, settings.track)} n={6} className="h-1" />
      </div>
    ),
    schedule: (
      <div className="space-y-3 p-4">
        <Eyebrow>When a schedule fires</Eyebrow>
        <SwitchRow
          label="Pulse the wall"
          description="The whole wall swells twice in the activity's colour, over whatever it shows."
          value={settings.scheduleAlert}
          onChange={(scheduleAlert) => void save({ scheduleAlert })}
        />
      </div>
    ),
    plugins: (
      <div className="space-y-3 p-4">
        <Eyebrow>Other plugins</Eyebrow>
        <SwitchRow
          label="Let other plugins control the wall"
          description="A plugin such as Magic Cube, or Home Assistant, can show its own effect for a while. A schedule still pulses over it."
          value={settings.allowControl}
          onChange={(allowControl) => void save({ allowControl })}
        />
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
            { value: "restore", label: "Restore my scene" },
            { value: "off", label: "Turn off" },
          ]}
        />
      </div>
    ),
  };
}

/** The settings as one card: every group in a list, for the phone layout and beside the setup flow. */
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
        {groups.pinned}
        {groups.track}
        {groups.schedule}
        {groups.plugins}
        {groups.idle}
      </div>
    </section>
  );
}
