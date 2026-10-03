// Prototype-only fixture data, shaped like what the plugin sees: activities with resolved colours and MDI
// `iconPath`s, NFC UIDs formatted the way the player firmware sends them (upper-case hex pairs joined by ':').
// Worst cases on purpose: a very long activity name, a cartridge whose activity was deleted, one never played.

export const MDI = {
  briefcase:
    "M10,2H14A2,2 0 0,1 16,4V6H20A2,2 0 0,1 22,8V19A2,2 0 0,1 20,21H4C2.89,21 2,20.1 2,19V8C2,6.89 2.89,6 4,6H8V4C8,2.89 8.89,2 10,2M14,6V4H10V6H14Z",
  run: "M13.5,5.5C14.59,5.5 15.5,4.58 15.5,3.5C15.5,2.38 14.59,1.5 13.5,1.5C12.39,1.5 11.5,2.38 11.5,3.5C11.5,4.58 12.39,5.5 13.5,5.5M9.89,19.38L10.89,15L13,17V23H15V15.5L12.89,13.5L13.5,10.5C14.79,12 16.79,13 19,13V11C17.09,11 15.5,10 14.69,8.58L13.69,7C13.29,6.38 12.69,6 12,6C11.69,6 11.5,6.08 11.19,6.08L6,8.28V13H8V9.58L9.79,8.88L8.19,17L3.29,16L2.89,18L9.89,19.38Z",
  palette:
    "M17.5,12A1.5,1.5 0 0,1 16,10.5A1.5,1.5 0 0,1 17.5,9A1.5,1.5 0 0,1 19,10.5A1.5,1.5 0 0,1 17.5,12M14.5,8A1.5,1.5 0 0,1 13,6.5A1.5,1.5 0 0,1 14.5,5A1.5,1.5 0 0,1 16,6.5A1.5,1.5 0 0,1 14.5,8M9.5,8A1.5,1.5 0 0,1 8,6.5A1.5,1.5 0 0,1 9.5,5A1.5,1.5 0 0,1 11,6.5A1.5,1.5 0 0,1 9.5,8M6.5,12A1.5,1.5 0 0,1 5,10.5A1.5,1.5 0 0,1 6.5,9A1.5,1.5 0 0,1 8,10.5A1.5,1.5 0 0,1 6.5,12M12,3A9,9 0 0,0 3,12A9,9 0 0,0 12,21A1.5,1.5 0 0,0 13.5,19.5C13.5,19.11 13.35,18.76 13.11,18.5C12.88,18.23 12.73,17.88 12.73,17.5A1.5,1.5 0 0,1 14.23,16H16A5,5 0 0,0 21,11C21,6.58 16.97,3 12,3Z",
  home: "M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z",
  night:
    "M17.75,4.09L15.22,6.03L16.13,9.09L13.5,7.28L10.87,9.09L11.78,6.03L9.25,4.09L12.44,4L13.5,1L14.56,4L17.75,4.09M21.25,11L19.61,12.25L20.2,14.23L18.5,13.06L16.8,14.23L17.39,12.25L15.75,11L17.81,10.95L18.5,9L19.19,10.95L21.25,11M18.97,15.95C19.8,15.87 20.69,17.05 20.16,17.8C19.84,18.25 19.5,18.67 19.08,19.07C15.17,23 8.84,23 4.94,19.07C1.03,15.17 1.03,8.83 4.94,4.93C5.34,4.53 5.76,4.17 6.21,3.85C6.96,3.32 8.14,4.21 8.06,5.04C7.79,7.9 8.75,10.87 10.95,13.06C13.14,15.26 16.1,16.22 18.97,15.95M17.33,17.97C14.5,17.81 11.7,16.64 9.53,14.5C7.36,12.31 6.2,9.5 6.04,6.68C3.23,9.82 3.34,14.64 6.35,17.66C9.37,20.67 14.19,20.78 17.33,17.97Z",
  bookshelf: "M9 3V18H12V3H9M12 5L16 18L19 17L15 4L12 5M5 5V18H8V5H5M3 19V21H21V19H3Z",
  laptop: "M4,6H20V16H4M20,18A2,2 0 0,0 22,16V6C22,4.89 21.1,4 20,4H4C2.89,4 2,4.89 2,6V16A2,2 0 0,0 4,18H0V20H24V18H20Z",
  codeTags: "M14.6,16.6L19.2,12L14.6,7.4L16,6L22,12L16,18L14.6,16.6M9.4,16.6L4.8,12L9.4,7.4L8,6L2,12L8,18L9.4,16.6Z",
  email:
    "M22 6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6V18C2 19.1 2.9 20 4 20H20C21.1 20 22 19.1 22 18V6M20 6L12 11L4 6H20M20 18H4V8L12 13L20 8V18Z",
  weightLifter:
    "M12 5C10.89 5 10 5.89 10 7S10.89 9 12 9 14 8.11 14 7 13.11 5 12 5M22 1V6H20V4H4V6H2V1H4V3H20V1H22M15 11.26V23H13V18H11V23H9V11.26C6.93 10.17 5.5 8 5.5 5.5L5.5 5H7.5L7.5 5.5C7.5 8 9.5 10 12 10S16.5 8 16.5 5.5L16.5 5H18.5L18.5 5.5C18.5 8 17.07 10.17 15 11.26Z",
  yoga: "M13 2C11.9 2 11 2.9 11 4C11 5.11 11.9 6 13 6C14.11 6 15 5.11 15 4C15 2.9 14.11 2 13 2M4 7V9H10V15L4.93 20.07L6.34 21.5L13.06 14.77L17 17.13V21H19V16.57C19 16.21 18.82 15.89 18.5 15.71L15 13.6V9H21V7H4Z",
  dog: "M18,4C16.29,4 15.25,4.33 14.65,4.61C13.88,4.23 13,4 12,4C11,4 10.12,4.23 9.35,4.61C8.75,4.33 7.71,4 6,4C3,4 1,12 1,14C1,14.83 2.32,15.59 4.14,15.9C4.78,18.14 7.8,19.85 11.5,20V15.72C10.91,15.35 10,14.68 10,14C10,13 12,13 12,13C12,13 14,13 14,14C14,14.68 13.09,15.35 12.5,15.72V20C16.2,19.85 19.22,18.14 19.86,15.9C21.68,15.59 23,14.83 23,14C23,12 21,4 18,4M4.15,13.87C3.65,13.75 3.26,13.61 3,13.5C3.25,10.73 5.2,6.4 6.05,6C6.59,6 7,6.06 7.37,6.11C5.27,8.42 4.44,12.04 4.15,13.87M9,12A1,1 0 0,1 8,11C8,10.46 8.45,10 9,10A1,1 0 0,1 10,11C10,11.56 9.55,12 9,12M15,12A1,1 0 0,1 14,11C14,10.46 14.45,10 15,10A1,1 0 0,1 16,11C16,11.56 15.55,12 15,12M19.85,13.87C19.56,12.04 18.73,8.42 16.63,6.11C17,6.06 17.41,6 17.95,6C18.8,6.4 20.75,10.73 21,13.5C20.75,13.61 20.36,13.75 19.85,13.87Z",
  guitar:
    "M19.59,3H22V5H20.41L16.17,9.24C15.8,8.68 15.32,8.2 14.76,7.83L19.59,3M12,8A4,4 0 0,1 16,12C16,13.82 14.77,15.42 13,15.87V16A5,5 0 0,1 8,21A5,5 0 0,1 3,16A5,5 0 0,1 8,11H8.13C8.58,9.24 10.17,8 12,8M12,10.5A1.5,1.5 0 0,0 10.5,12A1.5,1.5 0 0,0 12,13.5A1.5,1.5 0 0,0 13.5,12A1.5,1.5 0 0,0 12,10.5M6.94,14.24L6.23,14.94L9.06,17.77L9.77,17.06L6.94,14.24Z",
  piano:
    "M20 2H4C2.9 2 2 2.9 2 4V20C2 21.11 2.9 22 4 22H20C21.11 22 22 21.11 22 20V4C22 2.9 21.11 2 20 2M14.74 14H15V20H9V14H9.31C9.86 14 10.3 13.56 10.3 13V4H13.75V13C13.75 13.56 14.19 14 14.74 14M4 4H6.8V13C6.8 13.56 7.24 14 7.79 14H8V20H4V4M20 20H16V14H16.26C16.81 14 17.25 13.56 17.25 13V4H20V20Z",
  brush:
    "M20.71,4.63L19.37,3.29C19,2.9 18.35,2.9 17.96,3.29L9,12.25L11.75,15L20.71,6.04C21.1,5.65 21.1,5 20.71,4.63M7,14A3,3 0 0,0 4,17C4,18.31 2.84,19 2,19C2.92,20.22 4.5,21 6,21A4,4 0 0,0 10,17A3,3 0 0,0 7,14Z",
  translate:
    "M12.87,15.07L10.33,12.56L10.36,12.53C12.1,10.59 13.34,8.36 14.07,6H17V4H10V2H8V4H1V6H12.17C11.5,7.92 10.44,9.75 9,11.35C8.07,10.32 7.3,9.19 6.69,8H4.69C5.42,9.63 6.42,11.17 7.67,12.56L2.58,17.58L4,19L9,14L12.11,17.11L12.87,15.07M18.5,10H16.5L12,22H14L15.12,19H19.87L21,22H23L18.5,10M15.88,17L17.5,12.67L19.12,17H15.88Z",
  book:
    "M12 21.5C10.65 20.65 8.2 20 6.5 20C4.85 20 3.15 20.3 1.75 21.05C1.65 21.1 1.6 21.1 1.5 21.1C1.25 21.1 1 20.85 1 20.6V6C1.6 5.55 2.25 5.25 3 5C4.11 4.65 5.33 4.5 6.5 4.5C8.45 4.5 10.55 4.9 12 6C13.45 4.9 15.55 4.5 17.5 4.5C18.67 4.5 19.89 4.65 21 5C21.75 5.25 22.4 5.55 23 6V20.6C23 20.85 22.75 21.1 22.5 21.1C22.4 21.1 22.35 21.1 22.25 21.05C20.85 20.3 19.15 20 17.5 20C15.8 20 13.35 20.65 12 21.5M12 8V19.5C13.35 18.65 15.8 18 17.5 18C18.7 18 19.9 18.15 21 18.5V7C19.9 6.65 18.7 6.5 17.5 6.5C15.8 6.5 13.35 7.15 12 8M13 11.5C14.11 10.82 15.6 10.5 17.5 10.5C18.41 10.5 19.26 10.59 20 10.78V9.23C19.13 9.08 18.29 9 17.5 9C15.73 9 14.23 9.28 13 9.84V11.5M17.5 11.67C15.79 11.67 14.29 11.93 13 12.46V14.15C14.11 13.5 15.6 13.16 17.5 13.16C18.54 13.16 19.38 13.24 20 13.4V11.9C19.13 11.74 18.29 11.67 17.5 11.67M20 14.57C19.13 14.41 18.29 14.33 17.5 14.33C15.67 14.33 14.17 14.6 13 15.13V16.82C14.11 16.16 15.6 15.83 17.5 15.83C18.54 15.83 19.38 15.91 20 16.07V14.57Z",
  chefHat:
    "M12.5,1.5C10.73,1.5 9.17,2.67 8.67,4.37C8.14,4.13 7.58,4 7,4A4,4 0 0,0 3,8C3,9.82 4.24,11.41 6,11.87V19H19V11.87C20.76,11.41 22,9.82 22,8A4,4 0 0,0 18,4C17.42,4 16.86,4.13 16.33,4.37C15.83,2.67 14.27,1.5 12.5,1.5M12,10.5H13V17.5H12V10.5M9,12.5H10V17.5H9V12.5M15,12.5H16V17.5H15V12.5M6,20V21A1,1 0 0,0 7,22H18A1,1 0 0,0 19,21V20H6Z",
  sprout:
    "M2,22V20C2,20 7,18 12,18C17,18 22,20 22,20V22H2M11.3,9.1C10.1,5.2 4,6.1 4,6.1C4,6.1 4.2,13.9 9.9,12.7C9.5,9.8 8,9 8,9C10.8,9 11,12.4 11,12.4V17C11.3,17 11.7,17 12,17C12.3,17 12.7,17 13,17V12.8C13,12.8 13,8.9 16,7.9C16,7.9 14,10.9 14,12.9C21,13.6 21,4 21,4C21,4 12.1,3 11.3,9.1Z",
  meditation:
    "M12 4C13.11 4 14 4.89 14 6S13.11 8 12 8 10 7.11 10 6 10.9 4 12 4M21 16V14C18.76 14 16.84 13.04 15.4 11.32L14.06 9.72C13.68 9.26 13.12 9 12.53 9H11.5C10.89 9 10.33 9.26 9.95 9.72L8.61 11.32C7.16 13.04 5.24 14 3 14V16C5.77 16 8.19 14.83 10 12.75V15L6.12 16.55C5.45 16.82 5 17.5 5 18.21C5 19.2 5.8 20 6.79 20H9V19.5C9 18.12 10.12 17 11.5 17H14.5C14.78 17 15 17.22 15 17.5S14.78 18 14.5 18H11.5C10.67 18 10 18.67 10 19.5V20H17.21C18.2 20 19 19.2 19 18.21C19 17.5 18.55 16.82 17.88 16.55L14 15V12.75C15.81 14.83 18.23 16 21 16Z",
  gamepad:
    "M7,6H17A6,6 0 0,1 23,12A6,6 0 0,1 17,18C15.22,18 13.63,17.23 12.53,16H11.47C10.37,17.23 8.78,18 7,18A6,6 0 0,1 1,12A6,6 0 0,1 7,6M6,9V11H4V13H6V15H8V13H10V11H8V9H6M15.5,12A1.5,1.5 0 0,0 14,13.5A1.5,1.5 0 0,0 15.5,15A1.5,1.5 0 0,0 17,13.5A1.5,1.5 0 0,0 15.5,12M18.5,9A1.5,1.5 0 0,0 17,10.5A1.5,1.5 0 0,0 18.5,12A1.5,1.5 0 0,0 20,10.5A1.5,1.5 0 0,0 18.5,9Z",
  sleep:
    "M23,12H17V10L20.39,6H17V4H23V6L19.62,10H23V12M15,16H9V14L12.39,10H9V8H15V10L11.62,14H15V16M7,20H1V18L4.39,14H1V12H7V14L3.62,18H7V20Z",
  nfc: "M18,6H13A2,2 0 0,0 11,8V10.28C10.41,10.62 10,11.26 10,12A2,2 0 0,0 12,14C13.11,14 14,13.1 14,12C14,11.26 13.6,10.62 13,10.28V8H16V16H8V8H10V6H8L6,6V18H18M20,20H4V4H20M20,2H4A2,2 0 0,0 2,4V20A2,2 0 0,0 4,22H20C21.11,22 22,21.1 22,20V4C22,2.89 21.11,2 20,2Z",
};

export interface FxCategory {
  id: string;
  name: string;
  color: string;
  iconPath: string;
}

export interface FxActivity {
  id: string;
  name: string;
  categoryId: string;
  color: string;
  iconPath: string;
}

export const CATEGORIES: FxCategory[] = [
  { id: "work", name: "Work", color: "#60a5fa", iconPath: MDI.briefcase },
  { id: "health", name: "Health", color: "#34d399", iconPath: MDI.run },
  { id: "creative", name: "Creative", color: "#f472b6", iconPath: MDI.palette },
  { id: "learning", name: "Learning", color: "#fbbf24", iconPath: MDI.bookshelf },
  { id: "home", name: "Home", color: "#fb923c", iconPath: MDI.home },
  { id: "rest", name: "Rest", color: "#a78bfa", iconPath: MDI.night },
];

const act = (id: string, name: string, categoryId: string, iconPath: string): FxActivity => ({
  id,
  name,
  categoryId,
  iconPath,
  color: CATEGORIES.find((c) => c.id === categoryId)!.color,
});

export const ACTIVITIES: FxActivity[] = [
  act("deep-work", "Deep work", "work", MDI.laptop),
  act("side-project", "Side project", "work", MDI.codeTags),
  act("landlord", "Reply to the landlord about the boiler inspection", "work", MDI.email),
  act("gym", "Gym", "health", MDI.weightLifter),
  act("yoga", "Yoga", "health", MDI.yoga),
  act("walk", "Walk the dog", "health", MDI.dog),
  act("guitar", "Guitar practice", "creative", MDI.guitar),
  act("piano", "Piano", "creative", MDI.piano),
  act("sketch", "Sketchbook", "creative", MDI.brush),
  act("spanish", "Spanish", "learning", MDI.translate),
  act("reading", "Reading", "learning", MDI.book),
  act("cook", "Cook dinner", "home", MDI.chefHat),
  act("garden", "Garden", "home", MDI.sprout),
  act("meditate", "Meditation", "rest", MDI.meditation),
  act("games", "Video games", "rest", MDI.gamepad),
  act("nap", "Nap", "rest", MDI.sleep),
];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface FxCartridge {
  tag: string;
  /** The mapped activity; "deleted-activity" stands in for one removed from the workspace. */
  activityId: string;
  /** How long ago it was last in the player; null = never. */
  lastSeenAgo: number | null;
  plays: number;
  minutes: number;
}

/** The labelled library (`tagMappings` + `lastSeen`), plus play stats the UI can derive from sessions. */
export const LIBRARY: FxCartridge[] = [
  { tag: "04:A2:3B:1C:7F:5D:80", activityId: "deep-work", lastSeenAgo: 23 * MIN, plays: 48, minutes: 3125 },
  { tag: "04:C4:58:2E:61:0B:80", activityId: "gym", lastSeenAgo: 6 * HOUR, plays: 30, minutes: 1618 },
  { tag: "04:19:E6:52:33:71:80", activityId: "guitar", lastSeenAgo: 1 * DAY + 3 * HOUR, plays: 21, minutes: 634 },
  { tag: "04:7B:0C:D1:9A:22:81", activityId: "reading", lastSeenAgo: 3 * DAY, plays: 17, minutes: 891 },
  { tag: "04:88:F2:6C:4B:D0:81", activityId: "meditate", lastSeenAgo: 5 * DAY, plays: 26, minutes: 392 },
  { tag: "04:3D:91:A7:15:E8:80", activityId: "spanish", lastSeenAgo: 16 * DAY, plays: 9, minutes: 181 },
  { tag: "04:5E:27:B9:C3:04:80", activityId: "landlord", lastSeenAgo: 31 * DAY, plays: 1, minutes: 12 },
  { tag: "04:E1:6A:0F:92:37:81", activityId: "deleted-activity", lastSeenAgo: 64 * DAY, plays: 3, minutes: 94 },
  { tag: "04:2F:D4:83:5A:6E:80", activityId: "games", lastSeenAgo: null, plays: 0, minutes: 0 },
];

/** Cartridges with fresh NFC stickers that the player has never seen. */
export const BLANK_TAGS = ["04:9C:41:E7:08:B3:81", "04:61:BD:2A:F5:1C:80", "04:0A:73:C8:4E:95:81"];

/** The deck is mid-session when the page opens: Deep work has been in the player for 23 minutes. */
export const INITIAL_SLOT = { tag: "04:A2:3B:1C:7F:5D:80", startedAgo: 23 * MIN + 14_000 };

export const PLUGIN_PATH = "/api/plugins/cartridge-player-dev/api";

export const activityById = (id: string | null | undefined) => ACTIVITIES.find((a) => a.id === id) ?? null;
export const categoryById = (id: string | null | undefined) => CATEGORIES.find((c) => c.id === id) ?? null;
