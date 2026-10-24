import { Button, Tooltip } from "@heroui/react";
import { cn } from "@heroui/theme";
import { RotateCw } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { useModel } from "../model.ts";
import { EASE_IN_OUT } from "../motion.ts";
import { ForgetButton } from "./ForgetButton.tsx";
import { useSettingsGroups } from "./SettingsPanel.tsx";
import { address } from "./format.ts";
import { SwitchRow } from "./SwitchRow.tsx";

function ControllerRow() {
  const model = useModel();
  const reduced = useReducedMotion();
  const [turns, setTurns] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { controller, connection } = model;

  if (!controller) {
    return (
      <div className="text-default-500 text-sm">No controller yet. Pair one and it appears here with its address.</div>
    );
  }
  const name = connection?.name ?? controller.name ?? "Nanoleaf controller";
  const status = connection?.status;
  const dot =
    status === "connected"
      ? "bg-success"
      : status === "connecting"
        ? "bg-warning"
        : status === "unreachable" || status === "unauthorized"
          ? "bg-danger"
          : "bg-default-300";
  const details = [connection?.model ?? controller.model, address(controller.host, controller.port)];
  if (connection?.firmware) details.push(`firmware ${connection.firmware}`);

  const refresh = async () => {
    setTurns((n) => n + 1);
    setRefreshing(true);
    setError(null);
    try {
      await model.actions.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-300", dot)} />
            <span className="truncate font-medium text-sm">{name}</span>
          </div>
          <div className="mt-0.5 truncate text-default-500 text-xs tabular-nums">
            {details.filter(Boolean).join(" · ")}
          </div>
        </div>
        <Tooltip content="Reconnect and read the layout again" delay={400} closeDelay={0}>
          <Button
            isIconOnly
            size="sm"
            variant="flat"
            radius="lg"
            aria-label="Refresh"
            isDisabled={refreshing}
            onPress={refresh}
            className="active:scale-[0.9]"
          >
            {/* One turn per press: feedback that it heard, not a spinner. */}
            <motion.span
              animate={{ transform: `rotate(${turns * 360}deg)` }}
              transition={reduced ? { duration: 0 } : { duration: 0.6, ease: EASE_IN_OUT }}
              className="grid place-items-center"
            >
              <RotateCw className="h-4 w-4" />
            </motion.span>
          </Button>
        </Tooltip>
        <ForgetButton name={name} onForget={model.actions.forget} />
      </div>
      {error && <div className="mt-2 text-danger text-xs">{error}</div>}
    </div>
  );
}

/** Controller details, the switch that lets Drift Beacon drive it, and what the wall does when nothing is going on. */
export function ControllerCard() {
  const { controller, settings, actions } = useModel();
  const { idle, saveError: idleError } = useSettingsGroups();
  const [saveError, setSaveError] = useState<string | null>(null);
  if (!controller) return null;

  const drive = async (enabled: boolean) => {
    setSaveError(null);
    try {
      await actions.saveSettings({ enabled });
    } catch (error) {
      setSaveError(`Couldn't save that: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <section aria-label="Controller" className="rounded-2xl bg-content1 ring-1 ring-default-100">
      <div className="space-y-3 px-4 pt-3.5 pb-4">
        <div className="font-semibold text-[10px] text-default-400 uppercase tracking-wider">Controller</div>
        <ControllerRow />
      </div>
      <div className="border-default-100 border-t p-4">
        <SwitchRow
          label="Drive my Nanoleaf"
          description="Glow in your live activity's colour. Off hands the wall back and leaves it alone."
          value={settings.enabled}
          onChange={(enabled) => void drive(enabled)}
        />
        {saveError && (
          <div role="status" className="mt-2 text-danger text-xs">
            {saveError}
          </div>
        )}
      </div>
      <div className="border-default-100 border-t">
        {idle}
        {idleError && (
          <div role="status" className="-mt-2 px-4 pb-4 text-danger text-xs">
            {idleError}
          </div>
        )}
      </div>
    </section>
  );
}
