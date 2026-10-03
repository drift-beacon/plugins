import { cn } from "@heroui/theme";

const RING_R = 15;
const RING = 2 * Math.PI * RING_R;

/** Three tiled flat-topped hexagons above the controller: the panels that flash when the pairing window opens. */
const HEX_R = 19;
const HEXES = [-1, 0, 1].map((step) => {
  const cx = 100 + step * HEX_R * 1.5;
  const cy = 36 + Math.abs(step) * HEX_R * (Math.sqrt(3) / 2);
  // Drawn a little small, so the seams between panels show.
  const r = HEX_R - 1.6;
  return Array.from({ length: 6 }, (_, k) => {
    const a = (k * Math.PI) / 3;
    return `${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`;
  }).join(" ");
});

/**
 * A Shapes controller with its power button: while pairing is being waited for, a ring fills round the button over
 * the 6 s hold and the panels above flash, then it rests and shows the hold again. Still when not `waiting`.
 */
export function ControllerArt({ waiting, className }: { waiting: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 200 132" className={cn("w-full max-w-[240px]", className)} aria-hidden>
      {HEXES.map((points, i) => (
        <g key={points}>
          <polygon points={points} fill="#232328" stroke="#2e2e35" strokeWidth={1} strokeLinejoin="round" />
          <polygon
            points={points}
            fill="hsl(var(--heroui-primary))"
            className={waiting ? "nl-flash" : undefined}
            style={{ opacity: waiting ? undefined : 0.06, animationDelay: waiting ? `${i * 40}ms` : undefined }}
          />
        </g>
      ))}
      {/* The controller: a slim module clipped to the panels' edge, four buttons along it. */}
      <rect x={34} y={78} width={132} height={40} rx={12} fill="#1c1c21" stroke="#34343c" strokeWidth={1} />
      {[108, 128, 148].map((cx) => (
        <circle key={cx} cx={cx} cy={98} r={4.5} fill="#2a2a31" stroke="#3a3a42" strokeWidth={0.8} />
      ))}
      <circle cx={68} cy={98} r={10} fill="#26262d" stroke="#44444d" strokeWidth={1} />
      {/* Power glyph. */}
      <path d="M68 92.5v5" stroke="#e4e4e7" strokeWidth={1.8} strokeLinecap="round" />
      <path d="M64.2 94.6a5.2 5.2 0 1 0 7.6 0" fill="none" stroke="#e4e4e7" strokeWidth={1.8} strokeLinecap="round" />
      <circle cx={68} cy={98} r={RING_R} fill="none" stroke="#3a3a42" strokeWidth={2} />
      <circle
        cx={68}
        cy={98}
        r={RING_R}
        fill="none"
        stroke="hsl(var(--heroui-primary))"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={RING}
        transform="rotate(-90 68 98)"
        className={waiting ? "nl-hold" : undefined}
        style={{ ["--nl-ring" as string]: String(RING), strokeDashoffset: waiting ? undefined : RING }}
      />
    </svg>
  );
}
