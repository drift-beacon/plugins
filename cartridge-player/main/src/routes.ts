/**
 * The HTTP routes under `ctx.plugin.apiPath` (DESIGN.md "Main"): the player's report and probe, and `cube-preset`.
 * Domain refusals are answered 200 with what happened (a 404 or 500 would read as "wrong path" or "hub broken" to a
 * player); only a malformed body is a 400. Every report is logged in one line, never with the key (handlers never see
 * it), except a heartbeat that changed nothing: one arrives from every player every 30 s.
 */
import type { MainContext, RouteRequest, RouteResponse } from "@drift-beacon/plugin";
import { type ErrorReply, PROTOCOL, parseReport, probeReply, ROUTES } from "../../shared/protocol.ts";
import type { Player } from "./player.ts";

/** How long a player waits before retrying a report main failed on. */
const FAILED_RETRY_MS = 5000;
const HOST = /^[A-Za-z0-9.:[\]-]{1,255}$/;

/** The address a device reached the hub at (its Host header), offered when setting up another player. */
export function hubHostOf(request: RouteRequest): string | null {
  const host = request.headers.host?.trim();
  return host && HOST.test(host) ? host : null;
}

/** Codes from a peer command that mean it didn't run: try again later. */
const DID_NOT_RUN = new Set(["not-installed", "disabled", "incompatible", "unavailable", "unsupported", "loop"]);

/** The status `cube-preset` answers a failed `selectPreset` with, by `PluginError` code. */
export function cubePresetStatus(code: string | undefined): number {
  if (code === "not-found") return 404;
  if (code === "invalid") return 400;
  if (code !== undefined && DID_NOT_RUN.has(code)) return 503;
  // timeout, stopped, failed and anything unknown: it may have run.
  return 504;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Registers every route. Synchronous, and the probe touches nothing: a player can check its settings at once. */
export function registerRoutes(ctx: MainContext, player: Player): void {
  const { log } = ctx;

  ctx.routes.get(ROUTES.report, () => ({ body: probeReply() }));

  ctx.routes.post(ROUTES.report, async (request): Promise<RouteResponse> => {
    const parsed = parseReport(request.body);
    if (!parsed.ok) {
      log.warn(`Refused a player report: ${parsed.error}`);
      const body: ErrorReply = { ok: false, v: PROTOCOL, code: "bad_request", error: parsed.error };
      return { status: 400, body };
    }
    const report = parsed.value;
    const what = `Player ${report.device.id} (${report.reason} #${report.seq}): ${report.tag ?? "empty"}`;
    try {
      const reply = await player.report(report, hubHostOf(request));
      if (!reply.ok) {
        log.warn(`${what} → retry: ${reply.error}`);
        return { status: 503, body: reply };
      }
      if (reply.result !== "unchanged" || report.reason !== "heartbeat") {
        log.info(`${what} → ${reply.result}${reply.activity ? ` (${reply.activity})` : ""}`);
      }
      return { body: reply };
    } catch (error) {
      log.error(`${what} → failed`, error);
      const body: ErrorReply = {
        ok: false,
        v: PROTOCOL,
        code: "retry",
        error: "The plugin couldn't apply the report",
        retry_ms: FAILED_RETRY_MS,
      };
      return { status: 503, body };
    }
  });

  // POST <apiPath>/cube-preset { preset }: switch the Magic Cube's preset (a command it provides).
  ctx.routes.post(ROUTES.cubePreset, async ({ body }): Promise<RouteResponse> => {
    const preset = isRecord(body) ? body.preset : undefined;
    if (typeof preset !== "string" && preset !== null) {
      return { status: 400, body: { success: false, error: "Expected { preset: string | null }" } };
    }
    try {
      const result = await ctx.plugins.get("magic-cube").command("selectPreset", { preset });
      return { body: { success: true, ...(isRecord(result) ? result : {}) } };
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Couldn't select the cube preset (${code ?? "error"})`, message);
      return { status: cubePresetStatus(code), body: { success: false, code, error: message } };
    }
  });
}
