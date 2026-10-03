import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Input, Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { cn } from "@heroui/theme";
import { ChevronDown, ChevronUp, Copy, MoreHorizontal, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { LiveIcon } from "./icons";
import { ModeCards } from "./kit";
import { cubeArt, FACES, MODES, type ModeId, type ModeState, type Preset, type Workspace } from "./model";
import { useMediaQuery } from "./live";
import "./preset-shelf.css";
import { EASE_OUT } from "./motion";

export function PresetShelf({ ws, expanded, onExpandedChange }: { ws: Workspace; expanded: boolean; onExpandedChange: (expanded: boolean) => void }) {
  const [filter, setFilter] = useState<ModeId | "all">("all");
  const desktop = useMediaQuery("(min-width: 1024px)");
  const tablet = useMediaQuery("(min-width: 640px)");
  const capacity = desktop ? 5 : tablet ? 3 : 2;
  const matches = ws.presets.filter((p) => filter === "all" || p.setup.mode === filter);
  const preview = ws.presets.slice(0, capacity);
  // Keep the loaded preset in view even when a preset loads one beyond the first row.
  if (ws.active && !preview.some((p) => p.id === ws.activeId)) preview[preview.length - 1] = ws.active;
  const visible = expanded ? matches : preview;
  const select = () => onExpandedChange(false);
  return (
    <section aria-label="Presets" className="space-y-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button aria-expanded={expanded} aria-controls="preset-shelf" aria-label={expanded ? "Collapse presets" : "Expand presets"}
          onClick={() => { if (!expanded) setFilter("all"); onExpandedChange(!expanded); }}
          className="flex min-h-9 items-center gap-2 rounded-lg px-1 text-sm font-semibold text-zinc-100 hover:text-white focus-visible:outline-2 focus-visible:outline-primary">
          Presets <span className="text-xs font-normal text-zinc-400">{ws.presets.length}</span>
          {expanded ? <ChevronUp className="h-4 w-4 text-zinc-400" /> : <ChevronDown className="h-4 w-4 text-zinc-400" />}
        </button>
        <div className="ml-auto"><NewPresetCard ws={ws} onCreated={select} /></div>
      </div>
      {expanded && <div className="flex flex-wrap gap-2" role="group" aria-label="Filter presets by mode">
        {[{ id: "all" as const, name: "All modes", iconPath: null }, ...MODES].map((m) => (
          <button key={m.id} aria-pressed={filter === m.id} onClick={() => setFilter(m.id)}
            className={cn("flex min-h-9 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-primary", filter === m.id ? "border-zinc-500 bg-zinc-800 text-white" : "border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-100")}>
            {m.iconPath && <LiveIcon path={m.iconPath} size={15} />}{m.name}
          </button>
        ))}
      </div>}
      <div id="preset-shelf" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {!ws.activeId && <UnsavedCard ws={ws} />}
        {visible.map((p) => <PresetCard key={p.id} preset={p} ws={ws} active={p.id === ws.activeId} onSelect={select} />)}
      </div>
      {expanded && !matches.length && <p className="py-12 text-center text-sm text-zinc-400">No presets in this mode yet.</p>}
      {!expanded && ws.presets.length > capacity && <button onClick={() => { setFilter("all"); onExpandedChange(true); }} className="text-xs text-zinc-400 hover:text-white">Show all {ws.presets.length} presets</button>}
    </section>
  );
}

export function CardFace({ setup, name, active }: { setup: ModeState; name: string; active: boolean }) {
  const mode = MODES.find((m) => m.id === setup.mode)!;
  const { faces } = cubeArt(setup);
  const lead = FACES.map((f) => faces[f].color).find(Boolean) ?? "#71717a";
  return (
    <div className={cn("absolute inset-0 overflow-hidden rounded-2xl rounded-b-md bg-[#232328] ring-1", active ? "ring-primary/70" : "ring-default-100 group-hover:ring-default-200")} style={active ? { boxShadow: `0 8px 24px -12px ${lead}88` } : undefined}>
      <div className="flex h-3 items-center justify-center gap-[3px] bg-black/30">
        {Array.from({ length: 14 }, (_, i) => <span key={i} className="h-1.5 w-[2px] rounded-full bg-white/10" />)}
      </div>
      <div className="m-2 mt-2 flex h-12 items-center gap-2 rounded-lg pl-2.5 pr-7 text-zinc-50" style={{ background: `linear-gradient(135deg, ${lead}32, ${lead}18)` }}>
        <span className="shrink-0 text-zinc-100"><LiveIcon path={mode.iconPath} size={20} /></span>
        <span className="line-clamp-2 min-w-0 break-words text-sm font-semibold leading-tight">{name}</span>
      </div>
      <div className="absolute bottom-2 left-2.5 right-2.5 flex gap-1">
        {FACES.map((f) => <span key={f} className="h-1.5 flex-1 rounded-full" style={{ background: faces[f].color ?? "rgba(255,255,255,0.12)" }} />)}
      </div>
    </div>
  );
}

function PresetCard({ preset, ws, active, onSelect }: { preset: Preset; ws: Workspace; active: boolean; onSelect?: () => void }) {
  const reduced = useReducedMotion();
  return (
    <motion.div className="group relative h-[96px] w-full min-w-0 select-none"
      animate={{ transform: active && !reduced ? "translateY(-3px)" : "translateY(0px)" }} transition={{ duration: 0.2, ease: EASE_OUT }}>
      <button onClick={() => { if (!active) ws.select(preset.id); onSelect?.(); }} aria-pressed={active} aria-label={`${preset.name}${active ? " (loaded)" : ""}`}
        className="absolute inset-0 rounded-2xl text-left transition-transform duration-150 ease-out active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
        <CardFace setup={preset.setup} name={preset.name} active={active} />
      </button>
      <div className="preset-card-actions absolute right-3 top-[30px] z-10"><PresetActions preset={preset} ws={ws} /></div>
    </motion.div>
  );
}

export function PresetActions({ preset, ws }: { preset: Preset; ws: Workspace }) {
  const [naming, setNaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="relative" data-menu-open={menuOpen || naming}>
      <Dropdown placement="bottom-end" isOpen={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownTrigger>
          <button aria-label={`${preset.name} options`} className="grid h-7 w-7 place-items-center rounded-md text-zinc-300 transition-colors duration-150 hover:bg-white/15 hover:text-white data-[hover=true]:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary"><MoreHorizontal className="h-4 w-4" /></button>
        </DropdownTrigger>
        <DropdownMenu aria-label="Preset options" onAction={(key) => {
          if (key === "rename") setNaming(true);
          else if (key === "duplicate") ws.duplicate(preset.id);
          else if (key === "delete") ws.remove(preset.id);
        }}>
          <DropdownItem key="rename" startContent={<Pencil className="h-4 w-4" />}>Rename…</DropdownItem>
          <DropdownItem key="duplicate" startContent={<Copy className="h-4 w-4" />}>Duplicate</DropdownItem>
          <DropdownItem key="delete" startContent={<Trash2 className="h-4 w-4" />} className="text-danger" color="danger">Delete preset</DropdownItem>
        </DropdownMenu>
      </Dropdown>
      <NamePopover isOpen={naming} onOpenChange={setNaming} label="Rename preset" initial={preset.name} action="Rename" onSubmit={(name) => ws.rename(name, preset.id)} />
    </div>
  );
}

function UnsavedCard({ ws }: { ws: Workspace }) {
  const [naming, setNaming] = useState(false);
  return (
    <div className="relative h-[128px] w-full min-w-0">
      <CardFace setup={ws.setup} name="Unsaved setup" active={false} />
      <div className="pointer-events-none absolute inset-0 rounded-xl border border-dashed border-default-300" />
      <div className="absolute bottom-6 right-3">
        <button onClick={() => setNaming(true)} className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground transition-transform duration-150 ease-out active:scale-[0.97]"><Save className="h-3 w-3" /> Save</button>
        <NamePopover isOpen={naming} onOpenChange={setNaming} label="Preset name" initial={`Preset ${ws.presets.length + 1}`} action="Save" onSubmit={(name) => ws.saveAsNew(name)} />
      </div>
    </div>
  );
}

function NewPresetCard({ ws, onCreated }: { ws: Workspace; onCreated?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover isOpen={open} onOpenChange={setOpen} placement="bottom-start">
      <PopoverTrigger>
        <button className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-xs font-medium text-zinc-200 transition-colors duration-150 hover:bg-zinc-800 active:scale-[0.97]"><Plus className="h-4 w-4" />New preset</button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(420px,calc(100vw-32px))] p-3">
        <div className="w-full space-y-2">
          <div className="text-sm font-semibold">What does the new preset play?</div>
          <ModeCards value={ws.setup.mode} onChange={(m) => { ws.create(`New ${MODES.find((x) => x.id === m)!.short.toLowerCase()}`, m); setOpen(false); onCreated?.(); }} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NamePopover({
  isOpen,
  onOpenChange,
  label,
  initial,
  action,
  onSubmit,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  initial: string;
  action: string;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  useEffect(() => {
    if (isOpen) setName(initial);
  }, [isOpen, initial]);
  return (
    <Popover isOpen={isOpen} onOpenChange={onOpenChange} placement="bottom-end">
      <PopoverTrigger>
        <span className="absolute bottom-0 right-0 h-0 w-0" />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3">
        <form
          className="w-full space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (!n) return;
            onSubmit(n);
            onOpenChange(false);
          }}
        >
          <Input size="sm" autoFocus label={label} value={name} onValueChange={setName} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="light" onPress={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" color="primary" type="submit">
              {action}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
