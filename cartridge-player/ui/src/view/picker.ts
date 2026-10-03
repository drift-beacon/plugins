/**
 * The activity picker's list: categories in the app's order, each with its activities in the app's order, then the
 * activities without a category (the app lists those last too). Archived activities are left out: a cartridge
 * labelled with one starts nothing.
 */
import type { ActivityView, CategoryView } from "./types.ts";

export const UNCATEGORIZED = {
  id: "",
  name: "Uncategorised",
  color: "#6b7280",
  iconPath: "M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z",
} as const satisfies CategoryView;

export interface PickerGroup {
  readonly category: CategoryView;
  readonly activities: readonly ActivityView[];
}

/** Lower case without accents, so "cafe" finds "Café". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Whether an activity matches every word of a query, in its name or its category's. */
export function matches(activity: ActivityView, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = fold(`${activity.name} ${activity.categoryName ?? ""}`);
  return words.every((word) => haystack.includes(word));
}

/** The groups the picker shows for `query`; empty groups are left out. */
export function pickerGroups(
  activities: readonly ActivityView[],
  categories: readonly CategoryView[],
  query = "",
): PickerGroup[] {
  const known = new Set(categories.map((category) => category.id));
  const shown = activities.filter((activity) => !activity.archived && matches(activity, query));
  const groups: PickerGroup[] = categories.map((category) => ({
    category,
    activities: shown.filter((activity) => activity.categoryId === category.id),
  }));
  groups.push({
    category: UNCATEGORIZED,
    activities: shown.filter((activity) => activity.categoryId === null || !known.has(activity.categoryId)),
  });
  return groups.filter((group) => group.activities.length > 0);
}

/** The groups' activities in display order: what the arrow keys walk through. */
export function flatten(groups: readonly PickerGroup[]): ActivityView[] {
  return groups.flatMap((group) => group.activities);
}
