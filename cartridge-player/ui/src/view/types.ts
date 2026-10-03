/**
 * The plain rows the view layer works on. The live model maps SDK models onto these once per snapshot (and the
 * simulator builds them directly), so everything in ui/src/view is pure, runs under `node --test`, and never holds a
 * model whose fields change underneath it.
 */

/** An activity as the interface draws it. Archived ones are kept: a cartridge can still carry one. */
export interface ActivityView {
  readonly id: string;
  readonly name: string;
  /** Already resolved from the category when the activity uses its category's colour. */
  readonly color: string;
  /** Null when the app doesn't know the icon: the interface draws a fallback glyph. */
  readonly iconPath: string | null;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly archived: boolean;
  /** A point activity is marked, not started: its cartridge has nothing to stop. */
  readonly point: boolean;
}

export interface CategoryView {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly iconPath: string | null;
}

/** One of the current user's live sessions. */
export interface LiveSession {
  readonly id: string;
  readonly activityId: string;
  /** Epoch ms. */
  readonly startedAt: number;
}

export type ActivityLookup = ReadonlyMap<string, ActivityView>;

/** Activities by id, for lookups that must also find archived ones. */
export function byId(activities: readonly ActivityView[]): ActivityLookup {
  return new Map(activities.map((activity) => [activity.id, activity]));
}
