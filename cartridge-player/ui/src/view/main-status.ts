/**
 * Whether main runs, as the interface says it. The app's placeholder before its first report reads `unavailable`, so
 * an `unavailable` the page opened with counts as `connecting` until it's confirmed (it changed since, or a few
 * seconds passed): opening the page never flashes "the plugin isn't running".
 */

export type MainStatus =
  | "connecting"
  | "running"
  | "starting"
  | "unavailable"
  | "disabled"
  | "incompatible"
  | "not-installed";

/** How long an `unavailable` the page opened with stays unconfirmed. */
export const STATUS_WAIT_MS = 3000;

export interface StatusLike {
  readonly state: Exclude<MainStatus, "connecting">;
  readonly reason?: string;
}

export function mainStatusOf(
  status: StatusLike | undefined,
  confirmed: boolean,
): { readonly state: MainStatus; readonly reason: string | null } {
  if (!status) return { state: "unavailable", reason: null };
  if (status.state === "unavailable" && !confirmed) return { state: "connecting", reason: null };
  return { state: status.state, reason: status.reason?.trim() || null };
}

/** Changes go through main: while it isn't running (or isn't known to be), the shelf is read-only. */
export function canChange(status: MainStatus): boolean {
  return status === "running";
}

/** The notice for a main that isn't running, or null while it runs or is still being heard from. */
export function mainNotice(status: MainStatus, reason: string | null): { readonly title: string; readonly body: string } | null {
  const after = "Until it's running again, the player can't start anything and labels can't change.";
  switch (status) {
    case "running":
    case "connecting":
      return null;
    case "starting":
      return { title: "Starting up", body: "The plugin is starting on the server; this page follows in a moment." };
    case "unavailable":
      return { title: "The plugin isn't running", body: `${reason ?? "Drift Beacon couldn't run it on the server just now."} ${after}` };
    case "disabled":
      return { title: "The plugin is switched off", body: `Switch Cartridge Player on for this workspace. ${after}` };
    case "incompatible":
      return { title: "This Drift Beacon can't run this version", body: `Update Drift Beacon or the plugin. ${after}` };
    case "not-installed":
      return { title: "The plugin isn't installed here", body: `Install Cartridge Player in this workspace. ${after}` };
  }
}
