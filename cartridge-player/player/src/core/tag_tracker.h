// What is in the slot, from a stream of reader polls. The reader answers every ~50 ms with "this UID", "nothing" or
// "I'm not working"; a cartridge being slid in or out flickers between the first two. The tracker turns that into a
// settled slot, so the plugin only hears about real changes, and says whether that slot is something the reader has
// actually read (DESIGN.md "Player", Reading).
#pragma once

#include <cstdint>

#include "clock.h"
#include "uid.h"

namespace cp {

/** One poll's answer. */
enum class Read : uint8_t { Present, Absent, Fault };

/** What one poll changed. A swap is both: the old cartridge out, then the new one in. */
struct SlotStep {
  bool out = false;
  bool in = false;
  /** True exactly once: the first time the slot can be reported after power-up. */
  bool settled = false;
};

class TagTracker {
 public:
  /** Two identical reads in a row put a cartridge in. */
  static constexpr uint8_t IN_READS = 2;
  /** A cartridge is out once missing for this many polls in a row and this long. */
  static constexpr uint8_t OUT_POLLS = 3;
  static constexpr Millis OUT_MS = 400;
  /**
   * A reader that is faulty from power-up never settles the slot by itself. After this long the slot settles without
   * having been read (`known()` stays false), so the hub hears from the player and can say what is wrong.
   */
  static constexpr Millis FAULT_SETTLE_MS = 3000;

  explicit TagTracker(Millis now) : lastSeenAt_(now), startedAt_(now) {}

  SlotStep update(Read read, const Uid& uid, Millis now) {
    SlotStep step;
    if (read == Read::Fault) {
      // A fault is never "out": the slot keeps its value, and the misses before it don't count any more. But the
      // reader was blind, so that value is no longer something it has read.
      known_ = false;
      candidateReads_ = 0;
      misses_ = 0;
      lastSeenAt_ = now;
      if (!settled_ && since(now, startedAt_) >= FAULT_SETTLE_MS) {
        settled_ = true;
        step.settled = true;
      }
      return step;
    }
    const bool present = read == Read::Present && uid.size > 0 && !isRandomUid(uid);
    if (present && slot_.size > 0 && sameUid(uid, slot_)) {
      misses_ = 0;
      candidateReads_ = 0;
      lastSeenAt_ = now;
      known_ = true;
      return step;
    }
    if (present) {
      if (candidateReads_ > 0 && sameUid(uid, candidate_)) {
        ++candidateReads_;
      } else {
        candidate_ = uid;
        candidateReads_ = 1;
      }
      if (candidateReads_ >= IN_READS) {
        step.out = slot_.size > 0;
        step.in = true;
        step.settled = !settled_;
        settled_ = true;
        known_ = true;
        slot_ = uid;
        candidateReads_ = 0;
        misses_ = 0;
        lastSeenAt_ = now;
        return step;
      }
    } else {
      candidateReads_ = 0;
    }
    // Nothing (or another, not yet confirmed UID) where the slot's cartridge, or nothing, was expected.
    if (misses_ < 255) ++misses_;
    if (misses_ >= OUT_POLLS && since(now, lastSeenAt_) >= OUT_MS) {
      if (slot_.size > 0) {
        step.out = true;
        slot_ = NO_UID;
      }
      if (!settled_) {
        settled_ = true;
        step.settled = true;
      }
      known_ = true;
    }
    return step;
  }

  /** The settled slot: a UID, or NO_UID when empty (or not read yet). */
  const Uid& slot() const { return slot_; }
  bool settled() const { return settled_; }
  /**
   * The slot is what the reader found there. False until the first read settles it, and from a failed poll until
   * the slot has been read again: its cartridge seen once more, another read twice, or nothing for `OUT_POLLS` and
   * `OUT_MS`. A cartridge can come or go while the reader is blind, so until then `slot()` is only the last value
   * read (nothing at all, after a power-up with a dead reader), and must not be passed on as the reader's word.
   */
  bool known() const { return known_; }

 private:
  Uid slot_ = NO_UID;
  Uid candidate_ = NO_UID;
  uint8_t candidateReads_ = 0;
  uint8_t misses_ = 0;
  Millis lastSeenAt_;
  Millis startedAt_;
  bool settled_ = false;
  bool known_ = false;
};

}  // namespace cp
