/**
 * The SDK gives every stored object and every published state value a fresh identity on each push (including the echo
 * of a write), and a fresh list of workspace rows whenever any collection changes, so identity can't tell a change.
 * A stable reader keeps its last result while the value is equal as JSON, and stable rows keep each row (and the whole
 * list) while it is, so memoised views below them only recompute when something really changed.
 */

/** Storage and published state are JSON, so serialising says whether two values are the same. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function stableReader<T>(read: (raw: unknown) => T): (raw: unknown) => T {
  let last: { readonly raw: unknown; readonly value: T } | null = null;
  return (raw) => {
    if (last && last.raw === raw) return last.value;
    const next = read(raw);
    const value = last && jsonEqual(last.value, next) ? last.value : next;
    last = { raw, value };
    return value;
  };
}

/**
 * Rows by id, each kept while its value is equal as JSON, and the list itself kept while every row is (in the same
 * order). The SDK replaces every list when any workspace collection changes (a session starting anywhere rebuilds the
 * activities), which would otherwise re-render everything keyed on a row.
 */
export function stableRows<T extends { readonly id: string }>(): (rows: readonly T[]) => readonly T[] {
  let last: readonly T[] = [];
  return (rows) => {
    const before = new Map(last.map((row) => [row.id, row]));
    const next = rows.map((row) => {
      const kept = before.get(row.id);
      return kept !== undefined && jsonEqual(kept, row) ? kept : row;
    });
    if (next.length === last.length && next.every((row, index) => row === last[index])) return last;
    last = next;
    return next;
  };
}
