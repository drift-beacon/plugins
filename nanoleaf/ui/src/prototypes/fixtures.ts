// Prototype-only fixture data, shaped like what the plugin sees: activity rows with resolved colours and MDI
// `iconPath`s (SDK 0.2.2 rows, with goals, periods and pins), session rows, and controller layouts from
// tests/fixtures. Worst cases on purpose: a very long activity name, colours that aren't hex, a point activity with a
// count goal, another member's sessions and pins, an archived activity the user still has pinned (the wall must ignore
// that pin), and a wall of 30+ mixed panels.

import { layoutFromPanelLayout } from "../../../shared/geometry.ts";
import type { ActivityLike, FoundController, Layout, SessionLike } from "../../../shared/types.ts";

export const ME = "u-rich";
/** Another member of the workspace: their completed sessions count toward shared goals, their pins don't. */
export const SAM = "u-sam";

export const MDI = {
  laptop:
    "M4,6H20V16H4M20,18A2,2 0 0,0 22,16V6C22,4.89 21.1,4 20,4H4C2.89,4 2,4.89 2,6V16A2,2 0 0,0 4,18H0V20H24V18H20Z",
  guitar:
    "M19.59,3H22V5H20.41L16.17,9.24C15.8,8.68 15.32,8.2 14.76,7.83L19.59,3M12,8A4,4 0 0,1 16,12C16,13.82 14.77,15.42 13,15.87V16A5,5 0 0,1 8,21A5,5 0 0,1 3,16A5,5 0 0,1 8,11H8.13C8.58,9.24 10.17,8 12,8M12,10.5A1.5,1.5 0 0,0 10.5,12A1.5,1.5 0 0,0 12,13.5A1.5,1.5 0 0,0 13.5,12A1.5,1.5 0 0,0 12,10.5M6.94,14.24L6.23,14.94L9.06,17.77L9.77,17.06L6.94,14.24Z",
  book: "M12 21.5C10.65 20.65 8.2 20 6.5 20C4.85 20 3.15 20.3 1.75 21.05C1.65 21.1 1.6 21.1 1.5 21.1C1.25 21.1 1 20.85 1 20.6V6C1.6 5.55 2.25 5.25 3 5C4.11 4.65 5.33 4.5 6.5 4.5C8.45 4.5 10.55 4.9 12 6C13.45 4.9 15.55 4.5 17.5 4.5C18.67 4.5 19.89 4.65 21 5C21.75 5.25 22.4 5.55 23 6V20.6C23 20.85 22.75 21.1 22.5 21.1C22.4 21.1 22.35 21.1 22.25 21.05C20.85 20.3 19.15 20 17.5 20C15.8 20 13.35 20.65 12 21.5M12 8V19.5C13.35 18.65 15.8 18 17.5 18C18.7 18 19.9 18.15 21 18.5V7C19.9 6.65 18.7 6.5 17.5 6.5C15.8 6.5 13.35 7.15 12 8Z",
  dumbbell:
    "M20.57,14.86L22,13.43L20.57,12L17,15.57L8.43,7L12,3.43L10.57,2L9.14,3.43L7.71,2L5.57,4.14L4.14,2.71L2.71,4.14L4.14,5.57L2,7.71L3.43,9.14L2,10.57L3.43,12L7,8.43L15.57,17L12,20.57L13.43,22L14.86,20.57L16.29,22L18.43,19.86L19.86,21.29L21.29,19.86L19.86,18.43L22,16.29L20.57,14.86Z",
  pill: "M4.22,11.29L11.29,4.22C13.64,1.88 17.43,1.88 19.78,4.22C22.12,6.56 22.12,10.36 19.78,12.71L12.71,19.78C10.36,22.12 6.56,22.12 4.22,19.78C1.88,17.43 1.88,13.64 4.22,11.29M5.64,12.71C4.59,13.75 4.24,15.24 4.6,16.57L10.59,10.59L14.83,14.83L18.36,11.29C19.93,9.73 19.93,7.2 18.36,5.64C16.8,4.07 14.27,4.07 12.71,5.64L5.64,12.71Z",
  wateringCan:
    "M18.5 7.47C17.76 8.2 17.57 9.25 17.92 10.15L15 13.07V11C15 10.45 14.55 10 14 10H12.97C13 9.83 13 9.67 13 9.5C13 6.46 10.54 4 7.5 4S2 6.46 2 9.5C2 11.21 2.78 12.73 4 13.74V20C4 20.55 4.45 21 5 21H14C14.55 21 15 20.55 15 20V15.89L19.33 11.56C20.23 11.91 21.28 11.73 22 11L18.5 7.47M4.05 10C4.03 9.83 4 9.67 4 9.5C4 7.57 5.57 6 7.5 6S11 7.57 11 9.5C11 9.67 10.97 9.83 10.95 10H4.05Z",
  translate:
    "M12.87,15.07L10.33,12.56L10.36,12.53C12.1,10.59 13.34,8.36 14.07,6H17V4H10V2H8V4H1V6H12.17C11.5,7.92 10.44,9.75 9,11.35C8.07,10.32 7.3,9.19 6.69,8H4.69C5.42,9.63 6.42,11.17 7.67,12.56L2.58,17.58L4,19L9,14L12.11,17.11L12.87,15.07M18.5,10H16.5L12,22H14L15.12,19H19.87L21,22H23L18.5,10M15.88,17L17.5,12.67L19.12,17H15.88Z",
  meditation:
    "M12 4C13.11 4 14 4.89 14 6S13.11 8 12 8 10 7.11 10 6 10.9 4 12 4M21 16V14C18.76 14 16.84 13.04 15.4 11.32L14.06 9.72C13.68 9.26 13.12 9 12.53 9H11.5C10.89 9 10.33 9.26 9.95 9.72L8.61 11.32C7.16 13.04 5.24 14 3 14V16C5.77 16 8.19 14.83 10 12.75V15L6.12 16.55C5.45 16.82 5 17.5 5 18.21C5 19.2 5.8 20 6.79 20H9V19.5C9 18.12 10.12 17 11.5 17H14.5C14.78 17 15 17.22 15 17.5S14.78 18 14.5 18H11.5C10.67 18 10 18.67 10 19.5V20H17.21C18.2 20 19 19.2 19 18.21C19 17.5 18.55 16.82 17.88 16.55L14 15V12.75C15.81 14.83 18.23 16 21 16Z",
  dog: "M18,4C16.29,4 15.25,4.33 14.65,4.61C13.88,4.23 13,4 12,4C11,4 10.12,4.23 9.35,4.61C8.75,4.33 7.71,4 6,4C3,4 1,12 1,14C1,14.83 2.32,15.59 4.14,15.9C4.78,18.14 7.8,19.85 11.5,20V15.72C10.91,15.35 10,14.68 10,14C10,13 12,13 12,13C12,13 14,13 14,14C14,14.68 13.09,15.35 12.5,15.72V20C16.2,19.85 19.22,18.14 19.86,15.9C21.68,15.59 23,14.83 23,14C23,12 21,4 18,4M9,12A1,1 0 0,1 8,11C8,10.46 8.45,10 9,10A1,1 0 0,1 10,11C10,11.56 9.55,12 9,12M15,12A1,1 0 0,1 14,11C14,10.46 14.45,10 15,10A1,1 0 0,1 16,11C16,11.56 15.55,12 15,12Z",
  email:
    "M22 6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6V18C2 19.1 2.9 20 4 20H20C21.1 20 22 19.1 22 18V6M20 6L12 11L4 6H20M20 18H4V8L12 13L20 8V18Z",
} as const;

/**
 * The activities the prototypes use, archived included (as the model carries them), in the app's order; the user's
 * pin among the live ones is set per starting state (`activitiesFor`).
 */
export const ACTIVITIES: readonly ActivityLike[] = [
  {
    id: "deep-work",
    name: "Deep work",
    trackingType: "span",
    color: "#38bdf8",
    iconPath: MDI.laptop,
    archived: false,
    goal: { type: "duration", seconds: 2 * 3600 },
    period: "day",
    pinnedBy: [],
  },
  {
    id: "guitar",
    name: "Guitar practice",
    trackingType: "span",
    color: "#c084fc",
    iconPath: MDI.guitar,
    archived: false,
    goal: { type: "duration", seconds: 3 * 3600 },
    period: "week",
    pinnedBy: [],
  },
  {
    id: "spanish",
    name: "Spanish",
    trackingType: "span",
    color: "#f472b6",
    iconPath: MDI.translate,
    archived: false,
    goal: { type: "duration", seconds: 20 * 60 },
    period: "day",
    pinnedBy: [],
  },
  {
    id: "gym",
    name: "Gym",
    trackingType: "span",
    color: "#4ade80",
    iconPath: MDI.dumbbell,
    archived: false,
    goal: { type: "count", count: 4 },
    period: "week",
    pinnedBy: [SAM],
  },
  {
    id: "plants",
    name: "Water the plants",
    trackingType: "point",
    color: "#2dd4bf",
    iconPath: MDI.wateringCan,
    archived: false,
    goal: { type: "count", count: 3 },
    period: "week",
    pinnedBy: [],
  },
  {
    id: "meditation",
    name: "Meditation",
    trackingType: "span",
    color: "hsl(262 83% 76%)",
    iconPath: MDI.meditation,
    archived: false,
    goal: { type: "duration", seconds: 10 * 60 },
    period: "day",
    pinnedBy: [],
  },
  {
    id: "reading",
    name: "Reading",
    trackingType: "span",
    color: "#fbbf24",
    iconPath: MDI.book,
    archived: false,
    goal: null,
    period: null,
    pinnedBy: [],
  },
  {
    id: "walk",
    name: "Walk the dog",
    trackingType: "span",
    color: "rgb(251 146 60)",
    iconPath: MDI.dog,
    archived: false,
    goal: null,
    period: null,
    pinnedBy: [],
  },
  {
    id: "vitamins",
    name: "Take vitamins",
    trackingType: "point",
    color: "#fb7185",
    iconPath: MDI.pill,
    archived: false,
    goal: null,
    period: null,
    pinnedBy: [],
  },
  {
    id: "landlord",
    name: "Reply to the landlord about the boiler inspection",
    trackingType: "span",
    color: "#94a3b8",
    iconPath: MDI.email,
    archived: false,
    goal: null,
    period: null,
    pinnedBy: [],
  },
  {
    id: "old-project",
    name: "Old project",
    trackingType: "span",
    color: "#f87171",
    iconPath: MDI.laptop,
    archived: true,
    goal: { type: "duration", seconds: 3600 },
    period: "day",
    pinnedBy: [ME],
  },
];

/** The activity SimPanel's `S` starts (it has a goal) and the one `G` starts (it hasn't). */
export const GOAL_ACTIVITY = "deep-work";
export const PLAIN_ACTIVITY = "reading";

/** How a prototype variant opens. */
export type StartState = "live-goal" | "near-goal" | "live" | "pinned" | "idle";

/** Which activity the user has pinned in each starting state (a pin can exist under a live session). */
const PINNED: Record<StartState, string | null> = {
  "live-goal": "spanish",
  "near-goal": null,
  live: "guitar",
  pinned: "guitar",
  idle: null,
};

/** The activities for a starting state: the fixtures with the user's pin applied. */
export function activitiesFor(start: StartState): ActivityLike[] {
  const pinned = PINNED[start];
  return ACTIVITIES.map((a) => (a.id === pinned ? { ...a, pinnedBy: [...(a.pinnedBy ?? []), ME] } : { ...a }));
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let sessionSeq = 0;
/** A fresh session id (the sim adds sessions as the SimPanel starts and ends them). */
export const nextSessionId = () => `s-${++sessionSeq}`;

function span(activityId: string, start: number, minutes: number, members: readonly string[] = [ME]): SessionLike {
  return {
    id: nextSessionId(),
    activityId,
    type: "span",
    status: "completed",
    memberIds: members,
    startedAt: new Date(start),
    endedAt: new Date(start + minutes * MIN),
  };
}

function point(activityId: string, at: number, members: readonly string[] = [ME]): SessionLike {
  return {
    id: nextSessionId(),
    activityId,
    type: "point",
    status: "completed",
    memberIds: members,
    startedAt: new Date(at),
    endedAt: null,
  };
}

/** A live span of `activityId` for the user, started `minutes` ago. */
export function liveSpan(activityId: string, now: number, minutes: number): SessionLike {
  return {
    id: nextSessionId(),
    activityId,
    type: "span",
    status: "live",
    memberIds: [ME],
    startedAt: new Date(now - minutes * MIN),
    endedAt: null,
  };
}

/**
 * History for a starting state, newest first. "Today" sessions are squeezed into today even just after midnight, so
 * the day goals open with the progress the variant promises.
 */
export function sessionsFor(start: StartState, now: number): SessionLike[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const dayStart = midnight.getTime();
  /** A start `minutesAgo` before now, but never before today's first minute. */
  const today = (minutesAgo: number) => Math.max(dayStart + MIN, now - minutesAgo * MIN);

  const sessions: SessionLike[] = [
    // Earlier this week and before: they count for week goals, never for today's.
    span("deep-work", dayStart - DAY + 9 * 60 * MIN, 95),
    span("guitar", dayStart - DAY + 19 * 60 * MIN, 50),
    span("gym", dayStart - DAY + 7 * 60 * MIN, 60),
    span("guitar", dayStart - 2 * DAY + 20 * 60 * MIN, 45),
    span("gym", dayStart - 2 * DAY + 18 * 60 * MIN, 55, [ME, SAM]),
    point("plants", dayStart - 2 * DAY + 8 * 60 * MIN),
    span("reading", dayStart - 3 * DAY + 21 * 60 * MIN, 40),
    // Today.
    span("spanish", today(200), 8),
    span("meditation", today(180), 4),
    point("vitamins", today(170)),
  ];

  if (start === "live-goal") {
    sessions.push(span("deep-work", today(120), 22), span("deep-work", today(90), 10, [SAM]));
    sessions.push(liveSpan("deep-work", now, 20));
  } else if (start === "near-goal") {
    sessions.push(span("deep-work", today(150), 60));
    sessions.push(liveSpan("deep-work", now, 45));
  } else if (start === "live") {
    sessions.push(span("deep-work", today(150), 35));
    sessions.push(liveSpan("reading", now, 12));
  } else if (start === "pinned") {
    sessions.push(span("deep-work", today(150), 48));
  }
  return sortSessions(sessions);
}

/** Newest first, like `ctx.sessions.list()`. */
export function sortSessions(sessions: readonly SessionLike[]): SessionLike[] {
  return [...sessions].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

/* ---- Layouts ---- */

export type LayoutKey = "theduck" | "wings" | "hexagons" | "big";

/** The fixture a controller in the sim reports, with where it lives. */
export interface SimController {
  readonly key: LayoutKey;
  readonly host: string;
  readonly port: number;
  readonly name: string;
  readonly model: string;
  readonly id: string;
}

export const CONTROLLERS: Record<LayoutKey, SimController> = {
  theduck: { key: "theduck", host: "192.168.1.40", port: 16021, name: "The Duck", model: "NL42", id: "S123" },
  wings: { key: "wings", host: "192.168.1.57", port: 16021, name: "Winds", model: "NL42", id: "S123456789" },
  hexagons: {
    key: "hexagons",
    host: "192.168.1.61",
    port: 16021,
    name: "Shapes Honeycomb",
    model: "NL42",
    id: "S19124C0HEX",
  },
  big: { key: "big", host: "192.168.1.23", port: 16021, name: "Shapes Sunrise", model: "NL42", id: "S19124C0BIG" },
};

/** What `discover` finds in the First run variant: two controllers, one over each protocol. */
export const FOUND: readonly FoundController[] = [
  { host: CONTROLLERS.theduck.host, port: 16021, name: "The Duck", model: "NL42", id: "S123", source: "mdns" },
  { host: CONTROLLERS.wings.host, port: 16021, name: "Winds", model: "NL42", id: "S123456789", source: "ssdp" },
];

// Vite eager glob of the layout fixtures (full `GET /` info objects, as the controller answers them).
const FILES = import.meta.glob<unknown>("../../../tests/fixtures/*.json", { eager: true, import: "default" });

/** The layout a sim controller reports, read the way main reads a real one. */
export function layoutFor(key: LayoutKey): Layout {
  const info = FILES[`../../../tests/fixtures/${key}.json`] ?? FILES["../../../tests/fixtures/theduck.json"];
  return layoutFromPanelLayout(info, CONTROLLERS[key].id, new Date().toISOString());
}
