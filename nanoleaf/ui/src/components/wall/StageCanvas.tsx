import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type KeyboardEvent, memo, useCallback, useId, useMemo, useRef } from "react";
import { cssRgb, WARM_WHITE } from "../../../../shared/color.ts";
import type { Rgb } from "../../../../shared/types.ts";
import { type FrameWriter, useLights } from "../../hooks/useLights.ts";
import type { RenderStateRef } from "../../hooks/useRenderState.ts";
import { floorGlow, panelOpacity } from "../../lib/light.ts";
import { panelName } from "../../lib/panels.ts";
import { EASE_OUT } from "../../motion.ts";
import type { Stage } from "./stageLayout.ts";

/** How much of the light shows while tapping to order (the marks matter then) and while the wall isn't showing it. */
const DRAFT_LIGHT = 0.18;
const MUTED_LIGHT = 0.45;

/** A panel's unlit diffuser, a shade above the stage so the wall reads even when it's dark. */
const DIFFUSER = "var(--db-surface-raised)";
const DIFFUSER_EDGE = "var(--db-border)";

/** A one-off ring on a panel (it was just tapped, touched or picked). Keyed by `n`, so it replays. */
export interface PanelFlash {
  readonly id: number;
  readonly n: number;
}

interface StageCanvasProps {
  readonly stage: Stage;
  readonly stateRef: RenderStateRef;
  /** The resolved fill order the lights follow. */
  readonly order: readonly number[];
  /** Tap to order: panels become buttons, the light dims and the draft shows. */
  readonly drafting: boolean;
  /** The wall isn't showing this (offline, paused, someone else driving…): the light is drawn faded and greyed. */
  readonly muted: boolean;
  /** Panels numbered so far while drafting, in order. */
  readonly draft: readonly number[];
  /** The panel hovered or focused here or in the list. */
  readonly focusId: number | null;
  /** Where a dragged number would land. */
  readonly targetId: number | null;
  readonly flash: PanelFlash | null;
  readonly accent: Rgb;
  /** What the drawing says to a screen reader in view mode. */
  readonly label: string;
  /** Mouse hover (and keyboard focus while drafting); null when it leaves. */
  onHover(id: number | null): void;
  /** Click, tap, Enter or Space on a panel. */
  onActivate(id: number): void;
}

/**
 * The wall, drawn to scale: diffusers, a light layer the rAF loop writes straight into (fill and fill-opacity per
 * panel, no React renders), a blurred copy of it behind for bloom, and light pooling on the floor. Editing marks sit
 * on top: dashed outlines for unnumbered panels, the drawn path, hover and drop highlights.
 */
export function StageCanvas(props: StageCanvasProps) {
  const { stage, stateRef, order, drafting, muted, draft, focusId, targetId, flash, accent, label } = props;
  const reduced = useReducedMotion();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const ids = useMemo(() => ({ bloom: `${uid}-bloom`, floor: `${uid}-floor`, sheen: `${uid}-sheen` }), [uid]);

  const nodes = useRef(new Map<number, LightNodes>());
  const floor = useRef<{ el: SVGEllipseElement | null; fill: string; opacity: number }>({
    el: null,
    fill: "",
    opacity: -1,
  });
  const register = useCallback((id: number, kind: keyof Omit<LightNodes, "fill" | "opacity">, el: Element | null) => {
    let node = nodes.current.get(id);
    if (!node) {
      node = { light: null, bloom: null, sheen: null, fill: "", opacity: -1 };
      nodes.current.set(id, node);
    }
    if (node[kind] === el) return;
    node[kind] = el as SVGPathElement | null;
    node.fill = "";
    node.opacity = -1;
  }, []);
  const registerFloor = useCallback((el: SVGEllipseElement | null) => {
    floor.current = { el, fill: "", opacity: -1 };
  }, []);

  // A new stage is a new drawing: the writer's identity changes, so the loop redraws it at once. Opacity comes from
  // the shared `lightOpacity` (lib/light.ts), so the drawing is as bright as the wall, not as the raw level.
  const panelIds = useMemo(() => stage.panels.map((p) => p.id), [stage]);
  const onFrame = useCallback<FrameWriter>(
    (lights) => {
      for (const panel of stage.panels) {
        const node = nodes.current.get(panel.id);
        if (!node) continue;
        const light = lights.get(panel.id);
        const opacity = panelOpacity(light);
        const fill = cssRgb(light?.rgb ?? WARM_WHITE);
        if (fill !== node.fill) {
          node.fill = fill;
          node.light?.setAttribute("fill", fill);
          node.bloom?.setAttribute("fill", fill);
        }
        if (opacity !== node.opacity) {
          node.opacity = opacity;
          const value = String(opacity);
          node.light?.setAttribute("fill-opacity", value);
          node.bloom?.setAttribute("fill-opacity", value);
          node.sheen?.setAttribute("opacity", value);
        }
      }
      const f = floor.current;
      if (!f.el) return;
      const glow = floorGlow(lights, panelIds);
      const fill = glow.rgb ? cssRgb(glow.rgb) : f.fill || cssRgb(WARM_WHITE);
      const opacity = glow.opacity;
      if (fill !== f.fill) {
        f.fill = fill;
        f.el.setAttribute("fill", fill);
      }
      if (opacity !== f.opacity) {
        f.opacity = opacity;
        f.el.setAttribute("opacity", String(opacity));
      }
    },
    [stage, panelIds],
  );
  useLights(stateRef, order, onFrame);

  const assigned = new Set(draft);
  const accentCss = cssRgb(accent);
  const segments = draft.slice(1).map((id, i) => [draft[i] ?? id, id] as const);
  const target = targetId === null ? undefined : stage.byId.get(targetId);
  const focused = focusId === null || focusId === targetId ? undefined : stage.byId.get(focusId);
  const flashed = flash ? stage.byId.get(flash.id) : undefined;

  return (
    <svg
      width={stage.width}
      height={stage.height}
      viewBox={`0 0 ${stage.width} ${stage.height}`}
      className="absolute inset-0 block touch-manipulation select-none"
      style={{
        filter: muted ? "saturate(0.3)" : "saturate(1)",
        transition: "filter 250ms cubic-bezier(0.23, 1, 0.32, 1)",
      }}
      role={drafting ? "group" : "img"}
      aria-label={drafting ? "Your wall: tap the panels in the order they should fill" : label}
    >
      <defs>
        <filter id={ids.bloom} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={stage.bloom} />
        </filter>
        <filter id={ids.floor} x="-50%" y="-200%" width="200%" height="500%">
          <feGaussianBlur stdDeviation={stage.floor.ry * 0.9} />
        </filter>
        {/* A soft hotspot: light through a diffuser is brighter in the middle. */}
        <radialGradient id={ids.sheen} cx="0.5" cy="0.42" r="0.62">
          <stop offset="0" stopColor="#fff" stopOpacity="0.34" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0.08" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>

      <LightLayers
        stage={stage}
        ids={ids}
        lit={drafting ? DRAFT_LIGHT : muted ? MUTED_LIGHT : 1}
        register={register}
        registerFloor={registerFloor}
      />

      {/* While drafting: numbered panels take the accent, the rest wait with a marching outline. */}
      {drafting &&
        stage.panels.map((p) =>
          assigned.has(p.id) ? (
            <motion.path
              key={`tint-${p.id}`}
              d={p.path}
              fill={accentCss}
              initial={{ fillOpacity: 0 }}
              animate={{ fillOpacity: 0.26 }}
              transition={{ duration: 0.2, ease: EASE_OUT }}
              pointerEvents="none"
            />
          ) : (
            <path
              key={`wait-${p.id}`}
              d={p.path}
              fill="none"
              stroke="rgb(255 255 255 / 0.38)"
              strokeWidth={1.25}
              strokeDasharray="4 5"
              className="wall-march"
              pointerEvents="none"
            />
          ),
        )}

      {/* The path the fill will take, drawn a segment per tap. */}
      <AnimatePresence>
        {drafting &&
          segments.map(([from, to]) => {
            const a = stage.byId.get(from);
            const b = stage.byId.get(to);
            if (!a || !b) return null;
            return (
              <motion.line
                key={`${from}-${to}`}
                x1={a.center[0]}
                y1={a.center[1]}
                x2={b.center[0]}
                y2={b.center[1]}
                stroke={accentCss}
                strokeOpacity={0.85}
                strokeWidth={2.5}
                strokeLinecap="round"
                pointerEvents="none"
                initial={{ pathLength: 0, opacity: 1 }}
                animate={{ pathLength: 1, opacity: 1 }}
                exit={{ pathLength: 0, opacity: 0, transition: { duration: reduced ? 0 : 0.15, ease: EASE_OUT } }}
                transition={{ pathLength: { duration: reduced ? 0 : 0.3, ease: EASE_OUT } }}
              />
            );
          })}
      </AnimatePresence>

      {/* Drop here: white, so it reads on a panel lit in the accent too. */}
      {target && (
        <path
          d={target.path}
          fill="rgb(255 255 255 / 0.16)"
          stroke="rgb(255 255 255 / 0.95)"
          strokeWidth={2.5}
          strokeDasharray="6 4"
          pointerEvents="none"
        />
      )}
      {focused && (
        <path
          d={focused.path}
          fill="rgb(255 255 255 / 0.06)"
          stroke="rgb(255 255 255 / 0.8)"
          strokeWidth={1.75}
          pointerEvents="none"
        />
      )}
      {flash && flashed && (
        <motion.path
          key={flash.n}
          d={flashed.path}
          fill="#fff"
          stroke="#fff"
          strokeWidth={2}
          pointerEvents="none"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.55, 0] }}
          transition={{ duration: 0.7, times: [0, 0.12, 1], ease: EASE_OUT }}
        />
      )}

      <HitLayer
        stage={stage}
        drafting={drafting}
        assigned={draft}
        onHover={props.onHover}
        onActivate={props.onActivate}
      />
    </svg>
  );
}

/** The DOM nodes the light loop writes into for one panel, and the values it last wrote there. */
interface LightNodes {
  light: SVGPathElement | null;
  bloom: SVGPathElement | null;
  sheen: SVGPathElement | null;
  fill: string;
  opacity: number;
}

interface LightLayersProps {
  readonly stage: Stage;
  readonly ids: { readonly bloom: string; readonly floor: string; readonly sheen: string };
  /** How much of the light layer shows (1 normally; less while drafting or muted). */
  readonly lit: number;
  register(id: number, kind: "light" | "bloom" | "sheen", el: Element | null): void;
  registerFloor(el: SVGEllipseElement | null): void;
}

/**
 * The static drawing and the light nodes. Memoised on the stage, so the once-a-second re-render of the section never
 * touches the elements the light loop owns.
 */
const LightLayers = memo(function LightLayers({ stage, ids, lit: amount, register, registerFloor }: LightLayersProps) {
  const lit = { opacity: amount, transition: "opacity 250ms cubic-bezier(0.23, 1, 0.32, 1)" };
  return (
    <>
      <g style={lit} aria-hidden>
        <ellipse
          ref={registerFloor}
          cx={stage.floor.cx}
          cy={stage.floor.cy}
          rx={stage.floor.rx}
          ry={stage.floor.ry}
          opacity={0}
          filter={`url(#${ids.floor})`}
        />
      </g>
      <g filter={`url(#${ids.bloom})`} style={{ ...lit, opacity: lit.opacity * 0.9 }} aria-hidden>
        {stage.panels.map((p) => (
          <path key={p.id} ref={(el) => register(p.id, "bloom", el)} d={p.path} fillOpacity={0} />
        ))}
      </g>
      {stage.others.map((o) =>
        o.role === "controller" ? (
          <g key={`o-${o.id}`} aria-hidden>
            <path d={o.path} fill="#2a2a31" stroke="rgb(255 255 255 / 0.12)" strokeWidth={1} />
            <circle
              cx={o.center[0]}
              cy={o.center[1]}
              r={Math.max(1.6, stage.scale * 3)}
              fill="rgb(255 255 255 / 0.4)"
            />
          </g>
        ) : (
          <path
            key={`o-${o.id}`}
            d={o.path}
            fill="none"
            stroke="rgb(255 255 255 / 0.18)"
            strokeWidth={1}
            strokeDasharray="3 4"
            aria-hidden
          />
        ),
      )}
      {stage.panels.map((p) => (
        <g key={p.id} aria-hidden>
          <path d={p.path} fill={DIFFUSER} stroke={DIFFUSER_EDGE} strokeWidth={1} />
          <g style={lit}>
            <path ref={(el) => register(p.id, "light", el)} d={p.path} fillOpacity={0} />
            <path ref={(el) => register(p.id, "sheen", el)} d={p.path} fill={`url(#${ids.sheen})`} opacity={0} />
          </g>
        </g>
      ))}
    </>
  );
});

interface HitLayerProps {
  readonly stage: Stage;
  readonly drafting: boolean;
  readonly assigned: readonly number[];
  onHover(id: number | null): void;
  onActivate(id: number): void;
}

/**
 * Transparent outlines on top that take the pointer. While drafting they are buttons: focusable, labelled, and
 * Enter or Space numbers the panel.
 */
function HitLayer({ stage, drafting, assigned, onHover, onActivate }: HitLayerProps) {
  const onKey = (id: number) => (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onActivate(id);
  };
  return (
    <g>
      {stage.panels.map((p) => {
        const number = assigned.indexOf(p.id) + 1;
        return (
          <path
            key={p.id}
            d={p.hit}
            data-panel={p.id}
            fill="transparent"
            className="wall-hit cursor-pointer outline-none"
            role={drafting ? "button" : undefined}
            tabIndex={drafting ? 0 : undefined}
            aria-hidden={drafting ? undefined : true}
            aria-label={drafting ? `${panelName(p)}${number ? `, number ${number}` : ", not numbered yet"}` : undefined}
            onClick={() => onActivate(p.id)}
            onKeyDown={drafting ? onKey(p.id) : undefined}
            onFocus={drafting ? () => onHover(p.id) : undefined}
            onBlur={drafting ? () => onHover(null) : undefined}
            onPointerEnter={(e) => e.pointerType === "mouse" && onHover(p.id)}
            onPointerLeave={(e) => e.pointerType === "mouse" && onHover(null)}
          />
        );
      })}
    </g>
  );
}
