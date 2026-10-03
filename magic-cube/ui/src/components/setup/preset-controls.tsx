import { Button,Input,Modal,ModalBody,ModalContent,ModalFooter,ModalHeader } from "@heroui/react";
import { Plus } from "lucide-react";
import { motion,useReducedMotion } from "motion/react";
import { useState } from "react";
import { LiveIcon } from "./icons";
import { MODES,type ModeId,type Preset,type Workspace } from "./model";
import { CardFace,PresetActions } from "./preset-card";

export type WorkspaceProps = { ws: Workspace };
export function useTiming() {
  const reduced = useReducedMotion();
  return { duration: reduced ? 0 : .22, ease: [0.23, 1, 0.32, 1] as const };
}

export function PresetTile({ preset, ws, onSelect }: WorkspaceProps & { preset: Preset; onSelect?: () => void }) {
  const active = preset.id === ws.activeId;
  return <motion.div layout="position" transition={useTiming()} className="ps-tile" data-active={active}>
    <button className="ps-tile-select" aria-pressed={active} aria-label={`Load ${preset.name}`} onClick={() => { if (!active) ws.select(preset.id); onSelect?.(); }}>
      <CardFace setup={preset.setup} name={preset.name} active={active} />
    </button>
    <div className="ps-tile-actions"><PresetActions preset={preset} ws={ws} /></div>
  </motion.div>;
}

export function NewPreset({ ws, tile = false, onCreated, label = 'New preset', saveCurrent = false }: WorkspaceProps & { tile?: boolean; onCreated?: () => void; label?: string; saveCurrent?: boolean }) {
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ModeId>('duel');
  const submit = async () => { if (!name.trim() || saving) return; setSaving(true); const saved = await (saveCurrent ? ws.saveAsNew(name.trim()) : ws.create(name.trim(), mode)); setSaving(false); if (saved) { setOpen(false); onCreated?.(); } };
  return <>
    <button className={tile ? 'ps-new-tile' : 'ps-button'} onClick={() => { setName(''); setOpen(true); }}><Plus size={16} /><span>{label}</span>{tile && <small>Make room for something new</small>}</button>
    <Modal isOpen={open} onOpenChange={setOpen} placement="center" backdrop="blur">
      <ModalContent>
        {/* Not a <form>: hosts sandbox UIs without allow-forms, where a form never submits. Enter submits instead. */}
        <div onKeyDown={e => { if (e.key === 'Enter' && e.target instanceof HTMLInputElement) { e.preventDefault(); void submit(); } }}>
          <ModalHeader>{saveCurrent ? "Save setup as preset" : "New preset"}</ModalHeader>
          <ModalBody>
            <Input autoFocus label="Preset name" placeholder="An evening with no plans" value={name} onValueChange={setName} maxLength={120} isRequired />
            {!saveCurrent && <><p className="ps-form-label">How should the cube choose?</p>
            <div className="ps-mode-choices" role="group" aria-label="New preset mode">{MODES.map(m => <button type="button" key={m.id} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}><LiveIcon path={m.iconPath} size={20} /><strong>{m.name}</strong><small>{m.tagline}</small></button>)}</div></>}
            {ws.error && <p role="alert" className="text-sm text-danger">{ws.error}</p>}
          </ModalBody>
          <ModalFooter><Button variant="light" onPress={() => setOpen(false)}>Cancel</Button><Button color="primary" onPress={() => void submit()} isLoading={saving} isDisabled={!name.trim()}>{saveCurrent ? "Save preset" : "Create preset"}</Button></ModalFooter>
        </div>
      </ModalContent>
    </Modal>
  </>;
}
