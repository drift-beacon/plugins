import { motion, useReducedMotionConfig } from "motion/react";
import { memo } from "react";
import { cx } from "../../lib/cx.ts";
import { SPRING_POP } from "../../motion.ts";
import { INK_LIGHT, sticker, STICKER_SHADE } from "../../view/color.ts";
import { type LibraryItem, sameItem } from "../../view/library.ts";
import { Icon } from "../Icon.tsx";

/** How much of its sticker's colour is left on the ghost of the cartridge that's in the player. */
const GHOST_OPACITY = 0.35;

interface ShelfCartridgeProps {
  readonly item: LibraryItem;
  /** "6 hours ago", or null if never played: worked out by the shelf, so a card re-renders only when its words change. */
  readonly lastSeen: string | null;
  readonly played: string;
  readonly label: string;
  /** It was just relabelled from the shelf: its sticker lands with a pop. */
  readonly fresh: boolean;
  readonly open: boolean;
  onOpen(tag: string, button: HTMLButtonElement): void;
}

/**
 * One cartridge on the shelf, drawn as the object: a dark shell with grip dots and its sticker in the activity's
 * colour, with text in whichever ink reads on that colour. The one in the player is a dashed ghost of itself: only
 * its sticker's colour fades, and its name stays at full strength in the theme's own text colours, since it sits on
 * the page now rather than on the sticker.
 */
export const ShelfCartridge = memo(function ShelfCartridge({ item, lastSeen, played, label, fresh, open, onOpen }: ShelfCartridgeProps) {
  const reduced = useReducedMotionConfig();
  const { activity } = item;
  const paint = activity ? sticker(activity.color) : null;
  const ghost = item.inSlot;

  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-cartridge={item.tag}
      onClick={(event) => onOpen(item.tag, event.currentTarget)}
      className="cp-lift cp-press group block w-full rounded-2xl text-left"
    >
      <div
        className={cx("cp-shell relative rounded-2xl p-2.5 pt-3", item.inSlot && "outline-1 outline-dashed outline-default-300 -outline-offset-1")}
        data-ghost={item.inSlot || undefined}
      >
        <div className="mx-auto mb-2.5 flex w-9 justify-between" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className={cx("h-1 w-2.5 rounded-full", item.inSlot ? "bg-default-200" : "bg-black/30")} />
          ))}
        </div>
        <motion.div
          key={`${item.tag}-${item.activityId}`}
          initial={fresh ? (reduced ? { opacity: 0 } : { opacity: 0, transform: "scale(1.08) rotate(-5deg)" }) : false}
          animate={{ opacity: 1, transform: "scale(1) rotate(0deg)" }}
          transition={fresh && !reduced ? SPRING_POP : { duration: 0.2 }}
          className="relative aspect-[4/5] overflow-hidden rounded-xl"
          style={{ color: ghost ? undefined : (paint?.ink ?? INK_LIGHT) }}
        >
          <div
            className="absolute inset-0 transition-opacity duration-200"
            style={{
              opacity: ghost ? GHOST_OPACITY : 1,
              background: paint
                ? `linear-gradient(145deg, ${paint.from}, ${paint.to})`
                : "repeating-linear-gradient(135deg, #3f3f46 0 8px, #36363c 8px 16px)",
            }}
          >
            <div className="absolute inset-0 bg-black" style={{ opacity: STICKER_SHADE }} />
          </div>
          {activity ? (
            <>
              {activity.categoryName && (
                <span
                  className={cx(
                    "absolute inset-x-2.5 top-2 truncate text-[10px] font-semibold uppercase tracking-[0.12em]",
                    ghost ? "text-default-500" : "opacity-75",
                  )}
                >
                  {activity.categoryName}
                </span>
              )}
              {/* The ghost's centre belongs to its "In the player" pill. */}
              {!ghost && (
                <Icon path={activity.iconPath} className="absolute top-[44%] left-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 drop-shadow" />
              )}
              <span
                className={cx(
                  "absolute inset-x-2.5 bottom-2 line-clamp-2 text-sm font-semibold leading-tight [overflow-wrap:anywhere]",
                  ghost && "text-foreground",
                )}
              >
                {activity.name}
              </span>
            </>
          ) : (
            !ghost && (
              <div className="absolute inset-0 grid place-items-center p-3 text-center">
                <div>
                  <div className="text-sm font-semibold text-[#fca5a5]">Activity deleted</div>
                  <div className="text-xs text-[#d4d4d8]">Relabel</div>
                </div>
              </div>
            )
          )}
          {fresh && <span className="cp-shine" aria-hidden="true" />}
        </motion.div>
        {item.inSlot && (
          <span className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 flex-col items-center gap-1">
            <span className="flex items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground">
              {item.live && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />}
              In the player
            </span>
            {!activity && <span className="rounded-full bg-background/90 px-2 py-0.5 text-[11px] text-danger">Activity deleted</span>}
          </span>
        )}
      </div>
      <div className="mt-2 flex justify-between gap-2 px-1 text-xs text-default-500">
        <span className="truncate">{activity?.archived ? "Archived" : (lastSeen ?? "Never played")}</span>
        {item.playedMs > 0 && <span className="shrink-0 tabular-nums">{played}</span>}
      </div>
    </button>
  );
}, sameCard);

function sameCard(a: ShelfCartridgeProps, b: ShelfCartridgeProps): boolean {
  return (
    sameItem(a.item, b.item) &&
    a.lastSeen === b.lastSeen &&
    a.played === b.played &&
    a.label === b.label &&
    a.fresh === b.fresh &&
    a.open === b.open &&
    a.onOpen === b.onOpen
  );
}
