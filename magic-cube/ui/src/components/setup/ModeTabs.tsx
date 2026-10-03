import { motion } from "motion/react";
import { useId,useRef,useState,type KeyboardEvent } from "react";
import { LiveIcon } from "./icons";
import { MODES,type ModeId } from "./model";
import { useTiming } from "./preset-controls";

const labels = { duel: 'Feel vs Should', shortlist: 'Shortlist', roulette: 'Roulette', manual: 'Manual' };
type NavProps = { value: ModeId; onChange: (mode: ModeId) => void };

export function ModeNav({ value, onChange }: NavProps) {
  const uid = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [keyboard, setKeyboard] = useState(false);
  const timing = useTiming();
  function navigate(e: KeyboardEvent, i: number) {
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % 4 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i + 3) % 4 : e.key === 'Home' ? 0 : e.key === 'End' ? 3 : null;
    if (next == null) return;
    e.preventDefault(); e.stopPropagation(); setKeyboard(true); onChange(MODES[next].id); refs.current[next]?.focus();
  }
  return <div className="ms-mode-nav ms-mode-tabs" role="radiogroup" aria-label="Cube mode">
    {MODES.map((m, i) => <button key={m.id} ref={el => { refs.current[i] = el; }} role="radio" aria-label={m.name} aria-checked={value === m.id} tabIndex={value === m.id ? 0 : -1} onKeyDown={e => navigate(e, i)} onClick={e => { setKeyboard(e.detail === 0); onChange(m.id); }}>
      <span className="ms-mode-line"><LiveIcon path={m.iconPath} size={16} /><span>{labels[m.id]}</span></span>
      {value === m.id && <motion.span className="ms-mode-indicator" layoutId={`${uid}-active`} transition={keyboard ? { duration: 0 } : timing} />}
    </button>)}
  </div>;
}
