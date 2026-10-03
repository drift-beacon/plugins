import { useMemo, useSyncExternalStore } from "react";
import { getUiContext } from "../drift-beacon";

/** Convert the host's CSS color to sRGB for Three.js, which doesn't understand oklch. */
export function useThemeColor(): string {
  const ctx = getUiContext();
  const theme = useSyncExternalStore(ctx.onThemeChange, () => ctx.theme);
  return useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const paint = canvas.getContext("2d", { willReadFrequently: true });
    if (!paint) return "#18181b";
    paint.fillStyle = theme.colors.surface;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b] = paint.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  }, [theme]);
}
