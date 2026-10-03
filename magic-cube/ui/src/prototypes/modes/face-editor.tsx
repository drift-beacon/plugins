import { Button } from "@heroui/react";
import { cn } from "@heroui/theme";
import { Plus, X } from "lucide-react";
import { motion } from "motion/react";
import { useRef, useState } from "react";
import { type CubeAnchors, useAnchors } from "./cube/Cube3D";
import { LiveIcon } from "./icons";
import { addItem, describe, type Face, FACES, type FaceSlot, FEEL_FACES, mappingKey, sameMapping, SHOULD_FACES, type Workspace } from "./model";
import { EASE_OUT } from "./motion";
import { PickerPanel } from "./picker";
import { Pips } from "./shared";

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Where the editor sits on the stage: docked on its right edge, docked along its bottom (a narrow stage), or beside the
 * cube on its left, following it (a stage whose right side the cube fills).
 */
export type FaceEditorPlacement = "right" | "bottom" | "beside";

/**
 * Editing one face, opened by clicking it on the cube, with a line back to the face it edits. What a face holds
 * depends on the mode (a side of the duel, a pick, the roulette's category, its own activity), so that's what it edits.
 * Same picker as everywhere.
 */
export function FaceEditor({
  face,
  ws,
  slot,
  anchors,
  placement,
  onClose,
}: {
  face: Face;
  ws: Workspace;
  slot: FaceSlot;
  anchors: CubeAnchors;
  placement: FaceEditorPlacement;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const line = useRef<SVGLineElement>(null);
  useAnchors(anchors, () => {
    const a = anchors.faces[face];
    const b = box.current;
    const l = line.current;
    if (!b || !l) return;
    let x2: number;
    let y2: number;
    if (placement === "beside") {
      const host = b.offsetParent as HTMLElement | null;
      if (!host) return;
      const { center } = anchors;
      let radius = 0;
      for (const f of FACES) radius = Math.max(radius, Math.hypot(anchors.faces[f].x - center.x, anchors.faces[f].y - center.y));
      const w = b.offsetWidth;
      const h = b.offsetHeight;
      const x = clamp(center.x - radius - 44 - w, 12, host.clientWidth - w - 12);
      const y = clamp(center.y - h / 2, 12, host.clientHeight - h - 12);
      b.style.transform = `translate(${x}px, ${y}px)`;
      b.style.opacity = "1";
      x2 = x + w;
      y2 = y + 28;
    } else {
      const r = b.getBoundingClientRect();
      const host = b.offsetParent?.getBoundingClientRect();
      if (!host) return;
      x2 = placement === "bottom" ? r.left - host.left + r.width / 2 : r.left - host.left;
      y2 = placement === "bottom" ? r.top - host.top : r.top - host.top + 28;
    }
    l.setAttribute("x1", String(a.x));
    l.setAttribute("y1", String(a.y));
    l.setAttribute("x2", String(x2));
    l.setAttribute("y2", String(y2));
  });

  const card = (
    <motion.div
      ref={placement === "beside" ? undefined : box}
      className={cn(
        "overflow-hidden rounded-2xl bg-content1/95 shadow-2xl ring-1 ring-default-200 backdrop-blur",
        placement === "beside" && "w-80",
        placement === "right" && "absolute right-5 top-1/2 z-20 w-80",
        placement === "bottom" && "absolute inset-x-3 bottom-3 z-20",
      )}
      style={
        placement === "right"
          ? { translateY: "-50%", transformOrigin: "left center" }
          : { transformOrigin: placement === "bottom" ? "bottom center" : "right center" }
      }
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12, ease: EASE_OUT } }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
    >
      <Body face={face} ws={ws} slot={slot} onClose={onClose} />
    </motion.div>
  );

  return (
    <>
      <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-hidden>
        <motion.line ref={line} stroke="hsl(var(--heroui-primary))" strokeWidth={1.5} initial={{ opacity: 0 }} animate={{ opacity: 0.8 }} exit={{ opacity: 0 }} />
      </svg>
      {placement === "beside" ? (
        // Positioned every frame from the cube; hidden until the first frame has placed it.
        <div ref={box} className="absolute left-0 top-0 z-20" style={{ opacity: 0 }}>
          {card}
        </div>
      ) : (
        card
      )}
    </>
  );
}

function Body({ face, ws, slot, onClose }: { face: Face; ws: Workspace; slot: FaceSlot; onClose: () => void }) {
  const mode = ws.setup.mode;
  const list = ws.setup.shortlist;
  const d = describe(slot.mapping);
  const [newPick, setNewPick] = useState(false);

  return (
    <>
      <div className="flex items-center gap-2.5 px-4 pb-1 pt-3.5">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-foreground text-background">
          <Pips face={face} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Face {face}</div>
          <div className="text-xs text-default-400">
            {mode === "duel"
              ? `The ${slot.side === "should" ? "Should" : "Feel"} side, with faces ${(slot.side === "should" ? SHOULD_FACES : FEEL_FACES).filter((x) => x !== face).join(" & ")}`
              : mode === "roulette"
                ? "Every face draws from one category"
                : mode === "shortlist"
                  ? "Which pick is on this face?"
                  : d
                    ? d.subtitle
                    : "Nothing yet"}
          </div>
        </div>
        <Button isIconOnly size="sm" variant="light" aria-label="Close" onPress={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {mode === "duel" && slot.side && (
        <PickerPanel
          className="max-h-[360px]"
          value={ws.setup.duel[slot.side]}
          exclude={[ws.setup.duel[slot.side === "should" ? "feel" : "should"]]}
          onClose={onClose}
          onSelect={(m) => m && ws.update({ duel: { ...ws.setup.duel, [slot.side!]: m } })}
        />
      )}
      {mode === "manual" && (
        <PickerPanel
          className="max-h-[360px]"
          value={ws.setup.manual[face]}
          clearLabel="Leave this face empty"
          onClose={onClose}
          onSelect={(m) => ws.update({ manual: { ...ws.setup.manual, [face]: m } })}
        />
      )}
      {mode === "roulette" && (
        <PickerPanel
          className="max-h-[360px]"
          categoriesOnly
          value={ws.setup.roulette ? { type: "category", id: ws.setup.roulette } : null}
          onClose={onClose}
          onSelect={(m) => m && ws.update({ roulette: m.id })}
        />
      )}
      {mode === "shortlist" &&
        (newPick ? (
          <PickerPanel
            className="max-h-[360px]"
            value={null}
            exclude={list.items}
            onClose={() => setNewPick(false)}
            onSelect={(m) => {
              if (!m) return;
              const next = addItem(list, m);
              const idx = next.items.findIndex((x) => sameMapping(x, m));
              ws.update({ shortlist: { ...next, faces: { ...next.faces, [face]: idx } } });
              setNewPick(false);
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-1.5 px-4 pb-4 pt-2">
            {list.items.map((m, i) => {
              const dd = describe(m)!;
              const on = list.faces[face] === i;
              return (
                <button
                  key={mappingKey(m)}
                  onClick={() => ws.update({ shortlist: { ...list, faces: { ...list.faces, [face]: i } } })}
                  className={cn(
                    "flex max-w-full items-center gap-1.5 rounded-full py-1 pl-2 pr-2.5 text-xs ring-1 transition-[background-color,box-shadow,color,transform] duration-150 ease-out active:scale-[0.97]",
                    on ? "text-foreground ring-transparent" : "text-default-500 ring-default-200 hover:text-foreground",
                  )}
                  style={on ? { background: `${dd.color}33`, boxShadow: `inset 0 0 0 1px ${dd.color}` } : undefined}
                >
                  <LiveIcon path={dd.iconPath} color={dd.color} size={12} verb={dd.verb} play={on ? i : undefined} />
                  <span className="truncate">{dd.isCategory ? `Any ${dd.name}` : dd.name}</span>
                </button>
              );
            })}
            {list.items.length < 6 && (
              <button
                onClick={() => setNewPick(true)}
                className="flex items-center gap-1 rounded-full border border-dashed border-default-300 px-2.5 py-1 text-xs text-default-400 transition-colors duration-150 hover:border-default-400 hover:text-foreground"
              >
                <Plus className="h-3 w-3" /> New pick
              </button>
            )}
          </div>
        ))}
    </>
  );
}
