import { ZONE_WORDS } from "../zones/words.ts";

/** What Controls says about a split wall, and whether the swipe rows read as doing nothing. */
export interface SplitWallLines {
  /** Under the switch. */
  readonly touch: string | null;
  /** By the swipe rows. */
  readonly swipe: string | null;
  /** The four swipe rows are dimmed: on a split wall they do nothing until the wall reports where a swipe happens. */
  readonly swipesDimmed: boolean;
}

/**
 * The Controls lines for a wall whose zone cards show (`cards`: more than one zone stands), `split` for touches or not
 * (`isSplit`: two or more zones have panels), with the touch stream `heard` or not. An unsplit wall says nothing new:
 * its gestures act as they always have. While only one zone has panels, a swipe nothing places still acts there, so
 * nothing says swipes do nothing.
 */
export function splitWallLines(cards: boolean, split: boolean, heard: boolean): SplitWallLines {
  if (!cards) return { touch: null, swipe: null, swipesDimmed: false };
  if (heard) return { touch: ZONE_WORDS.touchActsWhere, swipe: ZONE_WORDS.swipesHeard, swipesDimmed: false };
  return {
    touch: ZONE_WORDS.touchActsWhere,
    swipe: split ? ZONE_WORDS.swipesSilent : null,
    swipesDimmed: split,
  };
}
