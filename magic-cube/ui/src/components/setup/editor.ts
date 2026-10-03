import { useEffect,useMemo,useState } from "react";
import { useThemeColor } from "../../hooks/useThemeColor";
import { createAnchors } from "./cube/Cube3D";
import { useCubeArt } from "./live";
import type { Face,Workspace } from "./model";
import { useCubeRuntime } from "./runtime";

/** What the options and the cube share, whichever way a layout arranges the two. */
export function useCubeEditor(ws: Workspace) {
  const runtime = useCubeRuntime(ws);
  const background = useThemeColor();
  const anchors = useMemo(createAnchors, []);
  const [hoverFaces, setHoverFaces] = useState<Face[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // A face picked on the cube (its editor opens beside the cube), or a Manual face card whose picker is open.
  const [editing, setEditing] = useState<Face | null>(null);
  const [cardFace, setCardFace] = useState<Face | null>(null);
  const [flash, setFlash] = useState<{ key: string; n: number } | null>(null);
  const art = useCubeArt(ws.setup, preview);
  const live = runtime.view !== "idle";
  const mode = ws.setup.mode;

  // Picking the cube up, loading another preset or changing the game closes the face being edited.
  useEffect(() => {
    if (live) setEditing(null);
  }, [live]);
  useEffect(() => {
    setEditing(null);
    setCardFace(null);
  }, [ws.bootKey, mode]);

  return {
    runtime, background, anchors, art, live, mode, editing, cardFace, flash,
    focus: editing ? [editing] : cardFace ? [cardFace] : hoverFaces,
    setHoverFaces, setPreview, setEditing,
    selectCard(f: Face | null) {
      setEditing(null);
      setCardFace(f);
    },
    onFaceClick(f: Face) {
      setCardFace(null);
      setEditing(f === editing ? null : f);
      // The option that face belongs to answers too.
      const slot = art.slots[f];
      if (mode === "duel" && slot.side) setFlash({ key: slot.side, n: (flash?.n ?? 0) + 1 });
      else if (mode === "shortlist" && slot.item != null) setFlash({ key: String(slot.item), n: (flash?.n ?? 0) + 1 });
    },
  };
}
