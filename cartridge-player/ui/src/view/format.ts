/**
 * Words and numbers for times. No date library: the browser's Intl does relative times and clock times in the user's
 * own locale, and the rest is arithmetic. Every function takes `now` (and a locale for tests) so nothing reads the
 * clock behind the caller's back: the caller decides how often a label refreshes.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const pad = (n: number) => String(n).padStart(2, "0");

/** A running session's clock: 00:23:14. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / SECOND));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Tracked time, compact: 0m, 45m, 3h 05m, 52h. */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours >= 10 ? `${hours}h` : `${hours}h ${pad(minutes % 60)}m`;
}

/** Tracked time at the start of a sentence: "Under a minute", "52m", "3h 05m". */
export function durationPhrase(ms: number): string {
  return ms < MINUTE ? "Under a minute" : duration(ms);
}

/**
 * How long ago, in words: "just now", "4 minutes ago", "yesterday". Times come from the hub's clock, so one slightly
 * ahead of this browser's counts as now rather than reading "in a few seconds".
 */
export function relative(then: number, now: number, locale?: string): string {
  const ago = Math.max(0, now - then);
  if (ago < 45 * SECOND) return "just now";
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (ago < 45 * MINUTE) return format.format(-Math.max(1, Math.round(ago / MINUTE)), "minute");
  if (ago < 22 * HOUR) return format.format(-Math.round(ago / HOUR), "hour");
  if (ago < 7 * DAY) return format.format(-Math.max(1, Math.round(ago / DAY)), "day");
  if (ago < 35 * DAY) return format.format(-Math.round(ago / (7 * DAY)), "week");
  if (ago < 365 * DAY) return format.format(-Math.max(1, Math.round(ago / (30 * DAY))), "month");
  return format.format(-Math.round(ago / (365 * DAY)), "year");
}

/** How long ago, as a bare short duration for a stat: "now", "5m", "6h", "3d", "5w", "4mo", "2y". */
export function since(then: number, now: number): string {
  const ago = Math.max(0, now - then);
  if (ago < MINUTE) return "now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)}m`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h`;
  if (ago < 14 * DAY) return `${Math.floor(ago / DAY)}d`;
  if (ago < 60 * DAY) return `${Math.floor(ago / (7 * DAY))}w`;
  if (ago < 365 * DAY) return `${Math.floor(ago / (30 * DAY))}mo`;
  return `${Math.floor(ago / (365 * DAY))}y`;
}

/** A time of day in the user's locale: 10:42, or 10:42 am. */
export function timeOfDay(at: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
}

/** An ISO timestamp from storage as epoch ms, or null. Readers already checked it; this only converts. */
export function epoch(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** "1 cartridge", "3 cartridges". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
