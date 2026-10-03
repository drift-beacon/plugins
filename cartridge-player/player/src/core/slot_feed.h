// The wiring between the reader's polls, the slot and the reports: what the tracker made of a poll, told to the
// reporter, and the body of the report the reporter then asks for. It lives in the core so the firmware (app.cpp) and
// the contract with the plugin (player/tests/contract.cpp, tests/firmware.test.mjs) run the same lines: the order of
// "out" and "in" decides `seq`, and this decides when the reader counts as faulty.
//
// The plugin trusts the slot a report carries (DESIGN.md "Main", step 1), so one rule holds here: a report says the
// reader is "ok" only about a slot the reader has read. A slot it couldn't read goes out with the fault instead.
#pragma once

#include <cstdint>

#include "clock.h"
#include "device.h"
#include "protocol.h"
#include "reporter.h"
#include "tag_tracker.h"
#include "uid.h"

namespace cp {

class SlotFeed {
 public:
  /**
   * The reader counts as faulty once the slot has gone unread this long. A single bad poll (a chip that reset itself
   * and was set up again on the spot) isn't worth a report or a fault light: the slot is read again within half a
   * second, and until then the report carries what was read just before.
   */
  static constexpr Millis FAULT_HOLD_MS = 1000;

  /** One reader poll: moves the slot and tells the reporter what changed. Returns the step, for the log. */
  SlotStep poll(TagTracker& tracker, Reporter& reporter, Read read, const Uid& uid, Millis now) {
    const SlotStep step = tracker.update(read, uid, now);
    // The fault ends with the first read of the slot, not with the first poll that works: a reader back from a
    // fault hasn't seen yet whether its cartridge is still there, and one dead from power-up has never seen any.
    holdFault(!tracker.known(), now);
    if (step.settled) {
      // A slot that settled without ever being read goes out with the fault, whatever the hold says.
      if (!tracker.known()) fault_ = true;
      reporter.settle(tracker.slot(), fault_, now);
    } else {
      // A swap is two changes, the old cartridge out and then the new one in, so `seq` goes up by two.
      if (step.out) reporter.slotChanged(NO_UID, now);
      if (step.in) reporter.slotChanged(tracker.slot(), now);
    }
    reporter.readerChanged(fault_, now);
    return step;
  }

  /** The slot has been unread for `FAULT_HOLD_MS` or more: what reports and the light call a reader fault. */
  bool readerFault() const { return fault_; }

 private:
  void holdFault(bool unread, Millis now) {
    if (!unread) {
      failing_ = false;
      fault_ = false;
    } else if (!failing_) {
      failing_ = true;
      failingSince_ = now;
    } else if (since(now, failingSince_) >= FAULT_HOLD_MS) {
      fault_ = true;
    }
  }

  bool failing_ = false;
  bool fault_ = false;
  Millis failingSince_ = 0;
};

/** The report for a draft: the slot as the reporter has it, plus who the player is and how it is doing. */
inline ReportBody reportBody(const ReportDraft& draft, const Identity& identity, uint32_t boot, bool hasRssi,
                             int32_t rssi, uint32_t uptimeS, Millis now) {
  ReportBody body;
  body.deviceId = identity.id;
  body.firmware = FIRMWARE_VERSION;
  body.name = identity.name;
  body.boot = boot;
  body.seq = draft.seq;
  body.reason = draft.reason;
  body.tag = draft.tag;
  body.ageMs = since(now, draft.changedAt);
  body.hasRssi = hasRssi;
  body.rssi = rssi;
  body.uptimeS = uptimeS;
  body.readerFault = draft.readerFault;
  return body;
}

}  // namespace cp
