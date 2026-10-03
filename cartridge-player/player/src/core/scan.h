// The setup page's list of networks (DESIGN.md "Setup page API", GET /api/scan): when a scan is wanted, how long the
// radio is asked for one, and what the page is told meanwhile. Pure: hal/portal.cpp asks the radio and keeps the list.
#pragma once

#include <cstdint>

#include "clock.h"

namespace cp {

class NetworkScan {
 public:
  /** A list younger than this is answered as it is; an older one starts a fresh scan. */
  static constexpr Millis FRESH_MS = 15000;
  /** The radio can't scan while the station is joining, so a wanted scan is asked for again this often… */
  static constexpr Millis RETRY_MS = 1000;
  /** …for this long. Then the page is told there is no new list. */
  static constexpr Millis TIMEOUT_MS = 12000;

  /** What a request is answered, beside the list. */
  struct Told {
    /** A new list is on its way: ask again. */
    bool scanning;
    /** The last scan gave up, so the list is the one from before (if any). */
    bool failed;
  };

  /**
   * A request for the list. A scan that gave up is said once, to the first request that finds it so, and that
   * request starts nothing: the page shows the failure and offers to scan again. The one after starts over.
   */
  Told request(Millis now) {
    const bool failed = failed_;
    failed_ = false;
    const bool fresh = listed_ && since(now, listedAt_) < FRESH_MS;
    if (!failed && !wanted_ && !fresh) {
      wanted_ = true;
      wantedAt_ = now;
      startAt_ = now;
    }
    return {wanted_, failed};
  }

  /** True when the radio should be asked for a scan now. Then call `started`. */
  bool startDue(Millis now) const { return wanted_ && !running_ && reached(now, startAt_); }

  /** The radio took the scan, or (false) refused it or broke it off: it is asked again shortly. */
  void started(bool running, Millis now) {
    running_ = running;
    if (!running) startAt_ = now + RETRY_MS;
  }

  /** The running scan produced its list. */
  void listed(Millis now) {
    listed_ = true;
    listedAt_ = now;
    end();
  }

  /**
   * True once when a wanted scan has taken too long: it is given up. Nothing is recorded as listed, so a later
   * request starts over instead of being handed an old or empty list as if it were fresh.
   */
  bool timedOut(Millis now) {
    if (!wanted_ || since(now, wantedAt_) < TIMEOUT_MS) return false;
    end();
    failed_ = true;
    return true;
  }

  /** Setup mode closed: whatever was wanted is dropped, and nobody is left to be told that it failed. */
  void abandon() {
    end();
    failed_ = false;
  }

  /** A scan is wanted and not over: the station holds still meanwhile, and the page is told "scanning". */
  bool wanted() const { return wanted_; }
  /** The radio is scanning right now. */
  bool running() const { return running_; }

 private:
  void end() {
    wanted_ = false;
    running_ = false;
  }

  bool wanted_ = false;
  bool running_ = false;
  bool failed_ = false;
  bool listed_ = false;
  Millis wantedAt_ = 0;
  Millis startAt_ = 0;
  Millis listedAt_ = 0;
};

}  // namespace cp
