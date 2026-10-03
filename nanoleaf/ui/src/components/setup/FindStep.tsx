import { Button, Input } from "@heroui/react";
import { cn } from "@heroui/theme";
import { ChevronRight, Hexagon, Info, Keyboard, RotateCw } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FoundController } from "../../../../shared/types.ts";
import { useModel } from "../../model.ts";
import { EASE_OUT, SPRING_POP, SPRING_SETTLE } from "../../motion.ts";
import { address } from "../format.ts";
import { parseAddress } from "./address.ts";

/** The controller the user chose: found on the network, or typed in (then name and model are unknown). */
export interface PairTarget {
  readonly host: string;
  readonly port: number;
  readonly name: string | null;
  readonly model: string | null;
}

type Search =
  | { readonly state: "listening" }
  | { readonly state: "done" }
  | { readonly state: "failed"; readonly error: string };

/** Where each found controller shows on the radar: spread round the dial, never on top of each other. */
function blip(i: number): { x: number; y: number } {
  const angle = ((-50 + i * 137.5) * Math.PI) / 180;
  const r = 0.34 + ((i * 0.17) % 0.12);
  return { x: 50 + Math.cos(angle) * r * 100, y: 50 + Math.sin(angle) * r * 100 };
}

/** A radar that sweeps while the server listens; controllers land on it as they answer. */
function Radar({ listening, found }: { listening: boolean; found: number }) {
  const reduced = useReducedMotion();
  return (
    <div className="relative h-28 w-28 shrink-0" aria-hidden>
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
        {[48, 34, 20].map((r) => (
          <circle
            key={r}
            cx={50}
            cy={50}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={0.6}
            className="text-default-200"
          />
        ))}
        {listening &&
          [0, 1, 2].map((i) => (
            <circle
              key={i}
              className="nl-echo text-primary"
              cx={50}
              cy={50}
              r={48}
              fill="none"
              stroke="currentColor"
              strokeWidth={0.8}
            />
          ))}
      </svg>
      <AnimatePresence>
        {listening && (
          <motion.div
            key="sweep"
            className="absolute inset-0 overflow-hidden rounded-full"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.3 } }}
          >
            <div
              className="nl-sweep absolute inset-0 rounded-full"
              style={{
                background:
                  "conic-gradient(from 0deg, transparent 0deg 290deg, " +
                  "hsl(var(--heroui-primary) / 0.05) 300deg, hsl(var(--heroui-primary) / 0.4) 360deg)",
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <span className="absolute top-1/2 left-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" />
      {Array.from({ length: found }, (_, i) => {
        const p = blip(i);
        return (
          <motion.span
            key={i}
            className="absolute size-2.5 rounded-full bg-foreground shadow-[0_0_10px_hsl(var(--heroui-primary)/0.6)]"
            style={{ left: `calc(${p.x}% - 5px)`, top: `calc(${p.y}% - 5px)` }}
            initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "scale(0.4)" }}
            animate={{ opacity: 1, transform: "scale(1)" }}
            transition={reduced ? { duration: 0.2 } : { ...SPRING_POP, delay: i * 0.08 }}
          />
        );
      })}
    </div>
  );
}

function FoundCard({ controller, index, onPick }: { controller: FoundController; index: number; onPick(): void }) {
  const reduced = useReducedMotion();
  const details = [controller.model, address(controller.host, controller.port)].filter(Boolean).join(" · ");
  return (
    <motion.button
      layout
      type="button"
      onClick={onPick}
      initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      exit={{ opacity: 0, transition: { duration: 0.12, ease: EASE_OUT } }}
      transition={{ duration: 0.25, ease: EASE_OUT, delay: Math.min(index, 6) * 0.05, layout: SPRING_SETTLE }}
      className={cn(
        "group flex w-full items-center gap-3 rounded-2xl bg-content1 p-3 text-left ring-1 ring-default-100",
        "transition-[box-shadow] duration-150 hover:ring-default-300 focus-visible:ring-2 focus-visible:ring-primary",
      )}
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-default-100 text-default-600">
        <Hexagon className="h-5 w-5" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-sm">{controller.name ?? "Nanoleaf controller"}</span>
        <span className="block truncate text-default-500 text-xs tabular-nums">{details}</span>
      </span>
      <span className="flex items-center gap-1 text-default-400 text-xs transition-colors group-hover:text-foreground">
        <span className="hidden @sm:inline">Pair</span>
        <ChevronRight className="h-4 w-4 transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
      </span>
    </motion.button>
  );
}

interface FindStepProps {
  onPick(target: PairTarget): void;
  /** Open with the address field showing, filled in (changing a controller's address). */
  readonly initialAddress?: string;
  /** What earlier searches found, kept by the flow so coming Back doesn't empty the list. */
  readonly found: readonly FoundController[];
  onFound(found: readonly FoundController[]): void;
}

/**
 * Step 1: find the controller. Discovery starts at once and the radar sweeps while it listens; what answers lands
 * as cards. Typing an address always works too (and is the only way from inside the Home Assistant add-on). A search
 * that is replaced or left behind is given up in main too, and one that failed runs again by itself once main is
 * back in touch.
 */
export function FindStep({ onPick, initialAddress, found, onFound }: FindStepProps) {
  const model = useModel();
  const reduced = useReducedMotion();
  const [search, setSearch] = useState<Search>({ state: "listening" });
  const foundRef = useRef(found);
  foundRef.current = found;
  const [manual, setManual] = useState(initialAddress !== undefined);
  const [text, setText] = useState(initialAddress ?? "");
  const [error, setError] = useState<string | null>(null);
  /** The search under way: starting another, or leaving, aborts it (main stops listening too). */
  const running = useRef<AbortController | null>(null);

  const discover = useCallback(async () => {
    running.current?.abort();
    const mine = new AbortController();
    running.current = mine;
    setSearch({ state: "listening" });
    try {
      const answers = await model.actions.discover(2500, mine.signal);
      if (mine.signal.aborted) return;
      // Keep what was found before in place; add newcomers at the end.
      const byHost = new Map(foundRef.current.map((c) => [`${c.host}:${c.port}`, c]));
      for (const c of answers) byHost.set(`${c.host}:${c.port}`, c);
      onFound([...byHost.values()]);
      setSearch({ state: "done" });
    } catch (e) {
      if (mine.signal.aborted) return;
      setSearch({ state: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }, [model.actions, onFound]);

  useEffect(() => {
    void discover();
    return () => running.current?.abort();
  }, [discover]);

  // Main is back in touch (it restarted, or the connection was made again): a search that failed is worth another go.
  const failed = search.state === "failed";
  const { onResync } = model;
  useEffect(() => {
    if (!failed) return;
    return onResync(() => void discover());
  }, [failed, onResync, discover]);

  const submit = () => {
    const parsed = parseAddress(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onPick({ host: parsed.host, port: parsed.port, name: null, model: null });
  };

  const listening = search.state === "listening";
  const title = listening
    ? "Looking for controllers…"
    : found.length
      ? found.length === 1
        ? "Found a controller"
        : `Found ${found.length} controllers`
      : search.state === "failed"
        ? "Couldn't search the network"
        : "No controllers answered";
  const body = listening
    ? "Drift Beacon's server is listening on your network for Nanoleaf controllers."
    : found.length
      ? "Pick yours to pair with it."
      : search.state === "failed"
        ? search.error
        : "Check the controller is on and on the same network as the Drift Beacon server, or enter its address.";

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4 sm:gap-5">
        <Radar listening={listening} found={found.length} />
        <div className="min-w-0" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={title}
              initial={reduced ? { opacity: 0 } : { opacity: 0, filter: "blur(2px)", transform: "translateY(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)", transform: "translateY(0px)" }}
              exit={{ opacity: 0, filter: "blur(2px)", transition: { duration: 0.12 } }}
              transition={{ duration: 0.2, ease: EASE_OUT }}
            >
              <h3 className="font-semibold text-lg leading-tight">{title}</h3>
              <p className="mt-1 text-default-500 text-sm leading-snug">{body}</p>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {found.length > 0 && (
        <div className="grid gap-2 @xl:grid-cols-2">
          <AnimatePresence initial={false} mode="popLayout">
            {found.map((c, i) => (
              <FoundCard
                key={`${c.host}:${c.port}`}
                controller={c}
                index={i}
                onPick={() => onPick({ host: c.host, port: c.port, name: c.name, model: c.model })}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="flat"
          radius="lg"
          isDisabled={listening}
          startContent={<RotateCw className={cn("h-3.5 w-3.5")} />}
          onPress={() => void discover()}
          className="active:scale-[0.97]"
        >
          Search again
        </Button>
        {!manual && (
          <Button
            size="sm"
            variant="flat"
            radius="lg"
            startContent={<Keyboard className="h-3.5 w-3.5" />}
            onPress={() => setManual(true)}
            className="active:scale-[0.97]"
          >
            Enter address
          </Button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {manual && (
          <motion.div
            key="manual"
            className="overflow-hidden"
            initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0, transition: { duration: 0.15, ease: EASE_OUT } }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
          >
            <div className="flex items-start gap-2 pt-1">
              <Input
                autoFocus
                size="sm"
                label="Controller address"
                placeholder="192.168.1.40"
                description={error ? undefined : "Add :port if it isn't 16021."}
                value={text}
                onValueChange={(v) => {
                  setText(v);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  }
                }}
                isInvalid={error !== null}
                errorMessage={error ?? undefined}
                autoComplete="off"
                spellCheck="false"
                classNames={{ input: "tabular-nums" }}
              />
              <Button
                color="primary"
                radius="lg"
                className="h-12 shrink-0 font-medium active:scale-[0.97]"
                onPress={submit}
              >
                Pair
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <p className="flex gap-2 text-default-400 text-xs leading-relaxed">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Running Drift Beacon as a Home Assistant add-on? Discovery can't see your network from inside it, so enter the
          controller's address: your router's device list or the Nanoleaf app's device info shows it.
        </span>
      </p>
    </div>
  );
}
