import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { placeLayout } from "../../../../shared/geometry.ts";
import { fillSpans, resolveOrder } from "../../../../shared/order.ts";
import { useDrawnLight } from "../../hooks/useDrawnLight.ts";
import { useRenderState } from "../../hooks/useRenderState.ts";
import { useScene } from "../../hooks/useScene.ts";
import { accentRgb } from "../../lib/color.ts";
import { useModel } from "../../model.ts";
import { onWall } from "../status.ts";
import { StageCanvas } from "./StageCanvas.tsx";
import { layoutStage } from "./stageLayout.ts";

const NOOP = () => {};

/**
 * The wall drawn small, filling its box and lit by the same render state as the full drawing: what shows now (greyed
 * while the wall isn't showing it) at the wall's brightness, without numbers, previews (but a brightness slider's)
 * or taps. For a glance (the phone's Wall tab); the full
 * drawing is the stage's.
 */
export function LitWall({ pad = 10, floor = true }: { pad?: number; floor?: boolean }) {
  const model = useModel();
  const scene = useScene();
  const { layout, settings, order } = model;
  const box = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const placed = useMemo(() => (layout ? placeLayout(layout, settings.viewRotation) : null), [layout, settings.viewRotation]);
  const resolved = useMemo(() => (placed ? resolveOrder(order, placed.panels) : []), [order, placed]);
  const spans = useMemo(() => (placed ? fillSpans(order, placed.panels, resolved) : null), [order, placed, resolved]);
  const stage = useMemo(
    () => (placed && size.w > 0 && size.h > 0 ? layoutStage(placed, size.w, size.h, pad) : null),
    [placed, size.w, size.h, pad],
  );
  const drawn = useDrawnLight(null);
  const stateRef = useRenderState(scene, drawn.preview);
  const accent = useMemo(() => accentRgb(scene.cssColor), [scene.cssColor]);

  return (
    <span ref={box} className="pointer-events-none absolute inset-0 block" aria-hidden>
      {stage && (
        <StageCanvas
          stage={stage}
          stateRef={stateRef}
          order={resolved}
          spans={spans}
          drafting={false}
          // Greyed, as the full drawing is, while the wall isn't showing it.
          muted={!onWall(model).showing && drawn.preview === null}
          draft={[]}
          focusId={null}
          targetId={null}
          flash={null}
          accent={accent}
          label=""
          floor={floor}
          level={drawn.level}
          onHover={NOOP}
          onActivate={NOOP}
        />
      )}
    </span>
  );
}
