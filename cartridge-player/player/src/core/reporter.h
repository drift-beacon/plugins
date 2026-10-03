// When to tell the hub what is in the slot, and what to do with its answer (DESIGN.md "Player", Reporting and
// Delivery). Level-triggered: the player always sends the slot as it is now, never a queue of edges, so a lost,
// repeated or late report is harmless. One request at a time; the caller runs it and hands back what came of it.
#pragma once

#include <cstdint>
#include <cstring>

#include "clock.h"
#include "protocol.h"
#include "text.h"
#include "uid.h"

namespace cp {

/** How the hub answered lately, for the light and the serial status. */
enum class HubState : uint8_t { Unknown, Ok, Unreachable, KeyRejected, NotFound, BadRequest };

inline const char* hubStateName(HubState state) {
  switch (state) {
    case HubState::Unknown: return "not heard yet";
    case HubState::Ok: return "ok";
    case HubState::Unreachable: return "unreachable";
    case HubState::KeyRejected: return "key rejected";
    case HubState::NotFound: return "plugin path not found or plugin off";
    case HubState::BadRequest: return "report refused";
  }
  return "unknown";
}

/**
 * How the cartridge in the slot stands with the hub, for the light between cues (core/indicator.h): what the hub's
 * last answer about it said. `None` for an empty slot, and for a cartridge the hub hasn't spoken about.
 */
enum class Standing : uint8_t { None, Tracking, Marked, Unknown, Error };

/** The report to send now: the slot and why. The caller adds the device's details and writes it. */
struct ReportDraft {
  uint32_t seq;
  Reason reason;
  Uid tag;
  Millis changedAt;
  bool readerFault;
};

class Reporter {
 public:
  static constexpr Millis FIRST_RETRY_MS = 500;
  static constexpr Millis MAX_RETRY_MS = 30000;
  /**
   * A hub that is starting up answers 401 or 404 for a moment (its keys and plugins aren't loaded yet), so the first
   * refusals in a row are retried this soon and shown as "unreachable". Only a refusal that outlasts them is the
   * hub's real answer: steady red, and a slow retry.
   */
  static constexpr Millis REFUSED_SOON_MS[] = {2000, 5000, 15000};
  static constexpr uint8_t REFUSALS_BEFORE_RED = sizeof REFUSED_SOON_MS / sizeof REFUSED_SOON_MS[0];
  /** After that the player retries slowly and never reconfigures itself. */
  static constexpr Millis REFUSED_RETRY_MS = 60000;
  /** No answer this long after a new cartridge went in: play `error` once, then keep retrying quietly. */
  static constexpr Millis INSERT_PATIENCE_MS = 3000;
  /** A `retry_ms` from the plugin is honoured up to this. */
  static constexpr Millis MAX_REQUESTED_WAIT_MS = 60000;

  explicit Reporter(uint32_t boot) : boot_(boot) {}

  uint32_t boot() const { return boot_; }

  /**
   * The slot has settled for the first time since power-up: the boot report can go. A cartridge found in the slot at
   * power-up isn't a new one, so it gets no "reading" light and no error while Wi-Fi is still joining.
   */
  void settle(const Uid& slot, bool readerFault, Millis now) {
    slot_ = slot;
    readerFault_ = readerFault;
    changedAt_ = now;
    settled_ = true;
    standing_ = Standing::None;
    want(Reason::Boot, Haste::Now, now);
  }

  /** The slot changed: a new `seq`, sent at once (a change cuts any backoff short). */
  void slotChanged(const Uid& slot, Millis now) {
    slot_ = slot;
    changedAt_ = now;
    ++seq_;
    // What the hub said was about the cartridge before.
    standing_ = Standing::None;
    want(Reason::Change, Haste::Now, now);
    if (slot.size > 0) {
      awaitInsert(now);
    } else {
      insertOpen_ = false;
    }
  }

  /**
   * The reader stopped or started working: the hub hears it with the next report, which goes at once unless the
   * player is waiting out a backoff. A reader's health isn't worth cutting that short (a flapping reader would
   * otherwise knock on an absent hub every second).
   */
  void readerChanged(bool fault, Millis now) {
    if (fault == readerFault_) return;
    readerFault_ = fault;
    if (settled_) want(Reason::Heartbeat, Haste::WhenFree, now);
  }

  /** Wi-Fi came back. */
  void linkUp(Millis now) {
    if (settled_) want(delivered_ ? Reason::Reconnect : Reason::Boot, Haste::Now, now);
  }

  /** New hub settings were saved in setup: say hello to it at once. */
  void hubChanged(Millis now) {
    hub_ = HubState::Unknown;
    retryDelay_ = FIRST_RETRY_MS;
    refusals_ = 0;
    if (settled_) want(Reason::Pair, Haste::Now, now);
  }

  /** True when a report should start now. The caller checks the link and that nothing else is in flight. */
  bool ready(Millis now) {
    if (!settled_ || inFlight_) return false;
    // Wanting the heartbeat stamps the attempt time too: left at the last change, it would fall out of the range
    // `reached` can compare after 24 days of nothing but heartbeats, and the player would go silent for weeks.
    if (!pending_ && reached(now, heartbeatAt_)) want(Reason::Heartbeat, Haste::WhenFree, now);
    return pending_ && reached(now, nextAttemptAt_);
  }

  /** Starts a report: what to send. */
  ReportDraft begin() {
    inFlight_ = true;
    wantedInFlight_ = false;
    hurryInFlight_ = false;
    sentSeq_ = seq_;
    return {seq_, reason_, slot_, changedAt_, readerFault_};
  }

  /** What came of the report in flight. Returns the cue to play now (`None` for silence). */
  Cue finish(int status, const Answer& answer, Millis now) {
    inFlight_ = false;
    const Delivery delivery = reportDelivery(status, answer);
    const bool aboutInsert = insertOpen_ && sentSeq_ >= insertSeq_;
    Cue cue = Cue::None;
    switch (delivery) {
      case Delivery::Delivered:
        hub_ = HubState::Ok;
        delivered_ = true;
        retryDelay_ = FIRST_RETRY_MS;
        refusals_ = 0;
        if (answer.heartbeatS > 0) heartbeatMs_ = clampHeartbeat(answer.heartbeatS);
        if (answer.result[0]) copyText(lastResult_, sizeof lastResult_, answer.result);
        if (aboutInsert) insertOpen_ = false;
        cue = answer.cue;
        // An answer about a slot that has changed since still plays its cue, but says nothing about what is in now.
        if (sentSeq_ == seq_) stand(cue, answer.result);
        settleSent(true, now);
        break;
      case Delivery::Dropped:
        hub_ = HubState::BadRequest;
        retryDelay_ = FIRST_RETRY_MS;
        // The plugin itself answered, so the hub is up: an earlier refusal wasn't its last word.
        refusals_ = 0;
        settleSent(false, now);
        cue = refusedInsert(aboutInsert);
        break;
      case Delivery::KeyRejected:
      case Delivery::NotFound:
        retryDelay_ = FIRST_RETRY_MS;
        if (refusals_ < REFUSALS_BEFORE_RED) {
          hub_ = HubState::Unreachable;
          nextAttemptAt_ = now + REFUSED_SOON_MS[refusals_];
          ++refusals_;
        } else {
          hub_ = delivery == Delivery::KeyRejected ? HubState::KeyRejected : HubState::NotFound;
          nextAttemptAt_ = now + REFUSED_RETRY_MS;
        }
        cue = refusedInsert(aboutInsert);
        break;
      case Delivery::Retry: {
        hub_ = HubState::Unreachable;
        const Millis asked = requestedWait(answer);
        if (asked > 0) {
          nextAttemptAt_ = now + (asked < MAX_REQUESTED_WAIT_MS ? asked : MAX_REQUESTED_WAIT_MS);
        } else {
          nextAttemptAt_ = now + retryDelay_;
          retryDelay_ = retryDelay_ * 2 < MAX_RETRY_MS ? retryDelay_ * 2 : MAX_RETRY_MS;
        }
        break;
      }
    }
    // A slot change or Wi-Fi coming back during the request cuts whatever wait its outcome set.
    if (hurryInFlight_) nextAttemptAt_ = now;
    return cue;
  }

  /** Call every loop: `Error` once when a new cartridge has waited too long for the hub. */
  Cue tick(Millis now) {
    if (insertOpen_ && !insertErrored_ && since(now, insertAt_) >= INSERT_PATIENCE_MS) {
      insertErrored_ = true;
      return Cue::Error;
    }
    return Cue::None;
  }

  /** A report about a new cartridge is out and unanswered (the light blinks blue). */
  bool reading() const { return insertOpen_ && !insertErrored_; }
  /** What the hub last said about the cartridge in the slot (the light until it comes out). */
  Standing standing() const { return standing_; }
  HubState hub() const { return hub_; }
  /** The `result` of the last reply, for the serial status. */
  const char* lastResult() const { return lastResult_; }
  Millis heartbeatMs() const { return heartbeatMs_; }

 private:
  /** Whether wanting a report cuts a wait (backoff, refused retry) short. */
  enum class Haste : uint8_t { Now, WhenFree };

  static Millis clampHeartbeat(uint32_t seconds) {
    if (seconds < 5) return 5000;
    if (seconds > 3600) return 3600000;
    return seconds * 1000;
  }

  /** Marks a report as wanted, keeping the reason that matters most to the plugin. */
  void want(Reason reason, Haste haste, Millis now) {
    if (inFlight_) {
      if (!wantedInFlight_ || rank(reason) > rank(flightReason_)) flightReason_ = reason;
      wantedInFlight_ = true;
      if (haste == Haste::Now) hurryInFlight_ = true;
    }
    if (haste == Haste::Now || !pending_) nextAttemptAt_ = now;
    if (!pending_ || rank(reason) > rank(reason_)) reason_ = reason;
    pending_ = true;
  }

  static int rank(Reason reason) {
    switch (reason) {
      case Reason::Pair: return 4;
      case Reason::Boot: return 3;
      case Reason::Change: return 2;
      case Reason::Reconnect: return 1;
      case Reason::Heartbeat: return 0;
    }
    return 0;
  }

  void awaitInsert(Millis now) {
    insertOpen_ = true;
    insertErrored_ = false;
    insertSeq_ = seq_;
    insertAt_ = now;
  }

  /**
   * The report was answered (or refused for good): the next one is the heartbeat, unless something was wanted while
   * it was out. That follow-up carries only the reasons wanted since it left. With the answered report's own reason
   * and `seq` it would look like a retry of it, and the plugin would answer with the same reply and cue again.
   */
  void settleSent(bool delivered, Millis now) {
    pending_ = wantedInFlight_;
    heartbeatAt_ = now + heartbeatMs_;
    if (!wantedInFlight_) return;
    // The hub has just heard this boot, so Wi-Fi coming back meanwhile is a reconnect.
    reason_ = delivered && flightReason_ == Reason::Boot ? Reason::Reconnect : flightReason_;
    nextAttemptAt_ = now;
  }

  /**
   * The cartridge stands as the hub's cue says, until it comes out or the hub says otherwise. Only the hub's own
   * answers count: an `error` the player plays because no answer came says nothing about the cartridge, and the
   * light then shows why instead (the hub can't be reached, or refuses). `none` (a heartbeat's `unchanged`) leaves
   * the standing as it is. `ok` covers two things the interface shows differently, so the result tells them apart:
   * `marked` is a point in time with nothing running after it; anything else is a session that is tracking.
   */
  void stand(Cue cue, const char* result) {
    if (slot_.size == 0) return;
    switch (cue) {
      case Cue::Ok:
        standing_ = std::strcmp(result, RESULT_MARKED) == 0 ? Standing::Marked : Standing::Tracking;
        break;
      case Cue::Unknown: standing_ = Standing::Unknown; break;
      case Cue::Error: standing_ = Standing::Error; break;
      case Cue::Bye: standing_ = Standing::None; break;
      case Cue::None: break;
    }
  }

  /** The hub refused a report about a new cartridge: say so at once, rather than after the patience runs out. */
  Cue refusedInsert(bool aboutInsert) {
    if (!aboutInsert || insertErrored_) return Cue::None;
    insertErrored_ = true;
    return Cue::Error;
  }

  uint32_t boot_;
  uint32_t seq_ = 0;
  uint32_t sentSeq_ = 0;
  Uid slot_ = NO_UID;
  Millis changedAt_ = 0;
  bool readerFault_ = false;
  bool settled_ = false;

  bool pending_ = false;
  Reason reason_ = Reason::Boot;
  bool inFlight_ = false;
  /** Since the report in flight left: something was wanted, the strongest reason for it, and whether it can't wait. */
  bool wantedInFlight_ = false;
  Reason flightReason_ = Reason::Heartbeat;
  bool hurryInFlight_ = false;
  bool delivered_ = false;
  Millis nextAttemptAt_ = 0;
  Millis retryDelay_ = FIRST_RETRY_MS;
  /** 401/403/404 answers in a row. */
  uint8_t refusals_ = 0;
  Millis heartbeatMs_ = DEFAULT_HEARTBEAT_S * 1000;
  Millis heartbeatAt_ = 0;
  HubState hub_ = HubState::Unknown;
  char lastResult_[16] = "";
  Standing standing_ = Standing::None;

  bool insertOpen_ = false;
  bool insertErrored_ = false;
  uint32_t insertSeq_ = 0;
  Millis insertAt_ = 0;
};

}  // namespace cp
