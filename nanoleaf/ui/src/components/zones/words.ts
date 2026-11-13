// The words the zone screens add, in one place.

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export const ZONE_WORDS = {
  /* The unsplit wall */
  split: "Split the wall",

  /* Zone cards */
  whose: "Whose zone",
  whoseNew: "Whose zone?",
  everyoneHasOne: "Everyone has a zone already.",
  cancel: "Cancel",
  addZone: "Add a zone",
  removeZone: "Remove zone",
  removed: (first: string) => `Its panels went to ${first}.`,
  done: "Done",
  panels: (n: number) => plural(n, "panel", "panels"),
  noPanels: "No panels yet",
  zonesLabel: "Zones",

  /* Choosing panels */
  choosePanels: "Choose panels",
  choosingFor: (name: string) => `Choosing panels for ${name}`,
  chooseHint: (first: string) => `Tap a panel to bring it here. Tap one of its own to give it back to ${first}.`,

  /* What shows now, per zone */
  live: "Live",
  pinned: "Pinned",
  off: "Off",
  inIt: (names: string, many: boolean) => `${names} ${many ? "are" : "is"} in it`,
  pinnedWhy: (name: string) => `Nothing running for ${name}, so it shows the pin.`,
  offWhy: (name: string) => `Nothing running for ${name}, and nothing pinned.`,
  emptyZone: "No panels, so nothing shows here.",
  noGoal: "No goal",
  notOnWall: (reason: string) => `Not on your wall · ${reason}`,

  /* Fill order */
  orderTitle: "How it fills",

  /* Controls */
  touchActsWhere: "A tap or double tap acts for the zone you touch.",
  swipesSilent: "Swipes do nothing on a split wall until it reports where they happen.",
  swipesHeard: "A swipe acts for the zone it starts in.",
} as const;
