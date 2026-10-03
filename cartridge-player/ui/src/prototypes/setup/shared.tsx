// Prototype-only: what the first-run directions share. The data is the production model's (the simulator supplies
// it) and the code is built by the production rules (view/setup.ts), so each direction shows real values; only the
// layout around them differs.
import { Check, Copy, KeyRound, Pencil, Server } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Eyebrow } from "../../components/kit.tsx";
import { LED_AT, VIEWBOX } from "../../components/scene/geometry.ts";
import { PlayerScene } from "../../components/scene/PlayerScene.tsx";
import { useCopy } from "../../hooks/useCopy.ts";
import { cx } from "../../lib/cx.ts";
import { useModel } from "../../model.ts";
import { sentence } from "../../view/errors.ts";
import { hubDefaults, PLAYER_SETUP_URL, setupCodeFor } from "../../view/setup.ts";

/** What the harness controls, outside any direction: the simulated player and the frame. */
export interface Proto {
  /** The player has reported for the first time. */
  readonly connected: boolean;
  /** The frame is a phone's width. */
  readonly phone: boolean;
}

export const ProtoContext = createContext<Proto>({ connected: false, phone: false });
export const useProto = () => useContext(ProtoContext);

/** The network a player opens while it isn't set up; the last four characters are its own. */
export const NETWORK = "Cartridge-XXXX";
export const PLAYER_NAME = "Cartridge-A1B2";
export { PLAYER_SETUP_URL };

/** The setup code and the three things it is made of, as the production guide holds them. */
export function useSetup() {
  const { record, apiPath, pageHost } = useModel();
  const start = useMemo(() => hubDefaults(record, pageHost), [record, pageHost]);
  const [host, setHost] = useState(start.host);
  const [port, setPort] = useState(String(start.port));
  const [key, setKey] = useState("");
  const { code, problems } = setupCodeFor({ host, port, base: apiPath, key });
  const hubKnown = host.trim() !== "" && !problems.host && !problems.port;
  const hasKey = key.trim() !== "" && !problems.key;
  return { host, setHost, port, setPort, key, setKey, code, problems, hubKnown, hasKey };
}
export type Setup = ReturnType<typeof useSetup>;

/** A labelled input in the interface's own style. */
export function Field({
  label,
  value,
  onChange,
  problem,
  hint,
  placeholder,
  inputMode,
  className,
  autoFocus,
  hideLabel = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  problem?: string;
  hint?: ReactNode;
  placeholder?: string;
  inputMode?: "text" | "numeric";
  className?: string;
  autoFocus?: boolean;
  /** For a field whose heading already names it. */
  hideLabel?: boolean;
}) {
  const id = useId();
  const note = problem ? sentence(problem) : hint;
  return (
    <div className={cx("min-w-0", className)}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "mb-1 block text-xs font-medium text-default-500"}>
        {label}
      </label>
      <input
        id={id}
        value={value}
        inputMode={inputMode}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={problem ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cx(
          "cp-touch h-10 w-full rounded-xl bg-default-100 px-3 font-mono text-sm text-foreground outline-none placeholder:font-sans placeholder:text-default-400 focus-visible:ring-2",
          problem ? "ring-1 ring-danger focus-visible:ring-danger" : "focus-visible:ring-focus",
        )}
      />
      {note && <p className={cx("mt-1 text-xs leading-snug", problem ? "text-danger" : "text-default-500")}>{note}</p>}
    </div>
  );
}

/** The hub's address and port, side by side. */
export function HubFields({ setup, autoFocus }: { setup: Setup; autoFocus?: boolean }) {
  const asked = setup.host.trim() === "";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
      <Field
        label="Hub address"
        value={setup.host}
        onChange={setup.setHost}
        placeholder="192.168.1.12"
        autoFocus={autoFocus}
        problem={asked ? undefined : setup.problems.host}
        hint={asked ? "Where Drift Beacon runs on your network." : undefined}
      />
      <Field label="Port" value={setup.port} onChange={setup.setPort} inputMode="numeric" problem={setup.problems.port} />
    </div>
  );
}

export function KeyField({
  setup,
  autoFocus,
  hint,
  hideLabel,
}: {
  setup: Setup;
  autoFocus?: boolean;
  hint?: ReactNode;
  hideLabel?: boolean;
}) {
  return (
    <Field
      label="API key"
      hideLabel={hideLabel}
      value={setup.key}
      onChange={setup.setKey}
      placeholder="db_…"
      autoFocus={autoFocus}
      problem={setup.problems.key}
      hint={hint}
    />
  );
}

/**
 * The setup code with its Copy button. The code sits in a read-only field (so it can be selected by hand when the
 * frame refuses the clipboard), and `onCopied` only fires when a copy really happened.
 */
export function CodeCopy({
  code,
  onCopied,
  size = "md",
  label = "Copy code",
}: {
  code: string | null;
  onCopied?(): void;
  size?: "md" | "lg";
  label?: string;
}) {
  const field = useRef<HTMLInputElement>(null);
  const { state, copy } = useCopy(field);
  const copied = state === "copied";
  // Only a copy that really happened counts: a refused clipboard leaves the field selected instead.
  const told = useRef(onCopied);
  told.current = onCopied;
  useEffect(() => {
    if (copied) told.current?.();
  }, [copied]);
  return (
    <div className="space-y-2">
      <div className={cx("flex items-center gap-2 rounded-2xl bg-default-100", size === "lg" ? "p-2 pl-4" : "p-1.5 pl-3")}>
        <input
          ref={field}
          readOnly
          disabled={!code}
          value={code ?? "Waiting for the hub's address"}
          aria-label="Setup code"
          onFocus={(event) => event.currentTarget.select()}
          className={cx(
            "min-w-0 flex-1 truncate bg-transparent font-mono outline-none disabled:font-sans disabled:text-default-400",
            size === "lg" ? "text-base" : "text-sm",
          )}
        />
        <Button
          tone="primary"
          disabled={!code}
          icon={copied ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
          onClick={() => void copy()}
        >
          {copied ? "Copied" : label}
        </Button>
      </div>
      {state === "selected" && (
        <p className="text-xs text-default-500">This page can't copy for you. The code is selected: copy it by hand.</p>
      )}
    </div>
  );
}

/** A small summary that opens into the fields behind it: defaults stay quiet, and are one click from being changed. */
function Chip({
  icon,
  children,
  open,
  onToggle,
  tone = "default",
}: {
  icon: ReactNode;
  children: ReactNode;
  open: boolean;
  onToggle(): void;
  tone?: "default" | "ask";
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cx(
        "cp-press cp-touch flex min-w-0 items-center gap-1.5 rounded-full py-1.5 pr-2.5 pl-2.5 text-xs",
        tone === "ask" ? "bg-warning/15 text-warning hover:bg-warning/25" : "bg-default-100 text-default-600 hover:bg-default-200 hover:text-foreground",
        open && "ring-1 ring-default-300",
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
      <Pencil aria-hidden="true" className="h-3 w-3 shrink-0 opacity-60" />
    </button>
  );
}

/**
 * What the code is made of, as two chips: the hub (prefilled, so it is only a summary until it's wrong) and the key
 * (optional). Each opens its fields in place.
 */
export function Ingredients({ setup }: { setup: Setup }) {
  const [open, setOpen] = useState<"hub" | "key" | null>(setup.hubKnown ? null : "hub");
  const toggle = (which: "hub" | "key") => setOpen((o) => (o === which ? null : which));
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        <Chip
          icon={<Server aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
          open={open === "hub"}
          onToggle={() => toggle("hub")}
          tone={setup.hubKnown ? "default" : "ask"}
        >
          {setup.hubKnown ? (
            <>
              Hub <span className="font-mono">{setup.host.trim()}:{setup.port.trim()}</span>
            </>
          ) : (
            "Where is your hub?"
          )}
        </Chip>
        <Chip icon={<KeyRound aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />} open={open === "key"} onToggle={() => toggle("key")}>
          {setup.hasKey ? "API key included" : "Add an API key"}
        </Chip>
      </div>
      {open === "hub" && <HubFields setup={setup} autoFocus />}
      {open === "key" && (
        <KeyField
          setup={setup}
          autoFocus
          hint="From Workspace settings → API Keys. It stays on this page. Without one, the player's page asks for it."
        />
      )}
    </div>
  );
}

/** The page is waiting to hear the player report for the first time, and says so; then that it has. */
export function Listening({ className }: { className?: string }) {
  const { connected } = useProto();
  return (
    <p role="status" className={cx("flex items-center gap-2.5 text-sm", connected ? "text-success" : "text-default-500", className)}>
      <span aria-hidden="true" className="relative grid h-2 w-2 shrink-0 place-items-center">
        {!connected && <span className="setup-ring absolute inset-0 rounded-full bg-primary" />}
        <span className={cx("h-2 w-2 rounded-full", connected ? "bg-success" : "bg-primary")} />
      </span>
      {connected ? `${PLAYER_NAME} is online` : "Listening for your player…"}
    </p>
  );
}

/** What every direction ends on, before the ordinary stage takes over. */
export function Connected() {
  return (
    <div className="space-y-3">
      <Eyebrow tone="success">
        <Check aria-hidden="true" className="h-3.5 w-3.5" /> Player online
      </Eyebrow>
      <h2 className="text-3xl font-bold leading-tight">{PLAYER_NAME} is connected</h2>
      <p className="text-sm leading-snug text-default-500">Slide a cartridge in and give it a label. That's the last thing you'll set up.</p>
    </div>
  );
}

const NO_LOOK = (() => null) as never;

/**
 * The production scene with the slot empty, and the light the real player shows over it: breathing blue while it
 * waits to be set up, steady green once it's online. (The shipped scene has no setup light yet; this overlays one.)
 */
export function Scene({ light, compact = false }: { light: "off" | "setup" | "online"; compact?: boolean }) {
  const color = light === "online" ? "#4ade80" : "#60a5fa";
  return (
    <div className="relative">
      <PlayerScene phase="empty" tag={null} lookOf={NO_LOOK} glow={null} compact={compact} />
      {/* Always drawn and faded, so the light comes on rather than popping in when a step turns it on. */}
      <svg
        viewBox={compact ? VIEWBOX.compact : VIEWBOX.wide}
        className="pointer-events-none absolute inset-0 h-full w-full transition-opacity duration-500"
        style={{ opacity: light === "off" ? 0 : 1 }}
        aria-hidden="true"
      >
        <g className={light === "setup" ? "cp-breathe" : undefined}>
          <circle cx={LED_AT.x} cy={LED_AT.y} r="14" fill={color} opacity="0.28" style={{ transition: "fill 300ms ease" }} />
          <circle cx={LED_AT.x} cy={LED_AT.y} r="2.8" fill={color} style={{ transition: "fill 300ms ease" }} />
        </g>
      </svg>
    </div>
  );
}

/** A phone, drawn small: the Wi-Fi list with the player's network picked, or the player's own setup page. */
export function PhoneMock({ screen, className }: { screen: "wifi" | "page"; className?: string }) {
  const row = "flex items-center justify-between rounded-md px-1.5 py-1 text-[9px] leading-none";
  return (
    <div className={cx("w-[132px] shrink-0 rounded-[22px] bg-default-200 p-1.5 shadow-lg", className)} aria-hidden="true">
      <div className="h-[212px] overflow-hidden rounded-[17px] bg-background p-2">
        <div className="mx-auto mb-2 h-1 w-8 rounded-full bg-default-200" />
        {screen === "wifi" ? (
          <div className="space-y-1">
            <div className="px-1.5 pb-0.5 text-[8px] font-semibold uppercase tracking-wider text-default-400">Wi-Fi</div>
            <div className={cx(row, "text-default-500")}>
              Home
            </div>
            <div className={cx(row, "bg-primary font-semibold text-primary-foreground")}>
              {NETWORK} <Check className="h-2.5 w-2.5" />
            </div>
            <div className={cx(row, "text-default-500")}>Neighbours</div>
            <div className={cx(row, "text-default-500")}>Printer-5G</div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="px-0.5 text-[9px] font-bold">Set up {PLAYER_NAME}</div>
            <div className="rounded-md bg-default-100 px-1.5 py-1 text-[8px] text-default-500">Home ✓</div>
            <div className="rounded-md bg-default-100 px-1.5 py-1 font-mono text-[8px] ring-1 ring-primary">CP1-eyJoIjoi…</div>
            <div className="rounded-full bg-primary py-1 text-center text-[9px] font-semibold text-primary-foreground">Connect</div>
            <div className="space-y-0.5 pt-1 text-[8px] text-default-500">
              <div className="text-success">✓ Joined Home</div>
              <div className="text-success">✓ Plugin answered</div>
              <div>… Saving</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Where the cartridges will be, kept quiet: the first run is about the player. */
export function ShelfTeaser() {
  const { phone } = useProto();
  return (
    <section aria-label="Your cartridges" className="space-y-3">
      <div>
        <h2 className="text-lg font-bold leading-tight">Your cartridges</h2>
        <p className="text-sm text-default-500">They'll line up here as you label them.</p>
      </div>
      <div className={cx("grid gap-3", phone ? "grid-cols-3" : "grid-cols-6")}>
        {Array.from({ length: phone ? 3 : 6 }, (_, i) => (
          <div key={i} className="h-24 rounded-2xl border border-dashed border-default-200" style={{ opacity: 1 - i * 0.16 }} />
        ))}
      </div>
    </section>
  );
}

/** The stage and what sits under it, as the production App lays them out. */
export function Page({ children, below }: { children: ReactNode; below?: ReactNode }) {
  const { phone } = useProto();
  return (
    <div className={cx("cp-deck mx-auto max-w-[1072px] space-y-6", phone ? "px-3 pt-3 pb-10" : "px-6 pt-6 pb-10")}>
      {children}
      {below}
    </div>
  );
}
