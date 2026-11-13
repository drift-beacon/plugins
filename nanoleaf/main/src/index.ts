/**
 * Nanoleaf: glows Nanoleaf Shapes in the colour of a live activity and fills them towards its goal. One instance runs
 * per workspace; the wall follows the member chosen in the interface (storage `zones`), else the owner, or is split
 * into zones that each follow one member (shared/zones.ts). onStart
 * wires the Controller (connection, pairing, layout, events) to the Director (scene → frames, hand-back, yield),
 * answers the interface's requests on the private channel (`ctx.ui`) and handles the declared commands: `resume`, the
 * wall's lock for other plugins and Home Assistant, and the two brightness settings (brightness.ts).
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
import { isIP } from "node:net";
import { actingFor, speaksTo } from "../../shared/acting-for.ts";
import { readEffect } from "../../shared/effects.ts";
import { touchZone } from "../../shared/gestures.ts";
import { DEFAULT_PORT, readSettings, readZones } from "../../shared/storage.ts";
import { type ActivityLike, type FoundController, type SessionLike, STORAGE_KEYS } from "../../shared/types.ts";
import {
  BRIGHTNESS_INPUT,
  DISCOVER_INPUT,
  NUMBERING_INPUT,
  PAIR_INPUT,
  PREVIEW_INPUT,
  type TouchStreamInfo,
} from "../../shared/ui-channel.ts";
import { isSplit } from "../../shared/zones.ts";
import { brightnessState, saveBrightness } from "./brightness.ts";
import { createOwner } from "./claims.ts";
import { Controller, type ControllerTimings, type EventsHandle } from "./controller.ts";
import { createDirector, type Director, type DirectorTimings } from "./director.ts";
import { createGestures, type GestureActions, type GestureTarget } from "./gestures.ts";
import { assertLanHost, type Lookup } from "./lan.ts";
import { discover } from "./nanoleaf/discovery.ts";
import { EventStream, type EventStreamOptions, type Touch } from "./nanoleaf/events.ts";
import { isTransient, NanoleafClient, NanoleafError } from "./nanoleaf/http.ts";
import { ExtControlStream } from "./nanoleaf/stream.ts";
import { TouchStream, type TouchStreamOptions } from "./nanoleaf/touch-stream.ts";
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
   * `SEARCH_MS` (discovery.ts, through the hub's mDNS when it has one); it resolves early when `signal` aborts.
   */
  readonly discover?: (signal: AbortSignal) => Promise<readonly FoundController[]>;
}

/** Discovery for this instance (discovery.ts): listens for `listenMs`, or until `signal` aborts. */
type Find = (listenMs: number, signal: AbortSignal) => Promise<FoundController[]>;

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
  // Discovery browses mDNS through the hub (`ctx.discovery.mdns`, SDK 0.2.11) when this Drift Beacon has it, and with
  // its own query otherwise. `said` holds what it has told this instance's console once.
  const mdns = ctx.discovery?.mdns ?? null;
  const said = new Set<string>();
  const find: Find = (listenMs, signal) =>
    discover({ timeoutMs: listenMs, signal, mdns, said, log: (message, error) => log.info(message, error) });

  const director = createDirector({
    owner: createOwner(ctx.workspace.id),
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

  // Open copies of the interface that are numbering panels (tap to order): their taps on the wall are numbers.
  const numbering = new Set<string>();
  const onGesture = createGestures({
    following: followingOf(ctx),
    settings: () => readSettings(ctx.storage.get(STORAGE_KEYS.settings)),
    data: workspaceData(ctx),
    // Tap to order and the zone-editing preview take the wall's taps for themselves.
    drafting: () => director.drafting || director.editingZones || numbering.size > 0,
    actions: gestureActions(ctx),
    log,
    // Where each gesture acts, for the Controls screen: the `touch` event can't say for a swipe (its panel is -1).
    onZone: (gesture, zoneId) => {
      try {
        ctx.ui.post("gestureZone", { gesture, zoneId });
      } catch (error) {
        log.warn("Couldn't tell the interface (gestureZone)", error);
      }
    },
  });
  const touch = touchStreams(ctx);

  const wired = new Controller({
    storage: ctx.storage,
    log,
    createClient: (config) => new NanoleafClient({ ...config, timeoutMs }),
    // Before anything connects: an address off the local network is a mistake (lan.ts), refused with what to enter.
    checkHost: (host, signal) => assertLanHost(host, { allowLoopback, lookup: options.lookup, signal }),
    probe: (host, port, signal) => NanoleafClient.probe(host, port, { signal }),
    requestToken: (host, port, signal) => NanoleafClient.requestToken(host, port, signal),
    openEvents: (eventOptions) => touch.open(eventOptions),
    discover: options.discover ?? ((signal) => find(SEARCH_MS, signal)),
    publish: (info) => ctx.state.set("connection", info),
    onLink: (link) => director.setLink(link),
    onLayout: () => director.update(),
    onDeviceEvent: (event) => director.onDeviceEvent(event),
    onTouch: (event) => {
      emitTouch(ctx, event);
      void onGesture(event.gesture, gestureTarget(event, director, touch.current()));
    },
    handBack: () => director.handBack(),
    timings: options.controller,
  });
  controller = wired;

  registerRequests(ctx, wired, director, find, numbering, touch.info);
  ctx.commands.handle("resume", () => {
    director.resume();
  });
  // The lock other plugins and Home Assistant take to put an effect of their own on the wall (P2: under a schedule
  // alert, over the workspace's own scene). The caller is the holder, a plugin or Home Assistant, never a member: it
  // starts or names nobody's sessions.
  ctx.commands.handle("takeControl", (input, meta) => {
    const effect = readEffect(input.effect);
    if (typeof effect === "string") throw new PluginError("invalid", effect);
    return director.takeControl(holderOf(meta.caller), effect, input.ttlMs, input.requestId);
  });
  ctx.commands.handle("releaseControl", (input, meta) =>
    director.releaseControl(holderOf(meta.caller), input.leaseId),
  );
  ctx.commands.handle("setSessionBrightness", (input) => saveBrightness(ctx.storage, "session", input.brightness));
  ctx.commands.handle("setPinnedBrightness", (input) => saveBrightness(ctx.storage, "pinned", input.brightness));
  const publishBrightness = () =>
    ctx.state.set("brightness", brightnessState(readSettings(ctx.storage.get(STORAGE_KEYS.settings))));
  // Bound by the brightness controls: published before onStart returns, then on every change of the settings.
  publishBrightness();
  // Everyone some zone follows: a schedule that speaks to none of them flashes nothing (the Director picks the zones).
  const followed = () => director.zones.flatMap((zone) => zone.following);
  listen(ctx, director, followed, { controller: () => wired.reload(), settings: publishBrightness });
  ctx.onStop(async () => {
    wired.stop();
    touch.close();
    await director.stop();
  });

  director.start();
  wired.start();
}

/** Failed attempts at the events request with `TouchEventsPort`, none opened, before it goes on without it. */
const TOUCH_HEADER_ATTEMPTS = 2;

/**
 * One touch stream per controller connection (main/src/nanoleaf/touch-stream.ts), made with the connection's event
 * stream and closed with it (a drop, a forget, pairing again, a stop), so `heard` starts again at each connection.
 * The event stream is opened once the touch socket is bound, so its first request already asks for the stream
 * (`TouchEventsPort`). Its packets are read only from the controller's address when that is an IP address (a host
 * name can't be compared with a sender), and an IPv6 controller gets an IPv6 socket. Every open copy of the interface
 * is told when `heard` changes. A connection whose events request never opens while it asks for the stream stops
 * asking after two attempts (below). Exported, with seams for the socket and the event stream, for the tests.
 */
export function touchStreams(
  ctx: Pick<MainContext, "log" | "ui">,
  seams: {
    /** Makes the touch socket (tests). Default: a `dgram` socket. */
    readonly createSocket?: TouchStreamOptions["createSocket"];
    /** Opens the event stream (tests). Default: an `EventStream`. */
    readonly createEvents?: (options: EventStreamOptions) => EventsHandle;
  } = {},
): {
  readonly open: (options: EventStreamOptions) => EventsHandle;
  readonly current: () => TouchStream | null;
  readonly info: () => TouchStreamInfo;
  readonly close: () => void;
} {
  const { log, ui } = ctx;
  let current: TouchStream | null = null;
  let told = false;
  const info = (): TouchStreamInfo => ({ heard: current !== null && current.lastPacketAt !== null });
  const tell = () => {
    const now = info();
    if (now.heard === told) return;
    told = now.heard;
    try {
      ui.post("touchStream", now);
    } catch (error) {
      log.warn("Couldn't tell the interface (touchStream)", error);
    }
  };
  const close = () => {
    const stream = current;
    current = null;
    stream?.close();
    tell();
  };
  const open = (options: EventStreamOptions): EventsHandle => {
    close();
    const address = options.host.startsWith("[") ? options.host.slice(1, -1) : options.host;
    const family = isIP(address);
    const stream: TouchStream = new TouchStream({
      createSocket: seams.createSocket,
      type: family === 6 ? "udp6" : "udp4",
      source: family === 0 ? undefined : address,
      log: (message, error) => log.warn(message, error),
      onHeard: () => {
        if (current === stream) tell();
      },
    });
    current = stream;
    let events: EventsHandle | null = null;
    let closed = false;
    // Whether a controller accepts `TouchEventsPort` is unverified: one that refused it would leave the wall without
    // any events. So until a request carrying it has opened once on this connection, two failed attempts are enough
    // to stop asking: the rest of this connection goes without it, and without the touch stream. Once one has opened,
    // a later drop is the network's, and the header stays.
    let asked = 0;
    let accepted = false;
    let givenUp = false;
    const touchEventsPort = (): number | null => {
      if (givenUp || stream.port === null) return null;
      if (!accepted && asked >= TOUCH_HEADER_ATTEMPTS) {
        givenUp = true;
        log.warn(
          "The controller's event stream didn't open while the plugin asked it for touch data, so it stops asking " +
            "until the controller connects again. Swipes on a wall split into zones won't act meanwhile.",
        );
        if (current === stream) close();
        else stream.close();
        return null;
      }
      asked++;
      return stream.port;
    };
    void stream.bound.then(() => {
      if (closed) return;
      const withTouch: EventStreamOptions = {
        ...options,
        touchEventsPort,
        onStatus: (open, error) => {
          if (open && !givenUp && stream.port !== null) accepted = true;
          options.onStatus?.(open, error);
        },
      };
      events = seams.createEvents ? seams.createEvents(withTouch) : new EventStream(withTouch);
    });
    return {
      close: () => {
        closed = true;
        events?.close();
        if (current === stream) close();
        else stream.close();
      },
    };
  };
  return { open, current: () => current, info, close };
}

/**
 * Where a touch's gesture acts: the zone (shared/gestures.ts `touchZone`), read when the gesture is acted on, or null
 * for none. A tap or double tap acts in the zone of the panel touched. A swipe names no
 * panel, so the touch stream places it (`placeSwipe`, while there is a stream, heard or not, since its packets may
 * arrive just after the event). Placing uses up the swipe's touch data. On a split wall it is done by the target,
 * which the gesture handler calls only for a gesture it doesn't drop as busy, so a dropped swipe leaves the data to
 * the swipe being worked on. On a wall that isn't split every touch acts in its one zone, so a swipe there never waits
 * for the stream: it is placed now, only to use its data up. Exported for the tests.
 */
export function gestureTarget(
  touch: Touch,
  director: Pick<Director, "zones">,
  stream: Pick<TouchStream, "placeSwipe"> | null,
): GestureTarget {
  if (!touch.gesture.startsWith("swipe")) return () => touchZone(director.zones, touch.panelId) ?? null;
  const zones = director.zones;
  const panels = zones.flatMap((zone) => zone.panels);
  if (!isSplit(zones) || stream === null) {
    void stream?.placeSwipe(panels);
    return () => touchZone(director.zones, null) ?? null;
  }
  return async () => touchZone(director.zones, await stream.placeSwipe(panels)) ?? null;
}

/**
 * Who the wall follows, worked out each time from the stored choice and the members now; never written back. A Drift
 * Beacon that sends no members gives nobody. On a split wall it is the first zone's member; a gesture is for the
 * zone it acts in instead. Exported for the tests.
 */
export function followingOf(ctx: Pick<MainContext, "storage" | "members">): () => readonly string[] {
  return () => actingFor(readZones(ctx.storage.get(STORAGE_KEYS.zones))[0]?.member, ctx.members ?? []);
}

/**
 * What makes the wall think again: a data change, a schedule firing, and a storage write. A schedule's snapshot with
 * its pin came first, so the wall is already on its way to the new scene; only a schedule that speaks to someone the
 * wall follows flashes it (one that tells everyone lists every member), and only in the zones whose member it speaks
 * to (the Director picks them from `members`). `following` is everyone the wall's zones follow. A new controller
 * reloads the connection; the settings, the order, the layout and the zones re-decide the scene. Exported for the
 * tests.
 */
export function listen(
  ctx: Pick<MainContext, "onDataChange" | "schedules" | "storage">,
  director: Pick<Director, "alert" | "update">,
  following: () => readonly string[],
  on: { readonly controller: () => void; readonly settings: () => void },
): void {
  ctx.onDataChange(() => director.update());
  ctx.schedules.onTriggered((trigger) => {
    const members = trigger.members ?? [];
    if (speaksTo(members, following())) director.alert(trigger.activityId, members);
  });
  ctx.storage.onChange((key) => {
    if (key === STORAGE_KEYS.controller) on.controller();
    else if (
      key === STORAGE_KEYS.settings ||
      key === STORAGE_KEYS.order ||
      key === STORAGE_KEYS.layout ||
      key === STORAGE_KEYS.zones
    ) {
      if (key === STORAGE_KEYS.settings) on.settings();
      director.update();
    }
  });
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
function registerRequests(
  ctx: MainContext,
  controller: Controller,
  director: Director,
  find: Find,
  numbering: Set<string>,
  touchStream: () => TouchStreamInfo,
): void {
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
      const found = await find(timeoutMs, meta.signal);
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
  ui.onClientsChange((clients) => {
    const open = new Set(clients.map((client) => client.id));
    director.endPreviewsExcept(open);
    // A copy that closed mid-way stops counting as numbering.
    for (const id of numbering) if (!open.has(id)) numbering.delete(id);
  });

  ui.handle(
    "numbering",
    (input, meta) => {
      if (input.on) numbering.add(meta.client.id);
      else numbering.delete(meta.client.id);
    },
    { input: NUMBERING_INPUT },
  );

  ui.handle("brightness", (input) => director.brightness(input.value), { input: BRIGHTNESS_INPUT });

  // Main's clock, so the interface can draw a controller's effect at the point the wall has reached.
  ui.handle("clock", () => ({ now: Date.now() }));

  // Whether the touch stream has been heard since this controller connected (the `touchStream` message says when
  // that changes): on a split wall a swipe acts only when the stream places it.
  ui.handle("touchStream", () => touchStream());
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
 * a live session of one still glows, as core's live-activity-slot shows it (decideScene ignores archived pins). A
 * Drift Beacon that sends no members (`ctx.members` arrived in 0.4.1) gives none, so the wall follows nobody.
 * Exported for the tests.
 */
export function workspaceData(ctx: Pick<MainContext, "activities" | "sessions" | "members">): () => WorkspaceData {
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
    return { activities, sessions, members: ctx.members ?? [] };
  };
}

/**
 * What gestures do to the workspace, through the SDK: a start or mark for the members it is given, a pause or pin
 * placed by the member it is given or by nobody (`null`). `pause`, `pin` and `unpin` arrived in SDK 0.2.12: main code
 * runs against the app's own SDK, so on an older Drift Beacon they are missing, and say so. Exported for the tests.
 */
export function gestureActions(ctx: MainContext): GestureActions {
  const needs = <T>(fn: T | undefined, what: string): T => {
    if (typeof fn !== "function") throw new PluginError("unsupported", `${what} needs a newer Drift Beacon`);
    return fn;
  };
  return {
    pause: (sessionId, placedBy) =>
      needs(ctx.sessions.pause, "Pausing").call(ctx.sessions, sessionId, { placedBy }),
    stop: (sessionId) => ctx.sessions.end(sessionId),
    track: async (activityId, members) => {
      const activity = ctx.activities.get(activityId);
      if (!activity) throw new PluginError("not-found", "That activity is gone");
      return activity.track({ members });
    },
    pin: (activityId, placedBy) =>
      needs(ctx.activities.pin, "Pinning").call(ctx.activities, activityId, { placedBy }),
    unpin: (activityId) => needs(ctx.activities.unpin, "Unpinning").call(ctx.activities, activityId),
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
