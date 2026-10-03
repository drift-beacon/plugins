import { Check, Copy } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { useCopy } from "../../hooks/useCopy.ts";
import { cx } from "../../lib/cx.ts";
import { Button } from "../kit.tsx";

/** How to copy a selected field by hand, on this device. */
function copyByHand(): string {
  if (window.matchMedia("(pointer: coarse)").matches) return "touch and hold it, then choose Copy";
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "press ⌘C to copy it" : "press Ctrl+C to copy it";
}

/**
 * A value to copy into something else: the whole value in a read-only field (selectable, scrolls sideways rather than
 * cutting it off) beside the step's main button, which only says Copied when the copy worked. When the frame's
 * sandbox refuses the clipboard, the value is left selected with how to copy it by hand. `onCopied` is told of a copy
 * that really happened, never of a refused one.
 */
export function CopyField({
  value,
  label,
  action,
  onCopied,
}: {
  value: string;
  /** What the field holds, for its accessible name: "Setup code". */
  label: string;
  /** The button's words: "Copy code". */
  action: string;
  onCopied?(): void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const hint = useId();
  const { state, copy, reset } = useCopy(field);
  const copied = state === "copied";
  const told = useRef(onCopied);
  told.current = onCopied;
  useEffect(() => {
    if (copied) told.current?.();
  }, [copied]);
  return (
    <div>
      <div className="flex items-center gap-2 rounded-2xl bg-default-100 p-1.5 pl-3">
        <input
          ref={field}
          readOnly
          value={value}
          aria-label={label}
          aria-describedby={state === "selected" ? hint : undefined}
          onFocus={(event) => event.currentTarget.select()}
          onChange={reset}
          className="min-w-0 flex-1 truncate bg-transparent font-mono text-sm text-foreground outline-none"
        />
        <Button
          tone="primary"
          icon={copied ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
          onClick={() => void copy()}
        >
          {copied ? "Copied" : action}
        </Button>
      </div>
      <p id={hint} role="status" className={cx("mt-1 text-xs text-default-500", state !== "selected" && "sr-only")}>
        {state === "selected" ? `This page can't copy for you. It's selected: ${copyByHand()}.` : copied ? "Copied." : ""}
      </p>
    </div>
  );
}
