/**
 * The player as main knows it: the slot state machine (DESIGN.md "Main") run over storage, the workspace and the
 * published state. Everything that changes something runs through one queue, so main stays the only writer and a
 * removal always sees the session its insert started; policy.ts decides, this file performs the session actions and
 * writes what came of them. A report that repeats an already-applied `(device, boot, seq)` and agrees with the slot
 * answers from a small cache without queueing behind slow work. An insert whose record write storage refused is
 * remembered beside that cache, and written back when the player repeats the report.
 */
import { type MainContext, PluginError } from "@drift-beacon/plugin";
import {
  type ErrorReply,
  type PlayerReply,
  type PlayerReport,
  type ReportResult,
  playerReply,
} from "../../shared/protocol.ts";
import type { PresenceState, SlotState } from "../../shared/state.ts";
import {
  activeDevice,
  type DeviceRecord,
  type HistoryEntry,
  type HistoryKind,
  LIMITS,
  mappedActivity,
  PRESENCE_WRITE_MS,
  type PlayerRecord,
  readMappings,
  readPlayerRecord,
  type Slot,
  type SlotOutcome,
  slotHolding,
  STORAGE_KEYS,
  type TagMappings,
} from "../../shared/storage.ts";
import { normalizeTag, type Tag } from "../../shared/tags.ts";
import { type LabelResult, SAVE_REFUSED, type StartResult } from "../../shared/ui-channel.ts";
import {
  agrees,
  type InsertResult,
  isOwnLiveSpan,
  isRetry,
  type Lookup,
  orderReport,
  playedMs,
  presenceState,
  type Resolution,
  reportedTag,
  resolveCartridge,
  slotState,
} from "./policy.ts";
import { type Clock, iso, type Timers } from "./ports.ts";
import { createPresence, type ReaderHealth } from "./presence.ts";
import { createQueue } from "./queue.ts";
import {
  alignedWith,
  hasRoom,
  newDevice,
  type Standing,
  sameJson,
  withDevice,
  withHistory,
  withoutStats,
  withoutUnknown,
  withStats,
  withUnknown,
} from "./record.ts";

/** Past this many queued steps a report is answered `retry`: something upstream is stuck, and the player will retry. */
const MAX_BACKLOG = 32;
/** How long a player waits before retrying a report main couldn't take. */
const RETRY_MS = 2000;
/** How long a new player waits while every place is taken by a player that's online: one has to go quiet first. */
const FULL_RETRY_MS = 60_000;

export interface Player {
  /** Applies a report (or answers one that changes nothing from the cache). An ErrorReply is sent as 503. */
  report(report: PlayerReport, hubHost: string | null): Promise<PlayerReply | ErrorReply>;
  label(tag: string, activityId: string): Promise<LabelResult>;
  forget(tag: string): Promise<{ readonly forgotten: boolean }>;
  dismiss(tag: string): Promise<{ readonly dismissed: boolean }>;
  start(deviceId: string | undefined): Promise<StartResult>;
  /** Reads storage: lines the record up with the labels, publishes. Synchronous. */
  open(): void;
  /** Republishes `player` and `slot` if what they'd say changed. */
  publish(): void;
  stop(): void;
}

export interface PlayerOptions {
  readonly now: Clock;
  readonly timers: Timers;
}

/** What performing a resolution came to. */
interface Performed {
  readonly result: InsertResult;
  readonly activityId: string | null;
  readonly sessionId: string | null;
  readonly name: string | null;
  readonly error: string | null;
  /** The rejection, when the action failed. */
  readonly cause: unknown;
}

/** What a slot change came to: the reply's result and the activity it's about. */
interface Changed {
  readonly result: ReportResult;
  readonly name: string | null;
}

/**
 * What an interface request did, and the storage write it ended with: it resolves whether that landed, and the
 * request is answered only once it has. (A request with two writes has waited for the first inside its step.)
 */
interface Written<T> {
  readonly result: T;
  readonly saved: Promise<boolean>;
}

/** An insert main performed whose record write was refused: the slot it resolved, and the report that put it there. */
interface LostInsert {
  readonly boot: number;
  readonly seq: number;
  readonly slot: Slot;
}

/** Nothing to write: the request found everything as it asked. */
const NOTHING_TO_SAVE = Promise.resolve(true);
/** The refusal for a label, forget or dismiss storage wouldn't take. */
const notSaved = (): PluginError => new PluginError("failed", SAVE_REFUSED);

/** What a history entry says beyond its kind and tag; anything left out is null. */
type HistoryFields = Partial<Pick<HistoryEntry, "activityId" | "deviceId" | "sessionId" | "durationMs">>;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const STARTED: readonly SlotOutcome[] = ["started", "resumed", "marked"];

/** Builds the player for one instance. Nothing runs until `open()`. */
export function createPlayer(ctx: MainContext, options: PlayerOptions): Player {
  const { log } = ctx;
  const { now } = options;
  const queue = createQueue();
  const lookup: Lookup = { activity: (id) => ctx.activities.get(id), session: (id) => ctx.sessions.get(id) };
  /** Per device: the last applied report's `(boot, seq)` and the reply it got. */
  const replies = new Map<string, { readonly boot: number; readonly seq: number; readonly reply: PlayerReply }>();
  /**
   * Per device: the insert whose record write storage refused, under the `(boot, seq)` that reported it. The host
   * rolled the record back, but the cartridge was resolved: its activity started, or was marked. When the player
   * repeats that report the slot is written back as it was resolved, never resolved a second time.
   */
  const lostInserts = new Map<string, LostInsert>();
  let shown: { player: PresenceState | null; slot: SlotState | null } = { player: null, slot: null };
  /** The device whose cartridge is coming out: its published slot holds still until the eject is written. */
  let leaving: string | null = null;
  let stopped = false;

  const presence = createPresence({
    now,
    timers: options.timers,
    onOffline: (deviceId) => {
      const heard = presence.lastHeard(deviceId) !== null;
      log.info(
        heard ? `${deviceId} went quiet: offline` : `${deviceId} hasn't reported since the plugin started: offline`,
      );
      queue
        .run(() => wentOffline(deviceId))
        .catch((error: unknown) => log.error("Couldn't record a player going offline", error));
    },
  });

  /* ---- Storage ---- */

  const mappings = (): TagMappings => readMappings(ctx.storage.get(STORAGE_KEYS.mappings));
  const record = (): PlayerRecord => readPlayerRecord(ctx.storage.get(STORAGE_KEYS.player));

  /**
   * Optimistic: storage shows the value at once. Resolves whether the write landed. A rejected write is logged and the
   * host rolls it back to the server's value, so that change is lost unless a later write carried it: main never
   * assumes a write it made is there, and reads the record again at every step.
   */
  function save(key: string, value: unknown): Promise<boolean> {
    const failed = (error: unknown): boolean => {
      log.warn(`Couldn't save ${key}`, error);
      return false;
    };
    try {
      return ctx.storage.set(key, value).then(() => true, failed);
    } catch (error) {
      return Promise.resolve(failed(error));
    }
  }

  /** Writes the record if it says something other than what's stored (as read), then republishes. */
  function write(next: PlayerRecord): Promise<boolean> {
    const saved = sameJson(record(), next) ? Promise.resolve(true) : save(STORAGE_KEYS.player, next);
    publish();
    return saved;
  }

  /** `write` for the steps nobody waits on (a device's report is answered at once; the next one heals a lost write). */
  function commit(next: PlayerRecord): PlayerRecord {
    void write(next);
    return next;
  }

  /* ---- Who is there ---- */

  /** A stored device's standing when a new one needs a place. One main is still waiting to hear from keeps its own. */
  const standing = (device: DeviceRecord): Standing => ({
    online: presence.online(device.id) !== false,
    heardAt: presence.lastHeard(device.id) ?? (device.lastHeardAt === null ? 0 : Date.parse(device.lastHeardAt)),
  });

  /** `device` stored. A new one may take the place of one that can go (record.ts `withDevice`), which main forgets. */
  function admit(rec: PlayerRecord, device: DeviceRecord): PlayerRecord {
    const next = withDevice(rec, device, standing);
    for (const id of Object.keys(rec.devices)) {
      if (Object.hasOwn(next.devices, id)) continue;
      replies.delete(id);
      lostInserts.delete(id);
      presence.forget(id);
      log.info(`Forgot ${id}: ${device.id} took its place (${LIMITS.devices} players at most)`);
    }
    return next;
  }

  /** A player was just heard from: coming online and a change of its reader's health each get a line. */
  function heard(id: string, reader: ReaderHealth): void {
    const { cameOnline, readerWas } = presence.heard(id, reader);
    if (cameOnline) log.info(`${id} is online`);
    if (reader === "fault" && readerWas !== "fault")
      log.warn(`${id} reports a reader fault: it can't tell what's in its slot`);
    if (readerWas === "fault" && reader !== "fault") log.info(`${id}'s reader is working again`);
    if (cameOnline || readerWas !== reader) publish();
  }

  /**
   * The session taking the cartridge out of `slot` would end, were it live: the one it started or adopted. A slot in
   * outcome `error` has none, but the start it was refused may still have run (the host stops waiting after 10 s) and
   * its session shows up later: a live session of its activity is this cartridge's, and nothing else would end it.
   * Every rule that asks whose a session is asks here, so they can't disagree with eject.
   */
  function slotSession(slot: Slot): string | null {
    if (slot.sessionId !== null || slot.outcome !== "error" || slot.activityId === null) return slot.sessionId;
    return lookup.activity(slot.activityId)?.live({ mine: true })[0]?.id ?? null;
  }

  /** The slot's own session is live: taking the cartridge out would end it. */
  function isPlaying(slot: Slot | null): boolean {
    const sessionId = slot === null ? null : slotSession(slot);
    return sessionId !== null && isOwnLiveSpan(lookup.session(sessionId));
  }

  /** The name of the activity a slot is in the player as, for the player's log. */
  const activityName = (slot: Slot | null): string | null =>
    slot?.activityId ? (lookup.activity(slot.activityId)?.name ?? null) : null;

  /**
   * The player to show once `id` was heard for the first time or set up again: `id`, unless that would take the stage
   * from another one that is online and playing. `rec` is the record before `id`'s report changes it.
   */
  function stageAfter(rec: PlayerRecord, id: string): string {
    const current = activeDevice(rec);
    const busy =
      current !== null && current.id !== id && presence.online(current.id) === true && isPlaying(current.slot);
    return busy ? current.id : id;
  }

  /** Every other device whose slot holds `tag`: stale once it's in `deviceId`'s (a cartridge is in one slot only). */
  const heldElsewhere = (rec: PlayerRecord, deviceId: string, tag: Tag): DeviceRecord[] =>
    Object.values(rec.devices).filter((other) => other.id !== deviceId && other.slot?.tag === tag);

  /* ---- Telling the world ---- */

  function publish(): void {
    const rec = record();
    const device = activeDevice(rec);
    const player = presenceState(device, {
      online: device === null ? null : presence.online(device.id),
      reader: device === null ? null : presence.reader(device.id),
    });
    // A cartridge on its way out keeps its last published slot: see `eject`.
    const held = device !== null && device.id === leaving && shown.slot?.deviceId === leaving ? shown.slot : null;
    const slot = held ?? slotState(device, lookup);
    try {
      if (!sameJson(player, shown.player)) ctx.state.set("player", player);
      shown = { ...shown, player };
    } catch (error) {
      log.error("Couldn't publish player", error);
    }
    try {
      if (!sameJson(slot, shown.slot)) ctx.state.set("slot", slot);
      shown = { ...shown, slot };
    } catch (error) {
      log.error("Couldn't publish slot", error);
    }
  }

  function tell(what: string, send: () => void): void {
    try {
      send();
    } catch (error) {
      log.error(`Couldn't send ${what}`, error);
    }
  }

  /* ---- Session actions ---- */

  /** Runs what a resolution names. A rejected action is outcome `error`, never a thrown error. */
  async function perform(resolution: Resolution): Promise<Performed> {
    const base = { sessionId: null, error: null, cause: undefined };
    switch (resolution.kind) {
      case "unknown":
        return { ...base, result: "unknown", activityId: null, name: null };
      case "orphan":
        return { ...base, result: "orphan", activityId: resolution.activityId, name: null };
      case "archived": {
        const name = lookup.activity(resolution.activityId)?.name ?? null;
        return { ...base, result: "archived", activityId: resolution.activityId, name };
      }
      case "adopt": {
        const { activity, sessionId } = resolution;
        return { ...base, result: "resumed", activityId: activity.id, sessionId, name: activity.name };
      }
      case "mark":
      case "start": {
        const { activity } = resolution;
        try {
          const session = resolution.kind === "mark" ? await activity.mark() : await activity.track();
          const result = resolution.kind === "mark" ? "marked" : "started";
          return { ...base, result, activityId: activity.id, sessionId: session.id, name: activity.name };
        } catch (error) {
          log.warn(`Couldn't ${resolution.kind} ${activity.name}`, error);
          const failed = {
            result: "error",
            activityId: activity.id,
            name: activity.name,
            error: messageOf(error),
          } as const;
          return { ...base, ...failed, cause: error };
        }
      }
    }
  }

  /**
   * Adds the time a slot's session tracked while its cartridge was there (to the session's end, or to now while it
   * runs) to the cartridge, before the slot moves on without an eject.
   */
  function settle(rec: PlayerRecord, slot: Slot): PlayerRecord {
    const ms = slot.sessionId === null ? null : playedMs(slot, lookup.session(slot.sessionId), now());
    if (!ms || mappedActivity(mappings(), slot.tag) === null) return rec;
    return withStats(rec, slot.tag, (stats) => ({ ...stats, playedMs: stats.playedMs + ms }));
  }

  const history = (rec: PlayerRecord, kind: HistoryKind, tag: Tag, fields: HistoryFields = {}): PlayerRecord =>
    withHistory(rec, {
      at: iso(now()),
      kind,
      tag,
      activityId: fields.activityId ?? null,
      deviceId: fields.deviceId ?? null,
      sessionId: fields.sessionId ?? null,
      durationMs: fields.durationMs ?? null,
    });

  /* ---- The slot machine ---- */

  /**
   * Takes the cartridge out of `deviceId`'s slot: ends the session it started or adopted if it's still live (never
   * another), adds the time it tracked while in to the cartridge, and records it. Commits.
   */
  async function eject(rec: PlayerRecord, deviceId: string): Promise<{ rec: PlayerRecord; changed: Changed }> {
    const device = rec.devices[deviceId];
    const held = device.slot as Slot;
    // With the session a refused start ran late, when there is one: it is recorded as this cartridge's.
    const slot: Slot = { ...held, sessionId: slotSession(held) };
    const before = slot.sessionId === null ? undefined : lookup.session(slot.sessionId);
    let ended = false;
    let failed = false;
    if (isOwnLiveSpan(before)) {
      // The ended session reaches main, and republishes, before the action resolves and the emptied slot is
      // written. Held still meanwhile, or every eject would publish `ready` on its way from `playing` to `empty`.
      leaving = deviceId;
      try {
        await ctx.sessions.end(before.id);
        ended = true;
      } catch (error) {
        // Ended elsewhere meanwhile is fine; still live means the cartridge is out and its session runs on.
        failed = isOwnLiveSpan(lookup.session(before.id));
        if (failed) log.warn(`Couldn't end the session ${slot.tag} started`, error);
      } finally {
        leaving = null;
      }
    }
    const durationMs = slot.sessionId === null ? null : playedMs(slot, lookup.session(slot.sessionId), now());
    const at = iso(now());
    let next = withDevice(rec, { ...rec.devices[deviceId], slot: null });
    next = { ...next, active: deviceId };
    next = history(next, "eject", slot.tag, {
      activityId: slot.activityId,
      deviceId,
      sessionId: slot.sessionId,
      durationMs,
    });
    if (mappedActivity(mappings(), slot.tag) !== null) {
      next = withStats(next, slot.tag, (stats) => ({
        ...stats,
        seenAt: at,
        playedMs: stats.playedMs + (durationMs ?? 0),
      }));
    }
    next = commit(next);
    tell("ejected", () => ctx.events.emit("ejected", { tag: slot.tag, activityId: slot.activityId, durationMs }));
    return { rec: next, changed: { result: failed ? "error" : ended ? "ended" : "empty", name: activityName(slot) } };
  }

  /** The record once `slot`, resolved at `slot.since`, is in `deviceId`'s slot: what an insert writes. */
  function withInserted(rec: PlayerRecord, deviceId: string, slot: Slot): PlayerRecord {
    const { tag, since: at, outcome } = slot;
    let next = rec;
    // A slot still holding this cartridge elsewhere is stale (a player that stopped reporting): it empties without
    // ending anything, and the time its session tracked there is kept.
    for (const other of heldElsewhere(rec, deviceId, tag)) {
      next = withDevice(settle(next, other.slot as Slot), { ...other, slot: null });
    }
    next = withDevice(next, { ...rec.devices[deviceId], slot });
    next = { ...next, active: deviceId };
    if (outcome === "unknown") return history(withUnknown(next, tag, at), "new", tag, { deviceId });
    next = history(next, "insert", tag, { activityId: slot.activityId, deviceId, sessionId: slot.sessionId });
    const played = STARTED.includes(outcome) ? 1 : 0;
    return withStats(next, tag, (stats) => ({ ...stats, seenAt: at, plays: stats.plays + played }));
  }

  /**
   * Puts `tag` in `deviceId`'s slot and resolves it: the interface hears `reading` first, with the id of the history
   * entry this insert will write (`rec.nextId`: nothing else writes until it has). Commits.
   */
  async function insert(
    rec: PlayerRecord,
    deviceId: string,
    tag: Tag,
  ): Promise<{ rec: PlayerRecord; changed: Changed }> {
    tell("reading", () => ctx.ui.post("reading", { tag, deviceId, entry: rec.nextId }));
    const done = await perform(resolveCartridge(mappedActivity(mappings(), tag), lookup));
    const at = iso(now());
    const slot: Slot = {
      tag,
      since: at,
      activityId: done.activityId,
      sessionId: done.sessionId,
      outcome: done.result,
      error: done.error,
    };
    const next = withInserted(rec, deviceId, slot);
    const saved = write(next);
    // The cartridge is in this slot now, so an insert another player lost can no longer be written back.
    for (const [other, lost] of lostInserts) if (lost.slot.tag === tag) lostInserts.delete(other);
    const { boot, seq } = rec.devices[deviceId];
    if (boot !== null && seq !== null) {
      // The reply doesn't wait for storage. Refused, the action above still ran: kept for the player's repeat.
      void saved.then((landed) => {
        if (!landed) lostInserts.set(deviceId, { boot, seq, slot });
      });
    }
    tell("inserted", () => ctx.events.emit("inserted", { tag, activityId: done.activityId, result: done.result }));
    return { rec: next, changed: { result: done.result, name: done.name } };
  }

  /** The slot goes from what it holds to `tag`: eject the old cartridge, then insert the new one (if any). */
  async function change(rec: PlayerRecord, deviceId: string, tag: Tag | null): Promise<Changed> {
    let changed: Changed = { result: "unchanged", name: null };
    if (rec.devices[deviceId].slot) ({ rec, changed } = await eject(rec, deviceId));
    if (tag !== null) ({ changed } = await insert(rec, deviceId, tag));
    return changed;
  }

  /** `device` heard from now: its `lastHeardAt` written only when due (or when something else is written anyway). */
  function heardDevice(device: DeviceRecord, hubHost: string | null, force: boolean): DeviceRecord {
    const host = hubHost ?? device.hubHost;
    const last = device.lastHeardAt === null ? Number.NEGATIVE_INFINITY : Date.parse(device.lastHeardAt);
    const due = force || host !== device.hubHost || now() - last >= PRESENCE_WRITE_MS;
    return due ? { ...device, hubHost: host, lastHeardAt: iso(now()) } : device;
  }

  /** `id` heard again by a report that changed nothing: `lastHeardAt` and `hubHost` are written when due. */
  function heardAgain(rec: PlayerRecord, id: string, hubHost: string | null): PlayerRecord {
    return Object.hasOwn(rec.devices, id) ? withDevice(rec, heardDevice(rec.devices[id], hubHost, false)) : rec;
  }

  /** The 503 a player main has no place for gets: `LIMITS.devices` others are online. */
  const full = (): ErrorReply => ({
    ok: false,
    v: 2,
    code: "retry",
    error: `${LIMITS.devices} players are already online here; this one is taken once one of them goes quiet`,
    retry_ms: FULL_RETRY_MS,
  });

  async function applyReport(report: PlayerReport, hubHost: string | null): Promise<PlayerReply | ErrorReply> {
    const id = report.device.id;
    let rec = record();
    const known = Object.hasOwn(rec.devices, id) ? rec.devices[id] : null;
    if (orderReport(known, report) === "stale") return playerReply(report.seq, "stale");
    // A player heard for the first time, or set up again, is the one the user is holding: show it.
    const stage = known === null || report.reason === "pair" ? stageAfter(rec, id) : null;
    const staged = (next: PlayerRecord): PlayerRecord => (stage === null ? next : { ...next, active: stage });
    if (agrees(known, report)) {
      commit(staged(heardAgain(rec, id, hubHost)));
      const reply = repeatReply(id, report);
      // After a restart the cache is empty: from now on, this report's repeats answer without queueing.
      const cached = replies.get(id);
      if (cached?.boot !== report.boot || cached.seq !== report.seq)
        replies.set(id, { boot: report.boot, seq: report.seq, reply });
      return reply;
    }
    if (known === null && !hasRoom(rec, standing)) {
      presence.forget(id);
      return full();
    }
    const rebooted = known !== null && known.boot !== report.boot;
    const device: DeviceRecord = {
      ...(known ?? newDevice(id)),
      name: report.device.name ?? known?.name ?? null,
      fw: report.device.fw ?? known?.fw ?? null,
      boot: report.boot,
      seq: report.seq,
    };
    const slot = device.slot;
    const tag = reportedTag(slot, report);
    const lost = lostInserts.get(id);
    // Any other report from this player says something newer than the insert storage lost.
    if (lost !== undefined && (lost.boot !== report.boot || lost.seq !== report.seq)) lostInserts.delete(id);
    else if (lost !== undefined && lost.slot.tag === tag && slot === null) {
      // The report whose record write storage refused, repeated: its cartridge was resolved then (a point marked, a
      // span started, which the user may have ended since). Resolving it again would mark or start it twice, and
      // would turn main's own `started` into `resumed`. The slot goes back as it was resolved, and stays remembered
      // until that write lands.
      rec = admit(rec, heardDevice(device, hubHost, true));
      void write(withInserted(rec, id, lost.slot)).then((landed) => {
        if (landed && lostInserts.get(id) === lost) lostInserts.delete(id);
      });
      log.info(`${id} repeats ${tag}, whose record storage refused: its slot is written again as it was`);
      return repeatReply(id, report);
    }
    let changed: Changed;
    if (report.reader === "fault" && tag !== null && heldElsewhere(rec, id, tag).length > 0) {
      // A blind player names a cartridge under a seq main hasn't applied: the report that said so was lost before
      // its reader failed. It is only the last value read, and another player's slot holds that cartridge now, so it
      // has left this one since. Taken at its word, the blind player would take it (marking or starting it again) and
      // the other take it back at its next heartbeat. Main notes the `(boot, seq)` and that whatever its slot held
      // before is out, and leaves the cartridge where it is: the first report from a reader that reads settles it.
      rec = staged(admit(rec, heardDevice(device, hubHost, true)));
      log.info(`${id} can't read its slot and last read ${tag}, which is in another player: left there`);
      if (slot === null) {
        commit(rec);
        changed = { result: "unchanged", name: null };
      } else ({ changed } = await eject(rec, id));
    } else if (tag === (slot?.tag ?? null)) {
      commit(staged(admit(rec, heardDevice(device, hubHost, true))));
      // A reboot with the cartridge still in: its session carries on, and the player chirps to say so.
      changed = { result: rebooted && isPlaying(slot) ? "resumed" : "unchanged", name: activityName(slot) };
    } else {
      changed = await change(admit(rec, heardDevice(device, hubHost, true)), id, tag);
    }
    const reply = playerReply(report.seq, changed.result, changed.name);
    replies.set(id, { boot: report.boot, seq: report.seq, reply });
    return reply;
  }

  /** A report that changed nothing: a retry of the applied one gets the reply it missed, a heartbeat `unchanged`. */
  function repeatReply(id: string, report: PlayerReport): PlayerReply {
    const cached = replies.get(id);
    const same = cached !== undefined && cached.boot === report.boot && cached.seq === report.seq;
    if (same && isRetry(report.reason)) return cached.reply;
    return playerReply(report.seq, "unchanged", same ? cached.reply.activity : null);
  }

  async function wentOffline(deviceId: string): Promise<void> {
    const rec = record();
    const heardAt = presence.lastHeard(deviceId);
    if (Object.hasOwn(rec.devices, deviceId) && heardAt !== null) {
      // The real last-heard time, so "last heard" is exact while it's offline.
      commit(withDevice(rec, { ...rec.devices[deviceId], lastHeardAt: iso(heardAt) }));
    } else publish();
  }

  /* ---- Interface requests ---- */

  /** `tag` is about to mean something else: an insert storage lost was resolved under its old label, and is dropped. */
  function forgetLost(tag: Tag): void {
    for (const [id, lost] of lostInserts) if (lost.slot.tag === tag) lostInserts.delete(id);
  }

  function tagOf(text: string): Tag {
    const tag = normalizeTag(text);
    if (!tag) throw new PluginError("invalid", "That isn't a cartridge's UID");
    return tag;
  }

  async function label(text: string, activityId: string): Promise<Written<LabelResult>> {
    const tag = tagOf(text);
    const activity = ctx.activities.get(activityId);
    if (!activity?.exists) throw new PluginError("invalid", "That activity no longer exists");
    if (activity.archived) throw new PluginError("invalid", `${activity.name} is archived: pick another activity`);
    const labels = mappings();
    const previous = mappedActivity(labels, tag);
    if (previous !== activityId) {
      forgetLost(tag);
      // The mapping first, and the record only once it landed. The record write takes the cartridge off the unknown
      // list: with its label refused that would leave it nowhere, neither labelled nor on the list the user labels
      // it from. Should the record write be refused instead, the label is there and asking again finishes the rest.
      const next: TagMappings = { ...labels, [tag]: activityId };
      if (!(await save(STORAGE_KEYS.mappings, next))) throw notSaved();
    }
    let rec = record();
    const holder = slotHolding(rec, tag);
    if (previous !== activityId) {
      rec = history(rec, previous === null ? "label" : "relabel", tag, { activityId, deviceId: holder?.device.id });
    }
    const seen = rec.unknown.find((item) => item.tag === tag)?.lastSeenAt ?? null;
    rec = withStats(withoutUnknown(rec, tag), tag, (stats) =>
      stats.seenAt === null ? { ...stats, seenAt: seen } : stats,
    );
    if (holder) {
      const { device, slot } = holder;
      // A playing cartridge keeps its session (it still ends on eject); the new label applies next time it goes in.
      if (!isPlaying(slot) && (slot.activityId !== activityId || !STARTED.includes(slot.outcome))) {
        rec = settle(rec, slot);
        const idle: Slot = { ...slot, activityId, sessionId: null, outcome: "idle", error: null };
        rec = withDevice(rec, { ...rec.devices[device.id], slot: idle });
      }
    }
    return { result: { tag, activityId, previous, inSlot: holder !== null }, saved: write(rec) };
  }

  async function forget(text: string): Promise<Written<{ readonly forgotten: boolean }>> {
    const tag = tagOf(text);
    let rec = record();
    // Refused only while the cartridge is in a player for certain: its slot's session is live, or the player holding
    // it is reporting. A slot whose player has gone quiet or hasn't been heard since main started is only what the
    // record last heard: were that enough to refuse, a cartridge left in the record of a player that is gone for good
    // could never be forgotten.
    const holders = Object.values(rec.devices).filter((device) => device.slot?.tag === tag);
    if (holders.some((device) => isPlaying(device.slot) || presence.online(device.id) === true))
      throw new PluginError("invalid", "Take it out of the player first");
    const previous = mappedActivity(mappings(), tag);
    if (previous === null) return { result: { forgotten: false }, saved: NOTHING_TO_SAVE };
    forgetLost(tag);
    // Such a slot empties with the label, ending nothing. If its player reports the cartridge still in after all,
    // the reported slot wins as ever, and it goes in as an unlabelled cartridge.
    for (const device of holders) rec = withDevice(rec, { ...device, slot: null });
    rec = history(withoutStats(rec, tag), "forget", tag, { activityId: previous });
    // The record first, and the mapping only once it landed: the label is what keeps the cartridge on the shelf,
    // where the user asks again. Refused after the record landed, the cartridge is still labelled and without stats,
    // and forgetting it again finishes the job.
    if (!(await write(rec))) throw notSaved();
    const next: Record<Tag, string> = { ...mappings() };
    delete next[tag];
    const saved = save(STORAGE_KEYS.mappings, next);
    if (holders.length === 0) return { result: { forgotten: true }, saved };
    // A slot was emptied, so this step waits for the mapping: all or nothing for the slot. Left emptied under a label
    // that stayed, the cartridge would be a new insert at its player's next report, and start an activity whose
    // session the user may have ended in the app.
    if (await saved) return { result: { forgotten: true }, saved: NOTHING_TO_SAVE };
    let restored = record();
    for (const holder of holders) {
      const stored = Object.hasOwn(restored.devices, holder.id) ? restored.devices[holder.id] : null;
      if (stored !== null && stored.slot === null) restored = withDevice(restored, { ...stored, slot: holder.slot });
    }
    await write(restored);
    throw notSaved();
  }

  async function dismiss(text: string): Promise<Written<{ readonly dismissed: boolean }>> {
    const tag = tagOf(text);
    const rec = record();
    const next = withoutUnknown(rec, tag);
    if (next === rec) return { result: { dismissed: false }, saved: NOTHING_TO_SAVE };
    return { result: { dismissed: true }, saved: write(history(next, "dismiss", tag)) };
  }

  async function start(deviceId: string | undefined): Promise<StartResult> {
    let rec = record();
    const device =
      deviceId === undefined ? activeDevice(rec) : Object.hasOwn(rec.devices, deviceId) ? rec.devices[deviceId] : null;
    const slot = device?.slot;
    if (!device || !slot) throw new PluginError("not-found", "There's no cartridge in the player");
    // Already playing its own session: there's nothing to start, whatever it's labelled now (a new label applies the
    // next time it goes in).
    // (A slot whose refused start ran late goes on: resolving it adopts that session, so it shows as playing.)
    if (isPlaying(slot) && slot.outcome !== "error")
      return { activityId: slot.activityId as string, sessionId: slot.sessionId, result: "resumed" };
    const resolution = resolveCartridge(mappedActivity(mappings(), slot.tag), lookup);
    if (resolution.kind === "unknown") throw new PluginError("not-found", "Label this cartridge first");
    if (resolution.kind === "orphan")
      throw new PluginError("not-found", "Its activity no longer exists: label it again");
    if (resolution.kind === "archived") throw new PluginError("invalid", "Its activity is archived: label it again");
    const done = await perform(resolution);
    // Nothing else changes the slot meanwhile: every change waits its turn in the queue.
    const next: Slot = {
      ...slot,
      activityId: done.activityId,
      sessionId: done.sessionId,
      outcome: done.result,
      error: done.error,
    };
    rec = withDevice(settle(rec, slot), { ...device, slot: next });
    if (done.result === "error") {
      commit(rec);
      const cause = done.cause;
      if (cause instanceof Error && cause.name === "PluginError") throw cause;
      throw new PluginError("failed", done.error ?? "Couldn't start it");
    }
    rec = withStats(rec, slot.tag, (stats) => ({ ...stats, plays: stats.plays + 1 }));
    commit(
      history(rec, "start", slot.tag, { activityId: done.activityId, deviceId: device.id, sessionId: done.sessionId }),
    );
    return {
      activityId: done.activityId as string,
      sessionId: done.sessionId,
      result: done.result as StartResult["result"],
    };
  }

  /* ---- Start-up ---- */

  function open(): void {
    const rec = alignedWith(record(), mappings());
    // A stored player gets a heartbeat's time to report before it counts as offline: a restart isn't an outage.
    for (const id of Object.keys(rec.devices)) presence.expect(id);
    void write(rec);
  }

  /** Runs `task` in the queue, unless main is stopping. */
  function queued<T>(task: () => Promise<T>): Promise<T> {
    if (stopped) return Promise.reject(new PluginError("stopped", "The plugin is stopping"));
    return queue.run(task);
  }

  /**
   * Answers an interface request once its last write has landed: the host rolls a rejected write back, and "done" for
   * a change that is gone would be a lie. Every such request is safe to send again. The wait is outside the queue,
   * so a device's report isn't held up by it.
   */
  async function confirmed<T>(step: Promise<Written<T>>): Promise<T> {
    const { result, saved } = await step;
    if (!(await saved)) throw notSaved();
    return result;
  }

  return {
    async report(report, hubHost) {
      const id = report.device.id;
      const devices = record().devices;
      const stored = Object.hasOwn(devices, id) ? devices[id] : null;
      if (stored === null && !hasRoom(record(), standing)) return full();
      heard(id, report.reader);
      const cached = replies.get(id);
      const applied = cached?.boot === report.boot && cached.seq === report.seq && agrees(stored, report);
      // Applied, and the slot is as it says: answer now. Not a player just set up again, though: that one takes its
      // turn in the queue, since it may become the shown one.
      if (stored !== null && applied && report.reason !== "pair") {
        // A presence write, when one is due, waits its turn too.
        if (heardDevice(stored, hubHost, false) !== stored) {
          queued(async () => {
            commit(heardAgain(record(), id, hubHost));
          }).catch((error: unknown) => log.warn(`Couldn't record hearing from ${id}`, error));
        }
        return repeatReply(id, report);
      }
      if (stopped || queue.size >= MAX_BACKLOG) {
        return { ok: false, v: 2, code: "retry", error: "The plugin is busy; try again shortly", retry_ms: RETRY_MS };
      }
      return queued(() => applyReport(report, hubHost));
    },
    label: (tag, activityId) => confirmed(queued(() => label(tag, activityId))),
    forget: (tag) => confirmed(queued(() => forget(tag))),
    dismiss: (tag) => confirmed(queued(() => dismiss(tag))),
    start: (deviceId) => queued(() => start(deviceId)),
    open,
    publish,
    stop() {
      stopped = true;
      presence.stop();
    },
  };
}
