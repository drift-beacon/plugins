import { FACES, type StoredMappings } from './setup.ts';
import { UNCATEGORIZED_ID } from './storage.ts';

/** Where a face's colour comes from: the workspace's activities and categories, as CSS colours. */
export interface PaletteSource {
  activity(id: string): { color: string; archived: boolean } | undefined;
  category(id: string): { color: string } | undefined;
  /** The colour activities without a category take, when there is such an activity. */
  uncategorized(): string | undefined;
}

/** The colour a face stands for: its activity's, or its category's; nothing for an empty face or a missing target. */
export function faceColor(mapping: StoredMappings[string] | undefined, source: PaletteSource): string | null {
  if (!mapping) return null;
  if (mapping.type === 'activity') {
    const activity = source.activity(mapping.id);
    return activity && !activity.archived ? activity.color : null;
  }
  if (mapping.id === UNCATEGORIZED_ID) return source.uncategorized() ?? null;
  return source.category(mapping.id)?.color ?? null;
}

/** The cube's colours for the lights: each mapped face's colour once, in face order. */
export function facePalette(mappings: StoredMappings, source: PaletteSource): string[] {
  const colors: string[] = [];
  const seen = new Set<string>();
  for (const face of FACES) {
    const color = faceColor(mappings[face], source);
    if (!color || seen.has(color.toLowerCase())) continue;
    seen.add(color.toLowerCase());
    colors.push(color);
  }
  return colors;
}
