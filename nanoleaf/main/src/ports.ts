/**
 * How main's parts see the outside world: timers, a logger, storage, the controller's REST client and UDP stream, and
 * the connection the Controller hands the Director. index.ts plugs in `ctx` and the real clients; tests plug in fakes.
 */
import type { PanelRgb } from "../../shared/protocol.ts";
import type { ActivityLike, ConnectionStatus, ControllerConfig, SessionLike } from "../../shared/types.ts";
import type { HandbackClient } from "./handback.ts";
import type { RequestOptions } from "./nanoleaf/http.ts";

/** Timer functions, injectable for tests. Handles are opaque. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** The global timers, looked up at call time (the plugin host patches them to track and clear them). */
export const GLOBAL_TIMERS: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** A logger (`ctx.log`). */
export interface Log {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Plugin storage, as main uses it: synchronous reads, optimistic writes. */
export interface StoragePort {
  get(key: string): unknown;
  set(key: string, value: unknown): Promise<void>;
}

/** Workspace data as the shared modules read it. */
export interface WorkspaceData {
  readonly activities: readonly ActivityLike[];
  readonly sessions: readonly SessionLike[];
}

/** What the Director knows of the connection (from controller.ts). */
export interface Link {
  readonly status: ConnectionStatus;
  readonly config: ControllerConfig | null;
  /** The serial number, or `host:port` without one: the key for claims, layout and hand-back. */
  readonly controllerId: string | null;
  /** The controller's event stream is open, so effect and power changes arrive as events. */
  readonly events: boolean;
}

/** Before anything connects. */
export const NO_LINK: Link = Object.freeze({ status: "unconfigured", config: null, controllerId: null, events: false });

/** An effect or power change the controller reported (event stream or poll); absent fields weren't reported. */
export interface DeviceEvent {
  readonly effect?: string | null;
  readonly on?: boolean;
}

/** The part of `NanoleafClient` the Director uses. */
export interface DirectorClient extends HandbackClient {
  select(options?: RequestOptions): Promise<string | null>;
  enterExtControl(options?: RequestOptions): Promise<void>;
  requestStatic(options?: RequestOptions): Promise<string | null>;
}

/** The part of `ExtControlStream` the Director uses. */
export interface DirectorStream {
  send(lights: Iterable<PanelRgb>, transitionDs?: number): boolean;
  close(): void;
}
