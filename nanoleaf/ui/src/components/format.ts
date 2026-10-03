import type { Layout } from "../../../shared/types.ts";

/** "Panel 3 of 7 filling": which panel the wall is working on. */
export function panelLine(fraction: number, n: number): string {
  if (n <= 0) return "";
  const f = Math.max(0, fraction);
  if (f >= 1) return n === 1 ? "The panel is full" : `All ${n} panels lit`;
  const k = Math.floor(f * n) + 1;
  return f * n === Math.floor(f * n) ? `Panel ${k} of ${n} is next` : `Panel ${k} of ${n} filling`;
}

/** 0:20:14, or 20:14 under an hour: a live session's running time. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** How many panels the wall can light (Hexagons, Triangles, Mini Triangles). */
export function lightCount(layout: Layout | null): number {
  return layout ? layout.panels.filter((p) => p.shapeType === 7 || p.shapeType === 8 || p.shapeType === 9).length : 0;
}

/** host:port, leaving out the default port. */
export function address(host: string, port: number | null): string {
  return port === null || port === 16021 ? host : `${host}:${port}`;
}
