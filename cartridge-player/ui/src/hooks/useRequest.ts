import { useCallback, useEffect, useRef, useState } from "react";
import { requestError } from "../view/errors.ts";

/** A failed request: the sentence to show, and what was thrown (for a control that knows more about it). */
interface Failure {
  readonly message: string;
  readonly cause: unknown;
}

/**
 * One control's request to main: whether it's running, and its failure as a sentence (`error`) with what was thrown
 * (`cause`). `run` resolves to the result, or to undefined when it failed (the error is shown, not thrown), and
 * ignores presses while one is in flight.
 */
export function useRequest() {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async <T,>(request: () => Promise<T>): Promise<T | undefined> => {
    if (busy.current) return undefined;
    busy.current = true;
    setPending(true);
    setFailure(null);
    try {
      return await request();
    } catch (cause) {
      if (mounted.current) setFailure({ message: requestError(cause), cause });
      return undefined;
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);

  return { run, pending, error: failure?.message ?? null, cause: failure?.cause };
}
