import { Autocomplete, AutocompleteItem, AutocompleteSection } from "@heroui/react";
import { cn } from "@heroui/theme";
import { Check, Copy } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { relative, timeOfDay as clockTime } from "../../view/format.ts";
import { ACTIVITIES, CATEGORIES, type FxActivity, PLUGIN_PATH } from "./fixtures";

export { Icon };

export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;

/** Re-renders every `ms` while `enabled`; timers never animate, they just tick. */
export function useNow(ms = 1000, enabled = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
  return now;
}

export const pad = (n: number) => String(n).padStart(2, "0");

/** 00:23:14 */
export function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** 45m · 3h 12m · 52h */
export function hours(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  return h >= 10 ? `${h}h` : `${h}h ${pad(minutes % 60)}m`;
}

export const ago = (t: number | null) => (t == null ? "Never" : relative(t, Date.now()));
export const timeOfDay = (t: number) => clockTime(t);
export const shortTag = (tag: string) => tag.split(":").slice(0, 4).join(":");

interface ActivityPickerProps {
  value?: string | null;
  onChange: (activityId: string | null) => void;
  placeholder?: string;
  label?: string;
  size?: "sm" | "md" | "lg";
  variant?: "flat" | "bordered" | "faded" | "underlined";
  autoFocus?: boolean;
  /** Open the list on focus (a relabel field) or only once typing starts (an autofocused prompt). */
  openOnFocus?: boolean;
  className?: string;
  "aria-label"?: string;
}

/** Search every activity, grouped by category, like the plugin's ActivitySelect. */
export function ActivityPicker({
  value = null,
  onChange,
  placeholder = "Search activities",
  label,
  size = "md",
  variant = "flat",
  autoFocus,
  openOnFocus = false,
  className,
  "aria-label": ariaLabel,
}: ActivityPickerProps) {
  const selected = ACTIVITIES.find((a) => a.id === value);
  return (
    <Autocomplete
      aria-label={ariaLabel ?? label ?? placeholder}
      label={label}
      placeholder={placeholder}
      size={size}
      variant={variant}
      autoFocus={autoFocus}
      menuTrigger={openOnFocus ? "focus" : "input"}
      className={className}
      selectedKey={value}
      onSelectionChange={(key) => onChange(key == null ? null : String(key))}
      startContent={selected ? <Icon path={selected.iconPath} color={selected.color} className="h-4 w-4 shrink-0" /> : undefined}
      scrollShadowProps={{ isEnabled: false }}
      popoverProps={{ classNames: { base: "rounded-large min-w-64", content: "p-1 border-small border-default-100 bg-background" } }}
    >
      {CATEGORIES.map((c) => (
        <AutocompleteSection key={c.id} title={c.name}>
          {ACTIVITIES.filter((a) => a.categoryId === c.id).map((a) => (
            <AutocompleteItem
              key={a.id}
              textValue={a.name}
              startContent={<Icon path={a.iconPath} color={a.color} className="h-4 w-4 shrink-0" />}
            >
              {a.name}
            </AutocompleteItem>
          ))}
        </AutocompleteSection>
      ))}
    </Autocomplete>
  );
}

/** One-tap suggestions: activities that don't have a cartridge yet. */
export function SuggestionChips({
  activities,
  onPick,
  className,
  tone = "default",
}: {
  activities: FxActivity[];
  onPick: (id: string) => void;
  className?: string;
  tone?: "default" | "vfd";
}) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {activities.slice(0, 6).map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onPick(a.id)}
          className={cn(
            "cp-press flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors duration-150",
            tone === "vfd"
              ? "border border-[#6ef5c8]/25 font-mono uppercase tracking-wider text-[#6ef5c8]/80 hover:bg-[#6ef5c8]/10"
              : "bg-default-100 text-default-600 hover:bg-default-200 hover:text-foreground",
          )}
        >
          <Icon path={a.iconPath} color={tone === "vfd" ? undefined : a.color} className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{a.name}</span>
        </button>
      ))}
    </div>
  );
}

/** Copy with a check that confirms it; the icons crossfade because the swap is feedback, not decoration. */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy"}
      className={cn("cp-press grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-default-100", className)}
      onClick={() => {
        void navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
      }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={copied ? "check" : "copy"}
          initial={{ opacity: 0, transform: "scale(0.8)" }}
          animate={{ opacity: 1, transform: "scale(1)" }}
          exit={{ opacity: 0, transform: "scale(0.8)" }}
          transition={{ duration: 0.15, ease: EASE_OUT }}
          className="grid place-items-center"
        >
          {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

/**
 * What the player's setup page asks for, in the order it asks. The explorations predate the setup code, so they still
 * hand over a path; the facts are the firmware's (its "Enter details instead" takes the plugin path).
 */
export const SETUP_STEPS = [
  { title: "Join the player's network", body: "Wi-Fi “Cartridge-XXXX”, no password. The setup page opens by itself, or go to http://10.123.45.1/." },
  { title: "Point it at your hub", body: "Choose Enter details instead: hub hostname or IP, HTTP port 9001 for the Home Assistant add-on, and a workspace API key." },
  { title: "Paste the plugin path", body: "The player checks the path and key before it saves the hub." },
];

export const pluginPath = PLUGIN_PATH;

/** The setup steps and the plugin path to copy; each variant frames it its own way. */
export function SetupGuide({ className }: { className?: string }) {
  return (
    <div className={cn("w-full space-y-4", className)}>
      <ol className="space-y-3">
        {SETUP_STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-default-100 text-[11px] font-semibold">
              {i + 1}
            </span>
            <div>
              <div className="text-sm">{step.title}</div>
              <div className="text-xs text-default-500">{step.body}</div>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-1 rounded-lg bg-default-100 py-1 pl-3 pr-1">
        <code className="flex-1 truncate text-xs">{pluginPath}</code>
        <CopyButton text={pluginPath} />
      </div>
    </div>
  );
}
