/**
 * Where focus stands when choosing panels starts or ends, for the wall section to decide whether to move it. Focus
 * moves only when it is lost (nothing focused, or on an element gone or on its way out), or when the person ended
 * choosing with Escape from the drawing or its banner (the panels stop being buttons). Never from another live
 * control: an end the person didn't make (the zone removed elsewhere, the grace run out) leaves focus where it is.
 */
export function focusIsLost(el: Element | null, body: Element | null): boolean {
  return !el || el === body || !el.isConnected || el.closest("[data-exiting]") !== null;
}

/** Whether focus moves to the next control once choosing has ended (`lost`: `focusIsLost`). */
export function refocusAfterEnd(lost: boolean, endedByEscapeFromDrawing: boolean): boolean {
  return lost || endedByEscapeFromDrawing;
}

/** The open overlays an Escape belongs to first (popovers, menus, list boxes, dialogs). */
export const OVERLAY = '[role="dialog"], [role="menu"], [role="listbox"], [data-overlay]';

/**
 * Whether an Escape ends choosing: not one an open popover or menu has already taken (it prevented the default) or
 * that was pressed inside one.
 */
export function escapeEndsChoosing(defaultPrevented: boolean, inOverlay: boolean): boolean {
  return !defaultPrevented && !inOverlay;
}
