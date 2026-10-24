import { cn } from "@heroui/theme";
import { Hexagon, type LucideIcon, Route, SlidersHorizontal } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { EASE_OUT } from "../../motion.ts";

export type TabId = "wall" | "order" | "settings";

export const TABS: readonly TabId[] = ["wall", "order", "settings"];

const TAB: Record<TabId, { readonly label: string; readonly icon: LucideIcon }> = {
  wall: { label: "Wall", icon: Hexagon },
  order: { label: "Order", icon: Route },
  settings: { label: "Settings", icon: SlidersHorizontal },
};

/** The tab bar's height above the safe area, px: what the layout leaves free under its content. */
export const TAB_BAR = 64;

/**
 * The phone's tab bar, pinned to the bottom of the frame: icon over label, the current icon on a pill that slides.
 * With `only`, every other tab is disabled (first run, before there's a wall).
 */
export function TabBar({ value, onChange, only }: { value: TabId; onChange(tab: TabId): void; only: TabId | null }) {
  const reduced = useReducedMotion();
  return (
    <nav
      aria-label="Nanoleaf"
      className="fixed inset-x-0 bottom-0 z-20 border-default-100 border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <div className="grid grid-cols-3" style={{ height: TAB_BAR }}>
        {TABS.map((id) => {
          const { label, icon: Icon } = TAB[id];
          const on = id === value;
          const disabled = only !== null && id !== only;
          return (
            <button
              key={id}
              type="button"
              aria-current={on ? "page" : undefined}
              disabled={disabled}
              title={disabled ? "Pair your Nanoleaf first" : undefined}
              onClick={() => onChange(id)}
              className={cn(
                "flex flex-col items-center justify-center gap-1 text-[11px]",
                "transition-[color,opacity] duration-150 ease-out disabled:opacity-40",
                on ? "text-foreground" : "text-default-500",
              )}
            >
              <span className="relative grid h-8 w-14 place-items-center">
                {on && (
                  <motion.span
                    layoutId="tab-pill"
                    className="absolute inset-0 rounded-full bg-default-200"
                    transition={reduced ? { duration: 0 } : { duration: 0.25, ease: EASE_OUT }}
                  />
                )}
                <Icon className="relative h-5 w-5" strokeWidth={1.75} aria-hidden />
              </span>
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
