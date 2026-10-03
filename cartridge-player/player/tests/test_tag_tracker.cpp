// The slot as the plugin hears it, from raw polls (DESIGN.md "Player", Reading). Each test is a timeline of polls
// 50 ms apart, as the loop makes them.
#include "../src/core/tag_tracker.h"

#include "check.h"

using namespace cp;

namespace {

const Uid A = {{0x04, 0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6}, 7};
const Uid B = {{0x04, 0x11, 0x22, 0x33}, 4};
const Uid RANDOM = {{0x08, 0x55, 0x66, 0x77}, 4};

/** Polls every 50 ms, counting what the tracker reports. */
struct Timeline {
  TagTracker tracker{0};
  Millis now = 0;
  int ins = 0;
  int outs = 0;
  int settles = 0;

  SlotStep poll(Read read, const Uid& uid = NO_UID) {
    now += 50;
    const SlotStep step = tracker.update(read, uid, now);
    ins += step.in;
    outs += step.out;
    settles += step.settled;
    return step;
  }
  void polls(int count, Read read, const Uid& uid = NO_UID) {
    for (int i = 0; i < count; ++i) poll(read, uid);
  }
  bool holds(const Uid& uid) const { return sameUid(tracker.slot(), uid); }
};

/** A timeline with A settled in the slot. */
Timeline withA() {
  Timeline t;
  t.polls(2, Read::Present, A);
  return t;
}

}  // namespace

int main() {
  check::run("a cartridge counts as in after two identical reads, not one", [] {
    Timeline t;
    t.poll(Read::Present, A);
    CHECK(t.ins == 0);
    CHECK(!t.tracker.settled());
    const SlotStep step = t.poll(Read::Present, A);
    CHECK(step.in && step.settled && !step.out);
    CHECK(t.holds(A));
  });

  check::run("a cartridge counts as out only when missing for 3 polls and 400 ms", [] {
    Timeline t = withA();
    t.polls(3, Read::Absent);  // 150 ms: three polls, but too soon
    CHECK(t.outs == 0);
    CHECK(t.holds(A));
    t.polls(4, Read::Absent);  // 350 ms
    CHECK(t.outs == 0);
    t.poll(Read::Absent);  // 400 ms since the last read
    CHECK(t.outs == 1);
    CHECK(t.tracker.slot().size == 0);
  });

  check::run("a flickering read (a cartridge being seated) never makes an out", [] {
    Timeline t = withA();
    for (int i = 0; i < 20; ++i) {
      t.polls(2, Read::Absent);
      t.poll(Read::Present, A);
    }
    CHECK(t.outs == 0);
    CHECK(t.holds(A));
  });

  check::run("a swap is out(old) then in(new) in the same step, after two reads of the new one", [] {
    Timeline t = withA();
    t.poll(Read::Present, B);
    CHECK(t.ins == 1);
    const SlotStep step = t.poll(Read::Present, B);
    CHECK(step.out && step.in && !step.settled);
    CHECK(t.holds(B));
  });

  check::run("re-seating the same cartridge right after it came out counts as in again", [] {
    Timeline t = withA();
    t.polls(8, Read::Absent);
    CHECK(t.outs == 1);
    t.polls(2, Read::Present, A);
    CHECK(t.ins == 2);
    CHECK(t.holds(A));
  });

  check::run("a reader fault is never out: the slot keeps its cartridge however long it lasts", [] {
    Timeline t = withA();
    t.polls(2, Read::Absent);
    t.polls(100, Read::Fault);  // five seconds of a dead reader
    CHECK(t.outs == 0);
    CHECK(t.holds(A));
    // Back from the fault, the misses before it don't count: out needs fresh evidence.
    t.polls(3, Read::Absent);
    CHECK(t.outs == 0);
    t.polls(5, Read::Absent);
    CHECK(t.outs == 1);
  });

  check::run("the slot is known only when read: not before the first settled read, nor after a failed poll", [] {
    Timeline t;
    CHECK(!t.tracker.known());
    t.poll(Read::Present, A);
    CHECK(!t.tracker.known());
    t.poll(Read::Present, A);
    CHECK(t.tracker.known());
    // One failed poll and the reader no longer vouches for the slot, though the slot keeps its cartridge.
    t.poll(Read::Fault);
    CHECK(!t.tracker.known() && t.holds(A));
    // Seeing that cartridge once more is a read.
    t.poll(Read::Present, A);
    CHECK(t.tracker.known());
    // Another cartridge after a fault takes its two reads.
    t.poll(Read::Fault);
    t.poll(Read::Present, B);
    CHECK(!t.tracker.known() && t.holds(A));
    t.poll(Read::Present, B);
    CHECK(t.tracker.known() && t.holds(B));
    // Nothing after a fault is only "empty" once it has been nothing for 3 polls and 400 ms.
    t.poll(Read::Fault);
    t.polls(7, Read::Absent);
    CHECK(!t.tracker.known() && t.holds(B));
    t.poll(Read::Absent);
    CHECK(t.tracker.known() && t.tracker.slot().size == 0);
    // And an empty slot is just as unknown after a fault as a full one.
    t.poll(Read::Fault);
    t.polls(7, Read::Absent);
    CHECK(!t.tracker.known());
    t.poll(Read::Absent);
    CHECK(t.tracker.known());
  });

  check::run("random-ID cards (phones) never go in", [] {
    Timeline t;
    t.polls(40, Read::Present, RANDOM);
    CHECK(t.ins == 0);
    CHECK(t.tracker.settled());
    CHECK(t.tracker.slot().size == 0);
  });

  check::run("two cartridges answering in turn don't flood the hub with changes", [] {
    Timeline t = withA();
    for (int i = 0; i < 40; ++i) {
      t.poll(Read::Present, B);
      t.poll(Read::Present, A);
    }
    CHECK(t.ins == 1);
    CHECK(t.outs == 0);
    CHECK(t.holds(A));
  });

  check::run("an empty slot at power-up settles once, after 3 polls and 400 ms", [] {
    Timeline t;
    t.polls(7, Read::Absent);
    CHECK(!t.tracker.settled());
    const SlotStep step = t.poll(Read::Absent);
    CHECK(step.settled && !step.in && !step.out);
    t.polls(20, Read::Absent);
    CHECK(t.settles == 1);
  });

  check::run("a reader dead from power-up settles the slot as empty after 3 s, so the hub hears the fault", [] {
    Timeline t;
    t.polls(59, Read::Fault);
    CHECK(!t.tracker.settled());
    t.poll(Read::Fault);
    CHECK(t.tracker.settled());
    CHECK(t.settles == 1);
    CHECK(t.tracker.slot().size == 0);
    // Settled, so the player can report; but nothing was read, so that empty slot is nobody's word.
    CHECK(!t.tracker.known());
    // Once the reader works, a cartridge already in goes in as a change.
    t.polls(2, Read::Present, A);
    CHECK(t.ins == 1);
    CHECK(t.settles == 1);
    CHECK(t.tracker.known());
  });

  check::run("the tracker keeps working across the 49-day wrap of millis()", [] {
    TagTracker tracker(0xFFFFFF00u);
    Millis now = 0xFFFFFF00u;
    for (int i = 0; i < 2; ++i) tracker.update(Read::Present, A, now += 50);
    int outs = 0;
    for (int i = 0; i < 8; ++i) outs += tracker.update(Read::Absent, NO_UID, now += 50).out;
    CHECK(outs == 1);
  });

  return check::result();
}
