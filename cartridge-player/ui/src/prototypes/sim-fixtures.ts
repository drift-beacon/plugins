// Prototype-only: the workspace and storage the simulator starts from, shaped exactly like what the live model reads
// (shared/storage.ts records, view rows). Worst cases on purpose: a very long name, a deleted activity, an archived
// one, a point activity, activities without a category or an icon, a cartridge never played.
import { emptyPlayerRecord, type HistoryEntry, type PlayerRecord } from "../../../shared/storage.ts";
import type { ActivityView, CategoryView } from "../view/types.ts";
import { MDI } from "./player/fixtures.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEVICE = { id: "cp-a1b2c3", name: "Cartridge-A1B2", fw: "2.0.0", hubHost: "192.168.1.12:9001" } as const;
export const API_PATH = "/api/plugins/cartridge-player-dev/api";

export const CATEGORIES: CategoryView[] = [
  { id: "work", name: "Work", color: "#60a5fa", iconPath: MDI.briefcase },
  { id: "health", name: "Health", color: "#34d399", iconPath: MDI.run },
  { id: "creative", name: "Creative", color: "#f472b6", iconPath: MDI.palette },
  { id: "learning", name: "Learning", color: "#fbbf24", iconPath: MDI.bookshelf },
  { id: "home", name: "Home", color: "#fb923c", iconPath: MDI.home },
  { id: "rest", name: "Rest", color: "#a78bfa", iconPath: MDI.night },
];

function act(id: string, name: string, categoryId: string | null, iconPath: string | null, extra: Partial<ActivityView> = {}): ActivityView {
  const category = CATEGORIES.find((c) => c.id === categoryId) ?? null;
  return {
    id,
    name,
    color: category?.color ?? "#94a3b8",
    iconPath,
    categoryId,
    categoryName: category?.name ?? null,
    archived: false,
    point: false,
    ...extra,
  };
}

/** In the app's order: by category, then uncategorised last. */
export const ACTIVITIES: ActivityView[] = [
  act("deep-work", "Deep work", "work", MDI.laptop),
  act("side-project", "Side project", "work", MDI.codeTags),
  act("landlord", "Reply to the landlord about the boiler inspection", "work", MDI.email),
  act("gym", "Gym", "health", MDI.weightLifter),
  act("yoga", "Yoga", "health", MDI.yoga),
  act("walk", "Walk the dog", "health", MDI.dog),
  act("water", "Glass of water", "health", MDI.sprout, { point: true }),
  act("guitar", "Guitar practice", "creative", MDI.guitar),
  act("piano", "Piano", "creative", MDI.piano),
  act("sketch", "Sketchbook", "creative", MDI.brush),
  act("spanish", "Spanish", "learning", MDI.translate),
  act("reading", "Reading", "learning", MDI.book),
  act("cook", "Cook dinner", "home", MDI.chefHat),
  act("garden", "Garden", "home", MDI.sprout),
  act("meditate", "Meditation", "rest", MDI.meditation),
  act("games", "Video games", "rest", MDI.gamepad, { archived: true }),
  act("nap", "Nap", "rest", MDI.sleep),
  act("tax", "Tax return", null, null, { color: "#e2e8f0" }),
  act("errands", "Errands", null, MDI.home, { color: "#f97316" }),
];

/** The labelled library: tag, activity ("deleted-activity" stands in for one removed), last seen ago, plays, minutes. */
const LIBRARY: [string, string, number | null, number, number][] = [
  ["04:A2:3B:1C:7F:5D:80", "deep-work", 23 * MIN, 48, 3125],
  ["04:C4:58:2E:61:0B:80", "gym", 6 * HOUR, 30, 1618],
  ["04:19:E6:52:33:71:80", "guitar", DAY + 3 * HOUR, 21, 634],
  ["04:7B:0C:D1:9A:22:81", "reading", 3 * DAY, 17, 891],
  ["04:88:F2:6C:4B:D0:81", "meditate", 5 * DAY, 26, 392],
  ["04:3D:91:A7:15:E8:80", "spanish", 16 * DAY, 9, 181],
  ["04:5E:27:B9:C3:04:80", "landlord", 31 * DAY, 1, 12],
  ["04:E1:6A:0F:92:37:81", "deleted-activity", 64 * DAY, 3, 94],
  ["04:2F:D4:83:5A:6E:80", "games", null, 0, 0],
  ["04:6C:11:9E:2B:47:80", "water", 2 * DAY, 12, 0],
];

/** Cartridges with fresh stickers the player has never seen. */
export const BLANK_TAGS = ["04:9C:41:E7:08:B3:81", "04:61:BD:2A:F5:1C:80", "04:0A:73:C8:4E:95:81", "04:D7:20:5B:A9:6F:80"];

/** Labelled cartridges the panel's Insert cycles through. */
export const KNOWN_TAGS = LIBRARY.map(([tag]) => tag);

export type StartState = "playing" | "first-run" | "empty-shelf" | "big" | "seen";

const iso = (ms: number) => new Date(ms).toISOString();

export interface SimStart {
  readonly mappings: Record<string, string>;
  readonly record: PlayerRecord;
  /** The session the slot's cartridge started, if it's live. */
  readonly live: { readonly id: string; readonly activityId: string; readonly startedAt: number }[];
}

/** Where a variant starts. */
export function simStart(state: StartState, now = Date.now()): SimStart {
  const record = emptyPlayerRecord();
  if (state === "first-run") return { mappings: {}, record, live: [] };

  const mappings: Record<string, string> = {};
  const cartridges: Record<string, { seenAt: string | null; plays: number; playedMs: number }> = {};
  const library =
    state === "big"
      ? Array.from({ length: 60 }, (_, i): [string, string, number | null, number, number] => [
          `04:${(0x10 + i).toString(16).toUpperCase().padStart(2, "0")}:5A:${(0xc0 + (i % 50)).toString(16).toUpperCase()}:21:7E:80`,
          ACTIVITIES[i % ACTIVITIES.length].id,
          i * 3 * HOUR,
          (i * 7) % 41,
          ((i * 37) % 900) + 5,
        ])
      : state === "empty-shelf"
        ? []
        : LIBRARY;
  for (const [tag, activityId, ago, plays, minutes] of library) {
    mappings[tag] = activityId;
    cartridges[tag] = { seenAt: ago === null ? null : iso(now - ago), plays, playedMs: minutes * MIN };
  }

  const playing = state === "playing";
  const startedAt = now - 23 * MIN - 14_000;
  const history: HistoryEntry[] = [];
  let nextId = 1;
  const push = (entry: Omit<HistoryEntry, "id" | "deviceId">) => history.unshift({ ...entry, id: nextId++, deviceId: DEVICE.id });
  push({ at: iso(now - 6 * HOUR), kind: "insert", tag: KNOWN_TAGS[1], activityId: "gym", sessionId: "s-gym", durationMs: null });
  push({ at: iso(now - 5.1 * HOUR), kind: "eject", tag: KNOWN_TAGS[1], activityId: "gym", sessionId: "s-gym", durationMs: 54 * MIN });
  if (playing) push({ at: iso(startedAt), kind: "insert", tag: KNOWN_TAGS[0], activityId: "deep-work", sessionId: "s-1", durationMs: null });

  const unknown =
    state === "seen"
      ? [
          { tag: BLANK_TAGS[2], firstSeenAt: iso(now - 2 * DAY), lastSeenAt: iso(now - 2 * DAY) },
          { tag: BLANK_TAGS[3], firstSeenAt: iso(now - 9 * DAY), lastSeenAt: iso(now - 40 * HOUR) },
        ]
      : [];

  return {
    mappings,
    live: playing ? [{ id: "s-1", activityId: "deep-work", startedAt }] : [],
    record: {
      ...record,
      devices: {
        [DEVICE.id]: {
          id: DEVICE.id,
          name: DEVICE.name,
          fw: DEVICE.fw,
          boot: 1234,
          seq: 7,
          slot: playing
            ? { tag: KNOWN_TAGS[0], since: iso(startedAt), activityId: "deep-work", sessionId: "s-1", outcome: "started", error: null }
            : null,
          lastHeardAt: iso(now - 2 * MIN),
          hubHost: DEVICE.hubHost,
        },
      },
      active: DEVICE.id,
      unknown,
      cartridges,
      history,
      nextId,
    },
  };
}
