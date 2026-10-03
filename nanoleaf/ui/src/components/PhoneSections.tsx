import { cn } from "@heroui/theme";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useRef, useState } from "react";
import { useScene } from "../hooks/useScene.ts";
import { holderName } from "../lib/control.ts";
import { AUTO_ORDERS } from "../lib/panels.ts";
import { useModel } from "../model.ts";
import { EASE_OUT } from "../motion.ts";
import { FillCard } from "./Board.tsx";
import { ControllerCard } from "./ControllerCard.tsx";
import { NowCard } from "./NowCard.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import type { WallParts } from "./wall/WallSection.tsx";

type SectionId = "now" | "order" | "settings" | "controller";

const TITLES: readonly (readonly [SectionId, string])[] = [
  ["now", "Now on your wall"],
  ["order", "Fill order"],
  ["settings", "What the wall does"],
  ["controller", "Controller"],
];

/** A row's own close finishes before the opened one is brought up under the wall. */
const SETTLE_MS = 240;

/**
 * The phone layout under the wall: the stage is pinned to the top of the view, and everything else is one list of
 * sections. Each row says its current state and opens in place, one at a time, so the whole plugin reads at a glance
 * and whatever is being changed sits right under the drawing that shows it.
 */
export function PhoneSections({ parts }: { parts: WallParts }) {
  const model = useModel();
  const scene = useScene();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState<SectionId | null>("now");
  const pinned = useRef<HTMLDivElement>(null);
  const rows = useRef<Partial<Record<SectionId, HTMLDivElement | null>>>({});

  const activity = scene.activityId ? model.activities.find((a) => a.id === scene.activityId) : undefined;
  const fraction = scene.progress?.fraction ?? null;
  const status = model.connection?.status;
  const summary: Record<SectionId, string> = {
    now:
      scene.kind === "control"
        ? `${holderName(scene.holder)} controls your wall`
        : activity
          ? `${activity.name}${fraction === null ? "" : ` · ${Math.round(fraction * 100)}%`}`
          : "Nothing live or pinned",
    order:
      model.order.mode === "random"
        ? "Shuffle"
        : model.order.mode === "custom"
          ? "My own"
          : (AUTO_ORDERS.find((a) => a.id === model.order.auto)?.label ?? "Path"),
    settings: `Max brightness ${model.settings.maxBrightness}%`,
    controller: `${model.connection?.name ?? model.controller?.name ?? "Controller"} · ${
      !model.settings.enabled ? "not driven" : status === "connected" ? "connected" : (status ?? "connecting")
    }`,
  };
  const body: Record<SectionId, ReactNode> = {
    now: <NowCard />,
    order: <FillCard parts={parts} />,
    settings: <SettingsPanel />,
    controller: <ControllerCard />,
  };

  const toggle = (id: SectionId) => {
    const next = open === id ? null : id;
    setOpen(next);
    if (!next) return;
    window.setTimeout(
      () => {
        const row = rows.current[next];
        if (!row) return;
        row.style.scrollMarginTop = `${(pinned.current?.offsetHeight ?? 0) + 4}px`;
        row.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
      },
      reduced ? 0 : SETTLE_MS,
    );
  };

  return (
    <>
      {/* Pinned: every section's controls show on the drawing, so it stays in view above them. */}
      <div ref={pinned} className="-mx-3 -mt-3 sticky top-0 z-10 bg-background px-3 pt-3 pb-2">
        {parts.stage}
      </div>
      <div className="isolate divide-y divide-default-100">
        {TITLES.map(([id, title]) => (
          <div
            key={id}
            ref={(el) => {
              rows.current[id] = el;
            }}
          >
            <button
              type="button"
              aria-expanded={open === id}
              onClick={() => toggle(id)}
              className="flex min-h-14 w-full items-center gap-3 px-1 py-2 text-left transition-transform duration-150 ease-out active:scale-[0.99]"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-sm">{title}</span>
                <span className="block truncate text-default-500 text-xs">{summary[id]}</span>
              </span>
              <ChevronDown
                className={cn(
                  "h-4 w-4 shrink-0 text-default-400 transition-transform duration-200 ease-out",
                  open === id && "rotate-180",
                )}
              />
            </button>
            <AnimatePresence initial={false}>
              {open === id && (
                <motion.div
                  key="body"
                  className="overflow-hidden"
                  initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  transition={{ duration: 0.22, ease: EASE_OUT }}
                >
                  {/* Padded: the cards' rings draw outside their boxes. */}
                  <div className="px-px pt-px pb-4">{body[id]}</div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </>
  );
}
