import { cn } from "@heroui/theme";
import { useAnimate, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { GESTURES, resolveGesture } from "../../../../shared/gestures.ts";
import type { GestureAction, TouchGesture } from "../../../../shared/types.ts";
import { useDrafting } from "../../hooks/useDrawnLight.ts";
import { type NanoleafModel, useModel } from "../../model.ts";
import { EASE_OUT } from "../../motion.ts";
import { SwitchRow } from "../SwitchRow.tsx";
import { ActionPicker } from "./ActionPicker.tsx";
import { GestureGlyph } from "./GestureGlyph.tsx";

/** How long a refused save stays on screen, as in SettingsPanel. */
const SAVE_ERROR_MS = 6000;

const LABEL: Record<TouchGesture, string> = {
  tap: "Tap",
  "double-tap": "Double tap",
  "swipe-up": "Swipe up",
  "swipe-down": "Swipe down",
  "swipe-left": "Swipe left",
  "swipe-right": "Swipe right",
};

/** Where a swipe's glyph leaves to, px: it slides out the way the finger went and comes back from the other side. */
const SWIPE: Partial<Record<TouchGesture, readonly [number, number]>> = {
  "swipe-up": [0, -12],
  "swipe-down": [0, 12],
  "swipe-left": [-12, 0],
  "swipe-right": [12, 0],
};

/**
 * A gesture's tile, which answers when the wall reports that gesture: a tap presses it, a double tap presses it twice,
 * a swipe slides its glyph through the way the finger went. A glow under it says what the gesture did, judged as main
 * judges it (shared/gestures.ts): the colour of the activity it acted on, or a neutral flash when it did nothing. With
 * reduced motion only the glow plays. Quiet while gestures are off, and while tap to order takes the taps.
 */
function GestureTile({ gesture, model }: { gesture: TouchGesture; model: NanoleafModel }) {
  const { onTouch } = model;
  const reduced = useReducedMotion();
  const drafting = useDrafting();
  const [scope, animate] = useAnimate<HTMLSpanElement>();
  // Read when the gesture arrives, not when the listener was attached.
  const latest = useRef({ model, drafting });
  latest.current = { model, drafting };

  useEffect(
    () =>
      onTouch((_panel, heard) => {
        const { model: m, drafting: busy } = latest.current;
        if (heard !== gesture || busy || !m.settings.gestures) return;
        const glow = scope.current?.querySelector<HTMLElement>("[data-glow]");
        const glyph = scope.current?.querySelector<HTMLElement>("[data-glyph]");
        if (!scope.current || !glow || !glyph) return;
        const step = resolveGesture(m.settings.gestureActions[gesture], m.userId, m.activities, m.sessions);
        const activity = step ? m.activities.find((a) => a.id === step.activityId) : undefined;
        glow.style.background = step
          ? (activity?.color ?? "hsl(var(--heroui-primary))")
          : "hsl(var(--heroui-default-400) / 0.35)";
        animate(glow, { opacity: [0, 0.45, 0] }, { duration: 0.6, ease: EASE_OUT });
        if (reduced) return;
        const away = SWIPE[gesture];
        if (away) {
          const [x, y] = away;
          animate(
            glyph,
            { x: [0, x, -x, 0], y: [0, y, -y, 0], opacity: [1, 0, 0, 1] },
            { duration: 0.34, times: [0, 0.4, 0.41, 1], ease: EASE_OUT },
          );
        } else {
          const twice = gesture === "double-tap";
          animate(
            scope.current,
            { scale: twice ? [1, 0.86, 1, 0.86, 1] : [1, 0.86, 1] },
            { duration: twice ? 0.42 : 0.24, ease: EASE_OUT },
          );
        }
      }),
    [onTouch, gesture, reduced, animate, scope],
  );

  return (
    <span
      ref={scope}
      className="relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl bg-default-100 text-default-600"
    >
      <span data-glow aria-hidden className="absolute inset-0 opacity-0" />
      <span data-glyph className="relative">
        <GestureGlyph gesture={gesture} />
      </span>
    </span>
  );
}

/**
 * Controls: what gestures on the wall do. A switch, then one line per gesture: its tile (which answers when the wall
 * reports it), its name, and what it does. Each change saves at once. On the board it sits under What the wall does;
 * on a phone it is a tab of its own.
 */
export function ControlsCard() {
  const model = useModel();
  const { settings, activities, connection, actions } = model;
  // A save the app refuses rolls back (the SDK does) and says so for a few seconds, as the other settings do.
  const [saveError, setSaveError] = useState<string | null>(null);
  const errorTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(errorTimer.current), []);
  const save = (patch: { gestures?: boolean; gestureActions?: Record<string, GestureAction> }) =>
    void actions.saveSettings(patch).then(
      () => setSaveError(null),
      (e: unknown) => {
        setSaveError(`Couldn't save that: ${e instanceof Error ? e.message : String(e)}`);
        window.clearTimeout(errorTimer.current);
        errorTimer.current = window.setTimeout(() => setSaveError(null), SAVE_ERROR_MS);
      },
    );
  const silent = connection?.status === "connected" && !connection.events;
  return (
    <section aria-label="Controls" className="rounded-2xl bg-content1 ring-1 ring-default-100">
      <div className="space-y-2 p-4">
        <SwitchRow
          label="Gestures on your wall"
          description="Touch or swipe the panels to control what's going on, without your phone."
          value={settings.gestures}
          onChange={(gestures) => save({ gestures })}
        />
        {silent && settings.gestures && (
          <p className="text-warning text-xs">Your wall isn't reporting touches right now.</p>
        )}
        <p role="status" className="text-danger text-xs empty:hidden">
          {saveError}
        </p>
      </div>
      <div
        inert={!settings.gestures}
        className={cn(
          "divide-y divide-default-100 border-default-100 border-t transition-opacity duration-200 ease-out",
          !settings.gestures && "opacity-40",
        )}
      >
        {GESTURES.map((gesture) => (
          <div key={gesture} className="flex items-center gap-3 px-4 py-2.5">
            <GestureTile gesture={gesture} model={model} />
            <span className="min-w-0 flex-1 font-medium text-sm">{LABEL[gesture]}</span>
            <div className="w-[52%] max-w-[240px] shrink-0">
              <ActionPicker
                label={LABEL[gesture]}
                value={settings.gestureActions[gesture]}
                activities={activities}
                onChange={(action) => {
                  const next: Record<string, GestureAction> = { ...settings.gestureActions };
                  if (action) next[gesture] = action;
                  else delete next[gesture];
                  save({ gestureActions: next });
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
