/** Joins class names, skipping falsy ones. No merging: components don't pass conflicting utilities. */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
