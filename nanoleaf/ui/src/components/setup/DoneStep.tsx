import { Button } from "@heroui/react";
import { ArrowRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef } from "react";
import { fitView, placeLayout } from "../../../../shared/geometry.ts";
import { resolveOrder } from "../../../../shared/order.ts";
import type { Point } from "../../../../shared/types.ts";
import { useScene } from "../../hooks/useScene.ts";
import { holderName } from "../../lib/control.ts";
import { useModel } from "../../model.ts";
import { EASE_OUT, SPRING_POP } from "../../motion.ts";
import { tint } from "../tint.ts";
import type { PairResult } from "./PairStep.tsx";

const W = 320;
const H = 200;
/** Per-panel stagger, capped so a big wall doesn't keep the user waiting. */
const STAGGER = 0.05;
const STAGGER_CAP = 0.9;
/** How long the moment holds after the last panel lands, before the wall takes over. */
const LINGER_MS = 1600;

/** Corners pulled toward the centre, so neighbouring panels show a seam. */
function inset(corners: readonly Point[], center: Point, k: number): Point[] {
  return corners.map(([x, y]) => [center[0] + (x - center[0]) * k, center[1] + (y - center[1]) * k]);
}

/** The new wall, drawn from its layout: panels pop in along the fill order, in the colour that's about to show. */
function Arrival({ color }: { color: string }) {
  const model = useModel();
  const reduced = useReducedMotion();
  const drawn = useMemo(() => {
    if (!model.layout) return null;
    const placed = placeLayout(model.layout, model.settings.viewRotation);
    if (!placed.panels.length) return null;
    const order = resolveOrder(model.order, placed.panels);
    const view = fitView(placed.bounds, W, H, 16);
    const toSvg = ([x, y]: Point) =>
      `${(x * view.scale + view.tx).toFixed(1)},${(-y * view.scale + view.ty).toFixed(1)}`;
    const byId = new Map(placed.panels.map((p) => [p.id, p]));
    return order.flatMap((id, i) => {
      const panel = byId.get(id);
      if (!panel) return [];
      const [cx, cy] = [panel.center[0] * view.scale + view.tx, -panel.center[1] * view.scale + view.ty];
      return [{ id, i, points: inset(panel.corners, panel.center, 0.9).map(toSvg).join(" "), cx, cy }];
    });
  }, [model.layout, model.order, model.settings.viewRotation]);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full overflow-visible" aria-hidden>
      <defs>
        <filter id="nl-done-bloom" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
      </defs>
      {/* The burst: two rings leave the centre once. */}
      {!reduced &&
        [0, 0.14].map((delay) => (
          <motion.circle
            key={delay}
            cx={W / 2}
            cy={H / 2}
            r={60}
            fill="none"
            stroke={tint(color, 0.7)}
            strokeWidth={1.5}
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
            initial={{ opacity: 0.8, transform: "scale(0.3)" }}
            animate={{ opacity: 0, transform: "scale(1.9)" }}
            transition={{ duration: 0.9, ease: EASE_OUT, delay }}
          />
        ))}
      {drawn && (
        <g filter="url(#nl-done-bloom)" opacity={0.55}>
          {drawn.map((p) => (
            <motion.polygon
              key={p.id}
              points={p.points}
              fill={tint(color, 1)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{
                duration: 0.4,
                ease: EASE_OUT,
                delay: reduced ? 0 : Math.min(p.i * STAGGER, STAGGER_CAP) + 0.1,
              }}
            />
          ))}
        </g>
      )}
      {drawn?.map((p) => (
        <motion.polygon
          key={p.id}
          points={p.points}
          fill={tint(color, 0.85)}
          stroke={tint(color, 1)}
          strokeWidth={1}
          strokeLinejoin="round"
          style={{ transformBox: "fill-box", transformOrigin: "center" }}
          initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "scale(0.6)" }}
          animate={{ opacity: 1, transform: "scale(1)" }}
          transition={reduced ? { duration: 0.2 } : { ...SPRING_POP, delay: Math.min(p.i * STAGGER, STAGGER_CAP) }}
        />
      ))}
    </svg>
  );
}

interface DoneStepProps {
  readonly result: PairResult;
  onFinish(): void;
}

/** Step 3: paired. The wall arrives panel by panel, then hands over to the real one (or at once on request). */
export function DoneStep({ result, onFinish }: DoneStepProps) {
  const model = useModel();
  const scene = useScene();
  const reduced = useReducedMotion();
  const activity = model.activities.find((a) => a.id === scene.activityId);
  const color = scene.cssColor ?? "#fde7c7";
  const finish = useRef(onFinish);
  finish.current = onFinish;

  useEffect(() => {
    const settle = reduced ? 0 : Math.min(result.panels * STAGGER, STAGGER_CAP) * 1000 + 500;
    const t = window.setTimeout(() => finish.current(), settle + LINGER_MS + 1200);
    return () => window.clearTimeout(t);
  }, [reduced, result.panels]);

  const lead = activity
    ? `${activity.name} is ${scene.kind === "live" ? "live" : "pinned"}, so the wall takes its colour now.`
    : scene.kind === "control"
      ? `${holderName(scene.holder)} is controlling the wall right now.`
      : "It glows in your activity's colour when you start a session.";

  return (
    <div className="grid items-center gap-5 @lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="h-44 rounded-2xl bg-background/50 p-3 ring-1 ring-divider sm:h-52">
        <Arrival color={color} />
      </div>
      <motion.div
        initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px)" }}
        animate={{ opacity: 1, transform: "translateY(0px)" }}
        transition={{ duration: 0.25, ease: EASE_OUT, delay: reduced ? 0 : 0.25 }}
      >
        <h3 className="font-semibold text-lg leading-tight">Paired with {result.name ?? "your controller"}</h3>
        <p className="mt-1.5 text-default-500 text-sm leading-snug">
          {result.panels === 1 ? "One panel" : `${result.panels} panels`} ready. {lead}
        </p>
        <Button
          color="primary"
          radius="lg"
          className="mt-4 font-medium active:scale-[0.97]"
          endContent={<ArrowRight className="h-4 w-4" />}
          onPress={onFinish}
        >
          Show my wall
        </Button>
      </motion.div>
    </div>
  );
}
