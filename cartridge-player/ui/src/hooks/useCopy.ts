import { type RefObject, useCallback, useEffect, useState } from "react";

/** What the last copy did: nothing yet, it worked, or the text is selected for the user to copy themselves. */
export type CopyState = "idle" | "copied" | "selected";

/**
 * Copies a field's text. A built interface runs in a sandboxed iframe where the clipboard can be refused, and the hub
 * is often plain http where `navigator.clipboard` doesn't exist, so this only reports "copied" when a copy succeeded:
 * the async clipboard, else the older `execCommand("copy")` on the selected field, else the field is left selected
 * and the caller says how to copy it by hand.
 */
export function useCopy(field: RefObject<HTMLInputElement | HTMLTextAreaElement | null>) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state !== "copied") return;
    const id = window.setTimeout(() => setState("idle"), 1600);
    return () => window.clearTimeout(id);
  }, [state]);

  const copy = useCallback(async () => {
    const input = field.current;
    if (!input) return;
    try {
      if (!navigator.clipboard) throw new Error("No async clipboard");
      await navigator.clipboard.writeText(input.value);
      setState("copied");
      return;
    } catch {
      // Fall through to the selection.
    }
    input.focus();
    input.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    setState(copied ? "copied" : "selected");
  }, [field]);

  const reset = useCallback(() => setState("idle"), []);
  return { state, copy, reset };
}
