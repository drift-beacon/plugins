/**
 * Nanoleaf: glows Nanoleaf Shapes in the colour of the user's live activity and fills them towards its goal. onStart
 * wires the Controller (connection, pairing, layout, events) to the Director (scene → frames, hand-back, yield),
 * answers the interface's requests on the private channel (`ctx.ui`) and handles the one declared command, `resume`.
 * It never waits on the device: connecting starts once onStart returns.
 */
import {
  type Activity,
  type CommandCaller,
  definePlugin,
  type MainContext,
  type PluginDefinition,
  PluginError,
  type Session,
} from "@drift-beacon/plugin";
import { readEffect } from "../../shared/effects.ts";
import { DEFAULT_PORT } from "../../shared/storage.ts";
import { type ActivityLike, type FoundController, type SessionLike, STORAGE_KEYS } from "../../shared/types.ts";
import { BRIGHTNESS_INPUT, DISCOVER_INPUT, PAIR_INPUT, PREVIEW_INPUT } from "../../shared/ui-channel.ts";
import { createOwner } from "./claims.ts";
import { Controller, type ControllerTimings } from "./controller.ts";
import { createDirector, type Director, type DirectorTimings } from "./director.ts";
import { assertLanHost, type Lookup } from "./lan.ts";
import { discover } from "./nanoleaf/discovery.ts";
import { EventStream, type Touch } from "./nanoleaf/events.ts";
import { isTransient, NanoleafClient, NanoleafError } from "./nanoleaf/http.ts";
import { ExtControlStream } from "./nanoleaf/stream.ts";
import type { WorkspaceData } from "./ports.ts";

/** Knobs for tests and tools (the emulator's UDP port, shorter timings); production uses the defaults. */
export interface NanoleafPluginOptions {
  /** Where extControl frames go on the controller's host. Default 60222. */
  readonly streamPort?: number;
  /** Per-request timeout for the REST API. Default 4000 ms. */
  readonly requestTimeoutMs?: number;
  readonly director?: Partial<DirectorTimings>;
  readonly controller?: Partial<ControllerTimings>;
  /** Resolves a controller's host name, to check where it leads before connecting. Default: `dns.lookup`. */
  readonly lookup?: Lookup;
  /**
   * Looks for controllers when the paired one stopped answering at its address. Default: SSDP and mDNS for
   * `SEARCH_MS` (discovery.ts); it resolves early when `signal` aborts.
   */
  readonly discover?: (signal: AbortSignal) => Promise<readonly FoundController[]>;
}

/** A `discover` request stops listening this long before its deadline, to answer in time. */
const DISCOVER_MARGIN_MS = 500;
/** How long main listens when it searches for a controller that stopped answering at its address. */
const SEARCH_MS = 2500;
/**
 * The id a development build runs under (`pnpm dev`, or a build Drift Beacon loads from `DEV_PLUGINS_PATH`). Only
 * it may connect to the server's own loopback addresses, which is where the emulator listens.
 */
const DEVELOPMENT_ID = "nanoleaf-dev";

/** A plugin definition with these options; the default export uses none. */
export function createPlugin(options: NanoleafPluginOptions = {}): PluginDefinition {
  return definePlugin({
    onStart(ctx) {
      startNanoleaf(ctx, options);
    },
  });
}

export default createPlugin();

/** Builds and wires one instance. Synchronous: everything slow happens after onStart returns. */
export function startNanoleaf(ctx: MainContext, options: NanoleafPluginOptions = {}): void {
  const { log } = ctx;
  const timeoutMs = options.requestTimeoutMs;
  let controller: Controller | null = null;
  // Only a development build may connect to the server's own loopback addresses (the emulator).
  const allowLoopback = ctx.plugin.id === DEVELOPMENT_ID;

  const director = createDirector({
    userId: ctx.user.id,
    owner: createOwner(`${ctx.user.id}@${ctx.workspace.id}`),
    data: workspaceData(ctx),
    storage: ctx.storage,
    createClient: (config) =>
      new NanoleafClient({ host: config.host, port: config.port, token: config.token, timeoutMs }),
    createStream: (host) =>
      new ExtControlStream(host, {
        port: options.streamPort,
        log: (message, error) => log.warn(message, error),
        // Frames failing (the address moved, the controller went away): check the connection, as REST errors do.
        onError: (error) => controller?.reportError(error),
      }),
    publish: (output) => ctx.state.set("output", output),
    publishControl: (control) => ctx.state.set("control", control),
    log,
    timings: options.director,
    onDeviceError: (error) => controller?.reportError(error),
  });

  const wired = new Controller({
    storage: ctx.storage,
    log,
    createClient: (config) => new NanoleafClient({ ...config, timeoutMs }),
    // Before anything connects: an address off the local network is a mistake (lan.ts), refused with what to enter.
    checkHost: (host, signal) => assertLanHost(host, { allowLoopback, lookup: options.lookup, signal }),
    probe: (host, port, signal) => NanoleafClient.probe(host, port, { signal }),
    requestToken: (host, port, signal) => NanoleafClient.requestToken(host, port, signal),
    openEvents: (eventOptions) => new EventStream(eventOptions),
    discover:
      options.discover ??
      ((signal) => discover({ timeoutMs: SEARCH_MS, signal, log: (message, error) => log.info(message, error) })),
    publish: (info) => ctx.state.set("connection", info),
    onLink: (link) => director.setLink(link),
    onLayout: () => director.update(),
    onDeviceEvent: (event) => director.onDeviceEvent(event),
    onTouch: (touch) => emitTouch(ctx, touch),
    handBack: () => director.handBack(),
    timings: options.controller,
  });
  controller = wired;

  registerRequests(ctx, wired, director);
  ctx.commands.handle("resume", () => {
    director.resume();
  });
  // The lock other plugins and Home Assistant take to put an effect of their own on the wall (P2: under a schedule
  // alert, over the user's own scene). The caller is the holder: nobody names one.
  ctx.commands.handle("takeControl", (input, meta) => {
    const effect = readEffect(input.effect);
    if (typeof effect === "string") throw new PluginError("invalid", effect);
    return director.takeControl(holderOf(meta.caller), effect, input.ttlMs, input.requestId);
  });
  ctx.commands.handle("releaseControl", (input, meta) =>
    director.releaseControl(holderOf(meta.caller), input.leaseId),
  );
  ctx.onDataChange(() => director.update());
  // A schedule fired: the snapshot with its pin came first, so the wall is already on its way to the new scene.
  ctx.schedules.onTriggered((trigger) => {
    director.alert(trigger.activityId);
  });
  ctx.storage.onChange((key) => {
    if (key === STORAGE_KEYS.controller) wired.reload();
    else if (key === STORAGE_KEYS.settings || key === STORAGE_KEYS.order || key === STORAGE_KEYS.layout) {
      director.update();
    }
  });
  ctx.onStop(async () => {
    wired.stop();
    await director.stop();
  });

  director.start();
  wired.start();
}

/**
 * Who holds the lock for a caller: a plugin's manifest id, for its main code and its interface alike, or
 * `integration` for Home Assistant, whose automations all share the one identity.
 */
export function holderOf(caller: CommandCaller): string {
  return caller.kind === "integration" ? "integration" : caller.plugin;
}

/**
 * What the interface asks of main, on the private channel: nothing here is declared in manifest.json, so none of it
 * is a Home Assistant action or reachable from another plugin. Inputs are checked against shared/ui-channel.ts before
 * a handler runs. Device errors become `PluginError`s the interface can explain.
 */
function registerRequests(ctx: MainContext, controller: Controller, director: Director): void {
  const { ui, log } = ctx;
  /**
   * Tells open copies something. A post that can't be sent (the instance is stopping) is logged, not worth failing the
   * request that made it. Nothing reads what `ui.post` returns: who is listening is `ui.clients`.
   */
  const tell = (name: string, post: () => unknown): void => {
    try {
      post();
    } catch (error) {
      log.warn(`Couldn't tell the interface (${name})`, error);
    }
  };

  ui.handle(
    "discover",
    async (input, meta) => {
      const budget = meta.deadline - Date.now() - DISCOVER_MARGIN_MS;
      const timeoutMs = Math.max(500, Math.min(input.timeoutMs ?? 2500, budget));
      const found = await discover({
        timeoutMs,
        signal: meta.signal,
        log: (message, error) => log.info(message, error),
      });
      return {
        controllers: found.map(({ host, port, name, model, id, source }) => ({ host, port, name, model, id, source })),
      };
    },
    { input: DISCOVER_INPUT },
  );

  ui.handle(
    "pair",
    async (input, meta) => {
      const host = input.host.trim();
      if (host === "") throw new PluginError("invalid", "Enter the controller's IP address or host name");
      const asking = { to: meta.client.id };
      const result = await guard(() =>
        controller.pair(host, input.port ?? DEFAULT_PORT, meta.signal, meta.deadline, (step) =>
          tell("pairing", () => ui.post("pairing", { step }, asking)),
        ),
      );
      tell("controllerChanged", () => ui.post("controllerChanged", { change: "paired" }));
      return result;
    },
    { input: PAIR_INPUT },
  );

  ui.handle("forget", async () => {
    await guard(() => controller.forget());
    tell("controllerChanged", () => ui.post("controllerChanged", { change: "forgotten" }));
  });

  ui.handle("refresh", () => guard(() => controller.refresh()));

  // A preview belongs to the copy that asked: its lease ends early when that copy closes (the lease's time limit is
  // the backstop, since a closed copy is reported only after a few seconds).
  ui.handle("preview", (input, meta) => director.preview(input, meta.client.id), { input: PREVIEW_INPUT });
  ui.onClientsChange((clients) => director.endPreviewsExcept(new Set(clients.map((client) => client.id))));

  ui.handle("brightness", (input) => director.brightness(input.value), { input: BRIGHTNESS_INPUT });

  // Main's clock, so the interface can draw a controller's effect at the point the wall has reached.
  ui.handle("clock", () => ({ now: Date.now() }));
}

/**
 * Runs a controller operation; device errors become `PluginError`s: worth trying again later (no answer, a timeout or
 * a 5xx) → `unavailable`, else `failed`.
 */
async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw requestError(error);
  }
}

/**
 * What a request answers for a failure. A device error becomes a `PluginError` the interface can show. Anything else
 * passes through as it is: a `PluginError` keeps its code, a request's own abort reason answers `timeout`, `stopped`
 * or nobody (the interface gave up), and a bug answers the platform's generic `failed` with a reference, its stack
 * in the plugin's console.
 */
export function requestError(error: unknown): unknown {
  if (error instanceof NanoleafError) {
    return new PluginError(isTransient(error) ? "unavailable" : "failed", error.message);
  }
  return error;
}

/**
 * Workspace data as plain rows, remapped only when the SDK hands out a new list. Archived activities are included:
 * a live session of one still glows, as core's live-activity-slot shows it (decideScene ignores archived pins).
 */
function workspaceData(ctx: MainContext): () => WorkspaceData {
  let activityModels: readonly Activity[] | null = null;
  let sessionModels: readonly Session[] | null = null;
  let activities: readonly ActivityLike[] = [];
  let sessions: readonly SessionLike[] = [];
  return () => {
    const nextActivities = ctx.activities.list({ includeArchived: true });
    if (nextActivities !== activityModels) {
      activityModels = nextActivities;
      activities = nextActivities.map((activity) => activity.data);
    }
    const nextSessions = ctx.sessions.list();
    if (nextSessions !== sessionModels) {
      sessionModels = nextSessions;
      sessions = nextSessions.map((session) => session.data);
    }
    return { activities, sessions };
  };
}

/** A panel touch on the wall, for the interface's tap-to-order (`touch` event). */
function emitTouch(ctx: MainContext, touch: Touch): void {
  try {
    ctx.events.emit("touch", { panelId: touch.panelId, gesture: touch.gesture });
  } catch (error) {
    ctx.log.warn("Couldn't send a touch event", error);
  }
}
