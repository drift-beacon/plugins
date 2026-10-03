// When the player is in setup mode, and when its station should try the saved network again (DESIGN.md "Player",
// Setup mode). The access point, its DNS and the setup page exist only in setup mode; in run mode the radio is a
// station and nothing listens. Timestamps are set on every transition, so no timeout runs from a stale start.
#pragma once

#include <cstdint>

#include "clock.h"

namespace cp {

/** Why setup mode is open. */
enum class SetupReason : uint8_t { None, Unconfigured, Button, Serial, Offline };

inline const char* setupReasonName(SetupReason reason) {
  switch (reason) {
    case SetupReason::None: return "closed";
    case SetupReason::Unconfigured: return "not set up yet";
    case SetupReason::Button: return "BOOT button";
    case SetupReason::Serial: return "serial CONFIG";
    case SetupReason::Offline: return "saved Wi-Fi not found";
  }
  return "closed";
}

/**
 * Whether two IPv4 addresses are on one subnet (all three numbers in the same byte order). The setup page answers a
 * client only when the client's own address is on the access point's subnet: the address a request was sent to
 * doesn't say which side it came in on.
 */
constexpr bool sameSubnet(uint32_t a, uint32_t b, uint32_t mask) { return ((a ^ b) & mask) == 0; }

/**
 * Whether a connection whose own end is `local` runs over the station: its address is the station's (0 while the
 * station has none) and not the access point's. The loop's "station is up" is a pass old by the time a request
 * connects, and with the station gone the open access point is the only way out that is left. Only the access
 * point's own address is ruled out, not its subnet: a home network that hands out that range must still work in run
 * mode, where there is no access point.
 */
constexpr bool overStation(uint32_t local, uint32_t station, uint32_t accessPoint) {
  return station != 0 && local == station && local != accessPoint;
}

class Link {
 public:
  /** Saved Wi-Fi that hasn't connected for this long since power-up (or since setup last closed) opens setup. */
  static constexpr Millis OFFLINE_SETUP_MS = 5 * 60 * 1000;
  /**
   * Setup closes after this long without a request from the setup page itself (unless the player isn't set up).
   * Captive-portal probes and other stray requests from a phone left on the network don't count.
   */
  static constexpr Millis SETUP_IDLE_MS = 10 * 60 * 1000;
  /** After a successful Connect the access point stays this long, so the phone can show the result. */
  static constexpr Millis DONE_GRACE_MS = 60 * 1000;
  /** A join that neither connects nor fails in this long is given up and tried again. */
  static constexpr Millis JOIN_TIMEOUT_MS = 20 * 1000;
  static constexpr Millis FIRST_REJOIN_MS = 2000;
  static constexpr Millis MAX_REJOIN_MS = 60 * 1000;
  /** How soon to ask again when the radio wouldn't take a join (it was still busy with its last one). */
  static constexpr Millis BUSY_REJOIN_MS = 1000;
  /**
   * `POST /api/exit` is answered first and obeyed this much later: a phone saving power only hears from the access
   * point at its next beacon, and an access point that is already gone can't deliver the answer.
   */
  static constexpr Millis EXIT_DELAY_MS = 800;

  /** What `POST /api/exit` is told. */
  enum class Exit : uint8_t { Leaving, NotSetUp, Connecting };

  void begin(bool configured, bool hasWifi, Millis now) {
    configured_ = configured;
    hasWifi_ = hasWifi;
    offlineFrom_ = now;
    joinAt_ = now;
    if (!configured) open(SetupReason::Unconfigured, now);
  }

  /** Settings were saved (or erased). */
  void settingsChanged(bool configured, bool hasWifi, Millis now) {
    configured_ = configured;
    hasWifi_ = hasWifi;
    joinAt_ = now;
    rejoinDelay_ = FIRST_REJOIN_MS;
    if (!configured && !inSetup()) open(SetupReason::Unconfigured, now);
  }

  void stationUp(Millis /*now*/) {
    up_ = true;
    asked_ = true;
    joining_ = false;
    everUp_ = true;
    rejoinDelay_ = FIRST_REJOIN_MS;
  }

  void stationDown(Millis now) {
    const bool wasUp = up_;
    up_ = false;
    if (!joining_ && !wasUp) return;
    joining_ = false;
    joinAt_ = now + (wasUp ? 1000 : rejoinDelay_);
    if (!wasUp) rejoinDelay_ = rejoinDelay_ * 2 < MAX_REJOIN_MS ? rejoinDelay_ * 2 : MAX_REJOIN_MS;
  }

  /** The player itself took the station off its network: down, and nothing more is expected of that network. */
  void stationLeft(Millis now) {
    stationDown(now);
    asked_ = false;
  }

  /**
   * Whether an address the station reports can be for a network the player still wants. After a leave of its own it
   * can't, until the next join: an event from the network just left may still be on its way, and its name doesn't
   * tell it from the saved network when the two share one. A join that failed or timed out doesn't end the
   * expectation: the driver may still be trying (it retries a first failed join by itself), and a lease can come
   * back to a station that stayed associated.
   */
  bool expectsUp() const { return asked_; }

  /**
   * The BOOT button or the serial CONFIG command. Asked for while already open, it means "keep it open": someone is
   * at the player, so setup stays until they are done or idle. That calls off a close that was on its way (after a
   * finished Connect, after Leave setup) and the close when the saved Wi-Fi comes back.
   */
  void requestSetup(SetupReason reason, Millis now) {
    if (!inSetup()) {
      open(reason, now);
      return;
    }
    lastRequestAt_ = now;
    done_ = false;
    leaving_ = false;
    held_ = true;
  }

  /** A request from the setup page itself arrived. */
  void touched(Millis now) { lastRequestAt_ = now; }

  /**
   * A Connect started: the attempt owns the station until it ends. Setup opened for want of Wi-Fi no longer closes
   * by itself when Wi-Fi comes up: that would take the access point away before the phone has seen how the Connect
   * went.
   */
  void attemptStarted() {
    attempt_ = true;
    joining_ = false;
    done_ = false;
    leaving_ = false;
    held_ = true;
  }

  /** The attempt ended. A successful one closes setup after the grace period; a failed one leaves it open. */
  void attemptEnded(bool succeeded, Millis now) {
    attempt_ = false;
    lastRequestAt_ = now;
    if (succeeded) {
      done_ = true;
      doneAt_ = now;
    }
    joinAt_ = now;
  }

  /**
   * `POST /api/exit`: setup closes once the answer has had time to arrive. Refused during a Connect, and when the
   * player isn't set up.
   */
  Exit exitSetup(Millis now) {
    if (attempt_) return Exit::Connecting;
    if (!configured_) return Exit::NotSetUp;
    leaving_ = true;
    leaveAt_ = now + EXIT_DELAY_MS;
    return Exit::Leaving;
  }

  /** The station is free for the setup page's scan (the scan fails while the station is joining). */
  void pauseStation(bool paused) { paused_ = paused; }

  /** Runs the timeouts. Call every loop. */
  void update(Millis now) {
    if (joining_ && since(now, joinStartedAt_) >= JOIN_TIMEOUT_MS) stationDown(now);
    if (!inSetup()) {
      if (configured_ && !everUp_ && !up_ && since(now, offlineFrom_) >= OFFLINE_SETUP_MS) {
        open(SetupReason::Offline, now);
      }
      return;
    }
    if (!configured_ || attempt_) return;
    if (leaving_) {
      if (reached(now, leaveAt_)) close(now);
      return;
    }
    if (done_) {
      if (since(now, doneAt_) >= DONE_GRACE_MS) close(now);
      return;
    }
    if (reason_ == SetupReason::Offline && up_ && !held_) {
      close(now);
    } else if (since(now, lastRequestAt_) >= SETUP_IDLE_MS) {
      close(now);
    }
  }

  /** True when the station should try the saved network now. Then call `joinStarted`. */
  bool shouldJoin(Millis now) const {
    return hasWifi_ && !up_ && !joining_ && !attempt_ && !paused_ && reached(now, joinAt_);
  }
  void joinStarted(Millis now) {
    asked_ = true;
    joining_ = true;
    joinStartedAt_ = now;
  }
  /** The radio wouldn't take the join: ask again shortly. */
  void joinRefused(Millis now) { joinAt_ = now + BUSY_REJOIN_MS; }

  bool inSetup() const { return reason_ != SetupReason::None; }
  SetupReason reason() const { return reason_; }
  bool stationIsUp() const { return up_; }
  /** Bumped on every open and close, so the caller can tell that the radio needs changing. */
  uint32_t generation() const { return generation_; }

 private:
  void open(SetupReason reason, Millis now) {
    reason_ = reason;
    lastRequestAt_ = now;
    done_ = false;
    leaving_ = false;
    held_ = false;
    ++generation_;
  }

  void close(Millis now) {
    reason_ = SetupReason::None;
    done_ = false;
    leaving_ = false;
    offlineFrom_ = now;
    ++generation_;
  }

  bool configured_ = false;
  bool hasWifi_ = false;
  SetupReason reason_ = SetupReason::None;
  Millis lastRequestAt_ = 0;
  Millis offlineFrom_ = 0;
  bool attempt_ = false;
  bool done_ = false;
  Millis doneAt_ = 0;
  bool leaving_ = false;
  Millis leaveAt_ = 0;
  /** Someone used setup while it was open (a Connect, BOOT, CONFIG): Wi-Fi coming back no longer closes it. */
  bool held_ = false;
  uint32_t generation_ = 0;

  bool up_ = false;
  bool everUp_ = false;
  bool joining_ = false;
  /** A join was asked for, or the station was up, and the player hasn't left that network itself since. */
  bool asked_ = false;
  bool paused_ = false;
  Millis joinStartedAt_ = 0;
  Millis joinAt_ = 0;
  Millis rejoinDelay_ = FIRST_REJOIN_MS;
};

}  // namespace cp
