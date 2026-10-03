import { ChevronDown,ChevronUp } from "lucide-react";
import { AnimatePresence,motion } from "motion/react";
import { useState } from "react";

import { useMediaQuery } from "./live";
import { faceSlots } from "./model";
import { NewPreset,PresetTile,useTiming,type WorkspaceProps } from "./preset-controls";

export function PresetTray({ ws }: WorkspaceProps) {
  const [expanded, setExpanded] = useState(false);
  const wide = useMediaQuery('(min-width: 900px)');
  const medium = useMediaQuery('(min-width: 600px)');
  const capacity = wide ? 4 : medium ? 3 : 2;
  const overflow = ws.presets.length > capacity;
  const open = expanded && overflow;
  const preview = ws.presets.slice(0, capacity);
  if (ws.active && !preview.some(p => p.id === ws.activeId)) preview[preview.length - 1] = ws.active;
  const visible = open ? ws.presets : preview;
  const timing = useTiming();
  return <div className="ps-study ps-tray-study">
    <motion.section layout="position" transition={timing} className="ps-tray" aria-label="Preset tray">
      <div className="ps-section-heading"><div><strong>Presets</strong><span>{ws.presets.length}</span></div>{!ws.active && Object.values(faceSlots(ws.setup)).some(s => s.mapping) && <NewPreset ws={ws} saveCurrent label="Save setup" />}</div>
      <div className="ps-tray-grid" data-expanded={open}>
        <AnimatePresence initial={false} mode="popLayout">{visible.map(p => <motion.div key={p.id} layout="position" initial={{ opacity: 0, transform: 'translateY(-8px)' }} animate={{ opacity: 1, transform: 'translateY(0px)' }} exit={{ opacity: 0, transform: 'translateY(-6px)' }} transition={timing}><PresetTile preset={p} ws={ws} /></motion.div>)}</AnimatePresence>
        <NewPreset ws={ws} tile />
      </div>
      {overflow && <button className="ps-tray-expand" aria-expanded={open} onClick={() => setExpanded(!open)}>{open ? <>Show less <ChevronUp size={14} /></> : <>Show {ws.presets.length - capacity} more presets <ChevronDown size={14} /></>}</button>}
      {!ws.presets.length && <p className="ps-empty-copy">A preset saves the way your cube chooses. Start with one for your everyday routine.</p>}
    </motion.section>
  </div>;
}
