// What a reader poll means to the reporter (core/slot_feed.h): which slot changes become reports, when a failing
// reader counts as a fault, and that no report calls a slot read ("ok") that the reader hasn't read (DESIGN.md
// "Player", Reading and Reporting). The firmware's loop makes these same calls.
#include "../src/core/slot_feed.h"

#include "check.h"

using namespace cp;

namespace {

const Uid A = {{0x04, 0xA1, 0xB2, 0xC3}, 4};
const Uid B = {{0x04, 0x0B, 0x00, 0x1C}, 4};
const char* const UNCHANGED = R"({"ok":true,"v":2,"seq":0,"result":"unchanged","cue":"none","heartbeat_s":30})";

/** A player polling every 50 ms, with a hub that answers every report at once. */
struct Player {
  TagTracker tracker{0};
  SlotFeed feed;
  Reporter reporter{7};
  Millis now = 0;
  int sent = 0;
  ReportDraft last = {0, Reason::Boot, NO_UID, 0, false};

  void poll(int count, Read read, const Uid& uid) {
    for (int i = 0; i < count; ++i) {
      now += 50;
      feed.poll(tracker, reporter, read, uid, now);
      if (!reporter.ready(now)) continue;
      last = reporter.begin();
      Answer answer;
      readAnswer(UNCHANGED, std::strlen(UNCHANGED), answer);
      reporter.finish(200, answer, now);
      ++sent;
    }
  }
};

/** A player with cartridge A in, its boot report answered. */
Player playing() {
  Player player;
  player.poll(2, Read::Present, A);
  CHECK(player.sent == 1 && sameUid(player.last.tag, A));
  return player;
}

}  // namespace

int main() {
  check::run("one failed poll is not a fault: a reader that reset and came back sends nothing and keeps the session", [] {
    Player player = playing();
    player.poll(1, Read::Fault, NO_UID);
    CHECK(!player.feed.readerFault());
    player.poll(20, Read::Present, A);
    CHECK(player.sent == 1);
    CHECK(sameUid(player.tracker.slot(), A));
  });

  check::run("a reader failing for a second is a fault: reported once with the slot kept, and again when it recovers", [] {
    Player player = playing();
    player.poll(20, Read::Fault, NO_UID);
    CHECK(!player.feed.readerFault() && player.sent == 1);
    player.poll(1, Read::Fault, NO_UID);
    CHECK(player.feed.readerFault());
    CHECK(player.sent == 2);
    CHECK(player.last.readerFault && player.last.seq == 0 && sameUid(player.last.tag, A));
    player.poll(100, Read::Fault, NO_UID);
    CHECK(player.sent == 2);
    // Seeing its cartridge again is a read of the slot: the fault is over at once.
    player.poll(1, Read::Present, A);
    CHECK(!player.feed.readerFault());
    CHECK(player.sent == 3);
    CHECK(!player.last.readerFault && player.last.seq == 0 && sameUid(player.last.tag, A));
  });

  check::run("a reader that drops out for under a second at a time never reports a fault", [] {
    Player player = playing();
    for (int i = 0; i < 20; ++i) {
      player.poll(15, Read::Fault, NO_UID);
      player.poll(1, Read::Present, A);
    }
    CHECK(player.sent == 1);
  });

  check::run("one failed poll over an empty slot sends nothing either: the slot is read again before the hold runs out", [] {
    Player player;
    player.poll(8, Read::Absent, NO_UID);
    CHECK(player.sent == 1 && player.last.tag.size == 0 && !player.last.readerFault);
    player.poll(1, Read::Fault, NO_UID);
    for (int i = 0; i < 20; ++i) {
      player.poll(1, Read::Absent, NO_UID);
      CHECK(!player.feed.readerFault());
    }
    CHECK(player.sent == 1);
  });

  check::run("a reader too flaky to read an empty slot is a fault: one good poll in sixteen proves nothing", [] {
    Player player;
    player.poll(8, Read::Absent, NO_UID);
    for (int i = 0; i < 3; ++i) {
      player.poll(15, Read::Fault, NO_UID);
      player.poll(1, Read::Absent, NO_UID);
    }
    CHECK(player.feed.readerFault());
    CHECK(player.sent == 2 && player.last.readerFault && player.last.tag.size == 0);
  });

  check::run("a swap is two changes, out then in: seq goes up by two and the report carries the new cartridge", [] {
    Player player = playing();
    player.poll(2, Read::Present, B);
    CHECK(player.sent == 2);
    CHECK(player.last.seq == 2 && player.last.reason == Reason::Change && sameUid(player.last.tag, B));
  });

  check::run("a reader dead from power-up: the boot report goes after 3 s, empty and with the fault", [] {
    Player player;
    player.poll(59, Read::Fault, NO_UID);
    CHECK(player.sent == 0);
    player.poll(1, Read::Fault, NO_UID);
    CHECK(player.sent == 1);
    CHECK(player.last.reason == Reason::Boot && player.last.readerFault && player.last.tag.size == 0);
  });

  check::run("a reader dead from power-up, cartridge left in: the slot is never called empty, the cartridge comes next", [] {
    Player player;
    player.poll(60, Read::Fault, NO_UID);
    CHECK(player.sent == 1 && player.last.readerFault);
    // The reader answers again. One poll isn't a read of the slot: the fault stands and nothing is sent, least of
    // all "empty, reader ok", which would end the session the cartridge has had running all along.
    player.poll(1, Read::Present, A);
    CHECK(player.feed.readerFault());
    CHECK(player.sent == 1);
    player.poll(1, Read::Present, A);
    CHECK(!player.feed.readerFault());
    CHECK(player.sent == 2);
    CHECK(player.last.reason == Reason::Change && player.last.seq == 1 && sameUid(player.last.tag, A));
    CHECK(!player.last.readerFault);
  });

  check::run("a reader dead from power-up, slot empty: reported empty and ok only once it was empty for 400 ms", [] {
    Player player;
    player.poll(60, Read::Fault, NO_UID);
    player.poll(7, Read::Absent, NO_UID);
    CHECK(player.feed.readerFault());
    CHECK(player.sent == 1);
    player.poll(1, Read::Absent, NO_UID);
    CHECK(!player.feed.readerFault());
    CHECK(player.sent == 2);
    CHECK(player.last.reason == Reason::Heartbeat && player.last.seq == 0 && player.last.tag.size == 0);
    CHECK(!player.last.readerFault);
  });

  check::run("a slot that settles unread goes out with the fault even when the first poll came late", [] {
    Player player;
    player.now = 2950;
    player.poll(1, Read::Fault, NO_UID);
    CHECK(player.sent == 1);
    CHECK(player.last.readerFault && player.last.tag.size == 0);
  });

  check::run("a cartridge taken out while the reader was dead is never reported as read: the fault stands until it is out", [] {
    Player player = playing();
    player.poll(40, Read::Fault, NO_UID);
    CHECK(player.sent == 2 && player.last.readerFault && sameUid(player.last.tag, A));
    player.poll(7, Read::Absent, NO_UID);
    CHECK(player.feed.readerFault());
    CHECK(player.sent == 2);
    player.poll(1, Read::Absent, NO_UID);
    CHECK(player.sent == 3);
    CHECK(player.last.reason == Reason::Change && player.last.seq == 1 && player.last.tag.size == 0);
    CHECK(!player.last.readerFault);
  });

  check::run("the report body is the draft plus the player's own details, with the slot's age", [] {
    const uint8_t mac[6] = {0x24, 0x58, 0x7C, 0xA1, 0xB2, 0xC3};
    const Identity identity = identityFrom(mac);
    const ReportDraft draft = {5, Reason::Change, A, 1000, true};
    const ReportBody body = reportBody(draft, identity, 99, true, -61, 12, 1750);
    CHECK_TEXT(body.deviceId, "cp-a1b2c3");
    CHECK_TEXT(body.name, "Cartridge-A1B2");
    CHECK_TEXT(body.firmware, FIRMWARE_VERSION);
    CHECK(body.boot == 99 && body.seq == 5 && body.reason == Reason::Change && sameUid(body.tag, A));
    CHECK(body.ageMs == 750);
    CHECK(body.hasRssi && body.rssi == -61 && body.uptimeS == 12 && body.readerFault);
  });

  return check::result();
}
