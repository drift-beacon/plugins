/**
 * Where a radio group's selection moves for a key (roving tabindex): arrows step to the next or previous choice,
 * wrapping; Home and End jump to the ends. Null for any other key, so the caller leaves the event alone.
 */
export function rovingStep(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
