import { Button,Dropdown,DropdownItem,DropdownMenu,DropdownTrigger,Input,Popover,PopoverContent,PopoverTrigger } from "@heroui/react";
import { cn } from "@heroui/theme";
import { Copy,MoreHorizontal,Pencil,Trash2 } from "lucide-react";
import { useEffect,useState } from "react";
import { LiveIcon } from "./icons";
import { cubeArt,FACES,MODES,type ModeState,type Preset,type Workspace } from "./model";

export function CardFace({ setup, name, active }: { setup: ModeState; name: string; active: boolean }) {
  const mode = MODES.find((m) => m.id === setup.mode)!;
  const { faces } = cubeArt(setup);
  const lead = FACES.map((f) => faces[f].color).find(Boolean) ?? "#71717a";
  return (
    <div className={cn("absolute inset-0 overflow-hidden rounded-2xl rounded-b-md bg-content2 ring-1", active ? "ring-primary/70" : "ring-default-100 group-hover:ring-default-200")} style={active ? { boxShadow: `0 8px 24px -12px ${lead}88` } : undefined}>
      <div className="flex h-3 items-center justify-center gap-[3px] bg-background/30">
        {Array.from({ length: 14 }, (_, i) => <span key={i} className="h-1.5 w-[2px] rounded-full bg-foreground/10" />)}
      </div>
      <div className="m-2 mt-2 flex h-12 items-center gap-2 rounded-lg pl-2.5 pr-7 text-zinc-50" style={{ background: `linear-gradient(135deg, ${lead}32, ${lead}18)` }}>
        <span className="shrink-0 text-zinc-100"><LiveIcon path={mode.iconPath} size={20} /></span>
        <span className="line-clamp-2 min-w-0 break-words text-sm font-semibold leading-tight">{name}</span>
      </div>
      <div className="absolute bottom-2 left-2.5 right-2.5 flex gap-1">
        {FACES.map((f) => <span key={f} className="h-1.5 flex-1 rounded-full" style={{ background: faces[f].color ?? "color-mix(in srgb, var(--db-foreground) 12%, transparent)" }} />)}
      </div>
    </div>
  );
}

export function PresetActions({ preset, ws }: { preset: Preset; ws: Workspace }) {
  const [naming, setNaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="relative" data-menu-open={menuOpen || naming}>
      <Dropdown placement="bottom-end" isOpen={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownTrigger>
          <button aria-label={`${preset.name} options`} className="grid h-7 w-7 place-items-center rounded-md text-default-600 transition-colors duration-150 hover:bg-foreground/15 hover:text-foreground data-[hover=true]:bg-foreground/15 focus-visible:outline-2 focus-visible:outline-primary"><MoreHorizontal className="h-4 w-4" /></button>
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
  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onSubmit(n);
    onOpenChange(false);
  };
  return (
    <Popover isOpen={isOpen} onOpenChange={onOpenChange} placement="bottom-end">
      <PopoverTrigger>
        <span className="absolute bottom-0 right-0 h-0 w-0" />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3">
        {/* Not a <form>: hosts sandbox UIs without allow-forms, where a form never submits. Enter submits instead. */}
        <div
          className="w-full space-y-2"
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
              e.preventDefault();
              submit();
            }
          }}
        >
          <Input size="sm" autoFocus label={label} value={name} onValueChange={setName} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="light" onPress={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" color="primary" onPress={submit}>
              {action}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
