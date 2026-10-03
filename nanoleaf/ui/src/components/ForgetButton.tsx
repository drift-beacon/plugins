import { Button, Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { useState } from "react";
import { EASE_OUT } from "../motion.ts";

/** HeroUI's popover, on the motion standard: a quick scale-in from the trigger, a quicker exit. */
export const POP_MOTION = {
  variants: {
    enter: { opacity: 1, scale: 1, transition: { duration: 0.18, ease: EASE_OUT } },
    exit: { opacity: 0, scale: 0.96, transition: { duration: 0.12, ease: EASE_OUT } },
  },
};

interface ForgetButtonProps {
  readonly name: string;
  onForget(): Promise<void>;
  readonly size?: "sm" | "md";
  readonly variant?: "flat" | "light";
}

/**
 * Forget the controller, after a confirmation in place (the sandbox has no `confirm()`). It hands the wall back and
 * revokes the token, so it asks first and says what pairing again will take.
 */
export function ForgetButton({ name, onForget, size = "sm", variant = "flat" }: ForgetButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forget = async () => {
    setBusy(true);
    setError(null);
    try {
      await onForget();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      isOpen={open}
      onOpenChange={setOpen}
      placement="bottom-end"
      offset={8}
      triggerScaleOnOpen={false}
      shouldBlockScroll={false}
      motionProps={POP_MOTION}
      classNames={{ content: "rounded-2xl bg-content1 p-0 shadow-2xl ring-1 ring-default-200" }}
    >
      <PopoverTrigger>
        <Button size={size} variant={variant} radius="lg" className="active:scale-[0.97]">
          Forget
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="w-64 space-y-3 p-3.5">
          <div>
            <div className="font-semibold text-sm">Forget {name}?</div>
            <p className="mt-1 text-default-500 text-xs leading-relaxed">
              The wall goes back to its own scene and this plugin's access is revoked. To use it again you'll pair
              again, holding its power button.
            </p>
            {error && <p className="mt-2 text-danger text-xs">{error}</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="light" onPress={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" color="danger" isLoading={busy} onPress={forget}>
              Forget
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
