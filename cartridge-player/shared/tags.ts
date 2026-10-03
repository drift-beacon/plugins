/**
 * A cartridge's identity: its NFC UID as the player sends it, upper-case hex bytes joined by ":" (4, 7 or 10 bytes,
 * for example "04:A2:3B:1C:7F:5D:80"). `tagMappings` has always been keyed by exactly this text, so every tag that
 * reaches storage goes through `normalizeTag` first: a different spelling of the same UID would orphan its label.
 */
export type Tag = string;

const CANONICAL = /^[0-9A-F]{2}(?::[0-9A-F]{2}){3,9}$/;
const BARE = /^(?:[0-9A-F]{2}){4,10}$/;

/** The canonical form of a UID ("04a23b1c", "04-A2-3B-1C" and " 04:a2:3b:1c " all give "04:A2:3B:1C"), or null. */
export function normalizeTag(value: unknown): Tag | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toUpperCase().replace(/-/g, ":");
  if (CANONICAL.test(text)) return text;
  if (BARE.test(text)) return text.match(/../g)!.join(":");
  return null;
}

/** The first four bytes, for places where the whole UID doesn't fit: "04:A2:3B:1C…". */
export function shortTag(tag: Tag): string {
  const bytes = tag.split(":");
  return bytes.length > 4 ? `${bytes.slice(0, 4).join(":")}…` : tag;
}
