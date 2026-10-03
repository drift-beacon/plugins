/** A point in stage pixels: x right, y down. */
export type Px = readonly [x: number, y: number];

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/**
 * Moves every corner of a regular polygon toward its centre so each edge moves in by `by`. For a regular polygon that
 * is a uniform scale about the centre by (inradius − by) / inradius: how the seams between panels are drawn.
 */
export function insetPolygon(points: readonly Px[], center: Px, inradius: number, by: number): Px[] {
  const k = inradius > by ? (inradius - by) / inradius : 0;
  return points.map(([x, y]) => [center[0] + (x - center[0]) * k, center[1] + (y - center[1]) * k] as const);
}

/**
 * A closed SVG path through `points` with every corner rounded by `radius` (clamped to half of the shorter edge
 * beside it), like the soft corners of a real diffuser.
 */
export function roundedPath(points: readonly Px[], radius: number): string {
  const n = points.length;
  if (n < 3) return "";
  let d = "";
  for (let i = 0; i < n; i++) {
    const prev = points[(i + n - 1) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];
    const inLen = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    const outLen = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const a: Px = [cur[0] + ((prev[0] - cur[0]) / inLen) * r, cur[1] + ((prev[1] - cur[1]) / inLen) * r];
    const b: Px = [cur[0] + ((next[0] - cur[0]) / outLen) * r, cur[1] + ((next[1] - cur[1]) / outLen) * r];
    d += `${i === 0 ? "M" : "L"}${fmt(a[0])} ${fmt(a[1])}Q${fmt(cur[0])} ${fmt(cur[1])} ${fmt(b[0])} ${fmt(b[1])}`;
  }
  return `${d}Z`;
}

/** A rounded square centred on `center`: the controller marker and unknown-shape ghosts. */
export function squarePath(center: Px, size: number, radius: number): string {
  const h = size / 2;
  const [x, y] = center;
  return roundedPath(
    [
      [x - h, y - h],
      [x + h, y - h],
      [x + h, y + h],
      [x - h, y + h],
    ],
    radius,
  );
}
