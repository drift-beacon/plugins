// Prototype-only: stands in for the app's theme delivery (SDK 0.2.3), so the harness can show the UI in a light app
// as well as a dark one. The palettes are the SDK's own fallbacks; the writes are what its applyTheme does.

export type HostMode = "dark" | "light";

const PALETTES: Record<HostMode, Readonly<Record<string, string>>> = {
  dark: {
    background: "#09090b",
    foreground: "#fafafa",
    surface: "#18181b",
    "surface-foreground": "#fafafa",
    "surface-raised": "#27272a",
    muted: "#a1a1aa",
    border: "#3f3f46",
    accent: "#2563eb",
    "accent-foreground": "#ffffff",
    danger: "#ef4444",
    "danger-foreground": "#ffffff",
    success: "#4ade80",
    "success-foreground": "#052e16",
    warning: "#fbbf24",
    "warning-foreground": "#422006",
    focus: "#3b82f6",
  },
  light: {
    background: "#f8f8f8",
    foreground: "#18181b",
    surface: "#ffffff",
    "surface-foreground": "#18181b",
    "surface-raised": "#f4f4f5",
    muted: "#71717a",
    border: "#d4d4d8",
    accent: "#2563eb",
    "accent-foreground": "#ffffff",
    danger: "#b91c1c",
    "danger-foreground": "#ffffff",
    success: "#15803d",
    "success-foreground": "#ffffff",
    warning: "#a16207",
    "warning-foreground": "#ffffff",
    focus: "#3b82f6",
  },
};

/** The theme the harness shows now: theme.css defaults to dark, as the app's fallback does. */
export function hostMode(): HostMode {
  return document.documentElement.dataset.colorMode === "light" ? "light" : "dark";
}

/** Writes the `--db-*` tokens, colour scheme and mode class the way the SDK does when the app sends a theme. */
export function applyHostTheme(mode: HostMode): void {
  const root = document.documentElement;
  for (const [name, color] of Object.entries(PALETTES[mode])) root.style.setProperty(`--db-${name}`, color);
  root.dataset.colorMode = mode;
  root.style.colorScheme = mode;
  root.classList.toggle("dark", mode === "dark");
  root.classList.toggle("light", mode === "light");
}
