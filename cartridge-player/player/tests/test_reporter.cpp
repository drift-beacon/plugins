// When the player reports and what it does with the answer (DESIGN.md "Player", Reporting, Delivery, Feedback).
#include "../src/core/reporter.h"

#include "check.h"

using namespace cp;

namespace {

const Uid A = {{0x04, 0xA1, 0xB2, 0xC3}, 4};

Answer reply(const char* body) {
  Answer answer;
  readAnswer(body, std::strlen(body), answer);
  return answer;
}

const char* const STARTED = R"({"ok":true,"v":2,"seq":1,"result":"started","cue":"ok","heartbeat_s":30,"activity":"Deep work"})";
const char* const UNCHANGED = R"({"ok":true,"v":2,"seq":0,"result":"unchanged","cue":"none","heartbeat_s":30,"activity":null})";

/** A reporter whose boot report has been answered. */
Reporter running(Millis& now) {
  Reporter reporter(42);
  reporter.settle(NO_UID, false, now);
  CHECK(reporter.ready(now));
  reporter.begin();
  reporter.finish(200, reply(UNCHANGED), now);
  return reporter;
}

}  // namespace

int main() {
  check::run("nothing is reported before the slot is known; then a boot report with seq 0", [] {
    Reporter reporter(7);
    CHECK(!reporter.ready(0));
    reporter.settle(A, false, 100);
    CHECK(reporter.ready(100));
    const ReportDraft draft = reporter.begin();
    CHECK(draft.seq == 0);
    CHECK(draft.reason == Reason::Boot);
    CHECK(sameUid(draft.tag, A));
  });

  check::run("a cartridge found at power-up is not a new one: no reading light, no error while Wi-Fi joins", [] {
    Reporter reporter(7);
    reporter.settle(A, false, 0);
    CHECK(!reporter.reading());
    CHECK(reporter.tick(10000) == Cue::None);
  });

  check::run("each slot change raises seq by one and is sent at once; heartbeats repeat seq", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    now += 1000;
    CHECK(!reporter.ready(now));
    reporter.slotChanged(A, now);
    CHECK(reporter.ready(now));
    ReportDraft draft = reporter.begin();
    CHECK(draft.seq == 1 && draft.reason == Reason::Change);
    reporter.finish(200, reply(STARTED), now);
    now += 29999;
    CHECK(!reporter.ready(now));
    now += 1;
    CHECK(reporter.ready(now));
    draft = reporter.begin();
    CHECK(draft.seq == 1 && draft.reason == Reason::Heartbeat);
  });

  check::run("one request at a time; a change while one is out is sent as soon as it returns", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.slotChanged(A, now);
    reporter.begin();
    reporter.slotChanged(NO_UID, now + 10);
    CHECK(!reporter.ready(now + 10));
    reporter.finish(200, reply(STARTED), now + 20);
    CHECK(reporter.ready(now + 20));
    const ReportDraft draft = reporter.begin();
    CHECK(draft.seq == 2 && draft.tag.size == 0);
  });

  check::run("no answer or 502/503/504: retry the latest state after 0.5 s, doubling to 30 s", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.slotChanged(A, now);
    const Millis expected[] = {500, 1000, 2000, 4000, 8000, 16000, 30000, 30000};
    const int statuses[] = {-1, 502, 503, 504, -1, -1, -1, -1};
    for (int i = 0; i < 8; ++i) {
      CHECK(reporter.ready(now));
      reporter.begin();
      reporter.finish(statuses[i], Answer(), now);
      CHECK(!reporter.ready(now + expected[i] - 1));
      now += expected[i];
    }
    CHECK(reporter.hub() == HubState::Unreachable);
  });

  check::run("a 503 with code \"retry\" waits the retry_ms the plugin asked for", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.slotChanged(A, now);
    reporter.begin();
    reporter.finish(503, reply(R"({"ok":false,"v":2,"code":"retry","error":"Busy","retry_ms":2500})"), now);
    CHECK(!reporter.ready(now + 2499));
    CHECK(reporter.ready(now + 2500));
  });

  check::run("400 is not retried: the next report is the heartbeat (or the next change)", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.slotChanged(A, now);
    reporter.begin();
    reporter.finish(400, reply(R"({"ok":false,"v":2,"code":"bad_request","error":"seq"})"), now);
    CHECK(reporter.hub() == HubState::BadRequest);
    CHECK(!reporter.ready(now + 29999));
    CHECK(reporter.ready(now + 30000));
    CHECK(reporter.begin().reason == Reason::Heartbeat);
  });

  check::run("401, 403 and 404: error at once for a new cartridge; three quick retries, then red and every 60 s", [] {
    const int statuses[] = {401, 403, 404};
    for (int status : statuses) {
      Millis now = 0;
      Reporter reporter = running(now);
      reporter.slotChanged(A, now);
      CHECK(reporter.reading());
      reporter.begin();
      CHECK(reporter.finish(status, Answer(), now) == Cue::Error);
      CHECK(!reporter.reading());
      // A hub that is starting up refuses for a moment: not red yet, and asked again soon.
      const Millis soon[] = {2000, 5000, 15000};
      for (Millis wait : soon) {
        CHECK(reporter.hub() == HubState::Unreachable);
        CHECK(!reporter.ready(now + wait - 1));
        now += wait;
        CHECK(reporter.ready(now));
        reporter.begin();
        CHECK(reporter.finish(status, Answer(), now) == Cue::None);
      }
      CHECK(reporter.hub() == (status == 404 ? HubState::NotFound : HubState::KeyRejected));
      CHECK(!reporter.ready(now + 59999));
      CHECK(reporter.ready(now + 60000));
      CHECK(reporter.tick(now + 70000) == Cue::None);
    }
  });

  check::run("one 404 on a heartbeat is asked again within 2 s: a restarting hub doesn't make the player look offline", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    now += 30000;
    CHECK(reporter.ready(now));
    reporter.begin();
    reporter.finish(404, reply(R"({"success":false,"error":"Workspace not found"})"), now);
    CHECK(reporter.hub() == HubState::Unreachable);
    CHECK(reporter.ready(now + 2000));
    reporter.begin();
    reporter.finish(200, reply(UNCHANGED), now + 2000);
    CHECK(reporter.hub() == HubState::Ok);
  });

  check::run("refusals count in a row: an answer from the plugin, or new hub settings, starts the count again", [] {
    const auto refuse = [](Reporter& reporter, Millis& now, int times) {
      for (int i = 0; i < times; ++i) {
        now += 60000;
        CHECK(reporter.ready(now));
        reporter.begin();
        reporter.finish(401, Answer(), now);
      }
    };
    Millis now = 0;
    Reporter reporter = running(now);
    refuse(reporter, now, 3);
    CHECK(reporter.hub() == HubState::Unreachable);
    now += 60000;
    reporter.begin();
    reporter.finish(200, reply(UNCHANGED), now);
    refuse(reporter, now, 3);
    CHECK(reporter.hub() == HubState::Unreachable);
    // No answer at all says nothing about the key: the count stands.
    now += 60000;
    reporter.begin();
    reporter.finish(-1, Answer(), now);
    refuse(reporter, now, 1);
    CHECK(reporter.hub() == HubState::KeyRejected);
    reporter.hubChanged(now);
    refuse(reporter, now, 3);
    CHECK(reporter.hub() == HubState::Unreachable);
    now += 60000;
    reporter.begin();
    reporter.finish(400, reply(R"({"ok":false,"v":2,"code":"bad_request","error":"seq"})"), now);
    refuse(reporter, now, 3);
    CHECK(reporter.hub() == HubState::Unreachable);
  });

  check::run("a 2xx that isn't the plugin's reply is not delivered: shown as away, retried, and an insert still gets its error", [] {
    const char* const strangers[] = {"<html><body>It works!</body></html>", R"({"status":"ok"})", "",
                                     R"({"ok":true,"v":2,"seq":1,"result":"sta)"};
    for (const char* body : strangers) {
      Millis now = 0;
      Reporter reporter = running(now);
      reporter.slotChanged(A, now);
      reporter.begin();
      CHECK(reporter.finish(200, reply(body), now + 100) == Cue::None);
      CHECK(reporter.hub() == HubState::Unreachable);
      CHECK(reporter.reading());
      CHECK(!reporter.ready(now + 599));
      CHECK(reporter.ready(now + 600));
      CHECK(reporter.tick(now + 3000) == Cue::Error);
      // The repeat carries the same seq and reason, so the plugin answers it from its reply cache, cue and all.
      const ReportDraft again = reporter.begin();
      CHECK(again.seq == 1 && again.reason == Reason::Change);
      CHECK(reporter.finish(200, reply(STARTED), now + 3100) == Cue::Ok);
      CHECK(reporter.hub() == HubState::Ok);
    }
  });

  check::run("a new cartridge the hub can't hear about for 3 s plays error once; the light blinks until then", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.slotChanged(A, now);
    CHECK(reporter.reading());
    CHECK(reporter.tick(now + 2999) == Cue::None);
    CHECK(reporter.tick(now + 3000) == Cue::Error);
    CHECK(!reporter.reading());
    CHECK(reporter.tick(now + 9000) == Cue::None);
    // When it finally gets through, the plugin's own cue plays.
    reporter.begin();
    CHECK(reporter.finish(200, reply(STARTED), now + 9000) == Cue::Ok);
  });

  check::run("the reply's cue plays and the reading light stops when the hub answers", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.slotChanged(A, now);
    reporter.begin();
    CHECK(reporter.finish(200, reply(STARTED), now + 300) == Cue::Ok);
    CHECK(!reporter.reading());
    CHECK(reporter.tick(now + 5000) == Cue::None);
    CHECK_TEXT(reporter.lastResult(), "started");
  });

  check::run("a cartridge pulled out before the hub answered owes no error", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.slotChanged(A, now);
    reporter.slotChanged(NO_UID, now + 500);
    CHECK(!reporter.reading());
    CHECK(reporter.tick(now + 5000) == Cue::None);
  });

  check::run("heartbeat_s from the reply sets the heartbeat (within 5 s to 1 h)", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.slotChanged(A, now);
    reporter.begin();
    reporter.finish(200, reply(R"({"ok":true,"v":2,"seq":1,"result":"started","cue":"ok","heartbeat_s":10})"), now);
    CHECK(!reporter.ready(now + 9999));
    CHECK(reporter.ready(now + 10000));
    reporter.begin();
    reporter.finish(200, reply(R"({"ok":true,"heartbeat_s":1})"), now + 10000);
    CHECK(reporter.heartbeatMs() == 5000);
  });

  check::run("Wi-Fi coming back sends the state at once, cutting any backoff short", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.slotChanged(A, now);
    for (int i = 0; i < 6; ++i) {
      reporter.begin();
      reporter.finish(-1, Answer(), now);
      now += 60000;
    }
    reporter.begin();
    reporter.finish(-1, Answer(), now);
    reporter.linkUp(now + 100);
    CHECK(reporter.ready(now + 100));
    CHECK(reporter.begin().reason == Reason::Change);
  });

  check::run("reconnect is the reason once the hub has heard this boot; boot until then", [] {
    Reporter fresh(1);
    fresh.settle(NO_UID, false, 0);
    fresh.begin();
    fresh.finish(-1, Answer(), 0);
    fresh.linkUp(100);
    CHECK(fresh.begin().reason == Reason::Boot);
    Millis now = 0;
    Reporter heard = running(now);
    heard.linkUp(5000);
    CHECK(heard.ready(5000));
    CHECK(heard.begin().reason == Reason::Reconnect);
  });

  check::run("new hub settings say hello at once with reason pair", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.hubChanged(now + 100);
    CHECK(reporter.hub() == HubState::Unknown);
    CHECK(reporter.ready(now + 100));
    CHECK(reporter.begin().reason == Reason::Pair);
  });

  check::run("a reader fault and its recovery are each reported at once, with the same seq and the slot kept", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.slotChanged(A, now);
    reporter.begin();
    reporter.finish(200, reply(STARTED), now);
    reporter.readerChanged(true, now + 1000);
    CHECK(reporter.ready(now + 1000));
    ReportDraft draft = reporter.begin();
    CHECK(draft.readerFault && draft.seq == 1 && sameUid(draft.tag, A));
    CHECK(draft.reason == Reason::Heartbeat);
    reporter.finish(200, reply(UNCHANGED), now + 1100);
    CHECK(!reporter.ready(now + 1100));
    reporter.readerChanged(false, now + 5000);
    CHECK(reporter.ready(now + 5000));
    draft = reporter.begin();
    CHECK(!draft.readerFault && draft.seq == 1 && sameUid(draft.tag, A));
  });

  check::run("a reader's health never cuts a wait short: a flapping reader can't hammer an absent or refusing hub", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.slotChanged(A, now);
    for (int i = 0; i < 7; ++i) {
      reporter.begin();
      reporter.finish(-1, Answer(), now);
      now += 30000;
    }
    reporter.begin();
    reporter.finish(-1, Answer(), now);
    reporter.readerChanged(true, now + 1000);
    reporter.readerChanged(false, now + 2000);
    CHECK(!reporter.ready(now + 29999));
    CHECK(reporter.ready(now + 30000));
    // Changed while a request is out that then fails: the backoff still stands.
    reporter.begin();
    reporter.readerChanged(true, now + 30100);
    reporter.finish(-1, Answer(), now + 30200);
    CHECK(!reporter.ready(now + 60199));
    CHECK(reporter.ready(now + 60200));
  });

  check::run("a slot change during a request that fails or is refused is sent at once, with the new seq", [] {
    const int statuses[] = {-1, 503, 401};
    for (int status : statuses) {
      Millis now = 0;
      Reporter reporter = running(now);
      reporter.slotChanged(A, now);
      reporter.begin();
      reporter.slotChanged(NO_UID, now + 50);
      reporter.finish(status, Answer(), now + 100);
      CHECK(reporter.ready(now + 100));
      const ReportDraft draft = reporter.begin();
      CHECK(draft.seq == 2 && draft.tag.size == 0);
    }
  });

  check::run("what was wanted during an answered report goes out under its own reason, so no cue plays twice", [] {
    // The plugin answers a repeat of the same seq and reason from its reply cache, cue included.
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.slotChanged(A, now);
    CHECK(reporter.begin().reason == Reason::Change);
    reporter.readerChanged(true, now + 10);
    CHECK(reporter.finish(200, reply(STARTED), now + 20) == Cue::Ok);
    CHECK(reporter.ready(now + 20));
    ReportDraft draft = reporter.begin();
    CHECK(draft.seq == 1 && draft.reason == Reason::Heartbeat && draft.readerFault);
    reporter.finish(200, reply(UNCHANGED), now + 30);

    reporter.slotChanged(NO_UID, now + 1000);
    reporter.begin();
    reporter.linkUp(now + 1010);
    reporter.finish(200, reply(UNCHANGED), now + 1020);
    draft = reporter.begin();
    CHECK(draft.seq == 2 && draft.reason == Reason::Reconnect);
    reporter.finish(200, reply(UNCHANGED), now + 1030);

    // The boot report itself: once it's answered the hub has heard this boot, so the follow-up is a reconnect.
    Reporter fresh(1);
    fresh.settle(A, false, 0);
    CHECK(fresh.begin().reason == Reason::Boot);
    fresh.linkUp(10);
    fresh.finish(200, reply(UNCHANGED), 20);
    CHECK(fresh.ready(20));
    CHECK(fresh.begin().reason == Reason::Reconnect);

    // A failed report is different: its reason still stands, with whatever was wanted meanwhile.
    Reporter failing = running(now);
    failing.slotChanged(A, now);
    failing.begin();
    failing.readerChanged(true, now + 10);
    failing.finish(-1, Answer(), now + 20);
    CHECK(failing.ready(now + 520));
    CHECK(failing.begin().reason == Reason::Change);
  });

  check::run("the report carries the strongest reason pending: pair, boot, change, reconnect, heartbeat", [] {
    Reporter booting(1);
    booting.settle(NO_UID, false, 0);
    booting.slotChanged(A, 100);
    CHECK(booting.begin().reason == Reason::Boot);
    booting.finish(-1, Answer(), 200);
    booting.hubChanged(300);
    CHECK(booting.begin().reason == Reason::Pair);

    Millis now = 0;
    Reporter reporter = running(now);
    now += 30000;
    CHECK(reporter.ready(now));
    reporter.linkUp(now);
    CHECK(reporter.begin().reason == Reason::Reconnect);
    reporter.finish(200, reply(UNCHANGED), now);
    reporter.linkUp(now + 100);
    reporter.slotChanged(A, now + 200);
    CHECK(reporter.begin().reason == Reason::Change);
  });

  check::run("retry_ms is honoured up to 60 s, and heartbeat_s up to 1 h", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.slotChanged(A, now);
    reporter.begin();
    reporter.finish(503, reply(R"({"ok":false,"v":2,"code":"retry","error":"Busy","retry_ms":600000})"), now);
    CHECK(!reporter.ready(now + 59999));
    CHECK(reporter.ready(now + 60000));
    reporter.begin();
    reporter.finish(200, reply(R"({"ok":true,"heartbeat_s":100000})"), now + 60000);
    CHECK(reporter.heartbeatMs() == 3600000);
  });

  check::run("heartbeats never stop: 60 days of nothing but heartbeats, across the millis() wrap", [] {
    const Millis starts[] = {0, 0xFFFFFF00u};
    for (Millis start : starts) {
      Millis now = start;
      Reporter reporter = running(now);
      const uint32_t steps = 60u * 24 * 3600 / 10;
      uint32_t sent = 0;
      uint32_t stepsSinceSent = 0;
      uint32_t longestGap = 0;
      for (uint32_t i = 0; i < steps; ++i) {
        now += 10000;
        ++stepsSinceSent;
        if (!reporter.ready(now)) continue;
        reporter.begin();
        reporter.finish(200, reply(UNCHANGED), now);
        ++sent;
        if (stepsSinceSent > longestGap) longestGap = stepsSinceSent;
        stepsSinceSent = 0;
      }
      // One every 30 s, with never more than a heartbeat between two.
      CHECK(sent == steps / 3);
      CHECK(longestGap == 3);
      CHECK(stepsSinceSent < 3);
    }
  });

  check::run("the cartridge stands as the hub's cue said, for as long as it stays in", [] {
    const struct {
      const char* body;
      Standing standing;
    } cases[] = {
        {STARTED, Standing::Tracking},
        {R"({"ok":true,"v":2,"seq":1,"result":"resumed","cue":"ok","heartbeat_s":30})", Standing::Tracking},
        // A point in time: the same chirp, but nothing runs after it.
        {R"({"ok":true,"v":2,"seq":1,"result":"marked","cue":"ok","heartbeat_s":30})", Standing::Marked},
        {R"({"ok":true,"v":2,"seq":1,"result":"unknown","cue":"unknown","heartbeat_s":30})", Standing::Unknown},
        {R"({"ok":true,"v":2,"seq":1,"result":"archived","cue":"error","heartbeat_s":30})", Standing::Error},
    };
    for (const auto& c : cases) {
      Millis now = 0;
      Reporter reporter = running(now);
      CHECK(reporter.standing() == Standing::None);
      reporter.slotChanged(A, now);
      // Not yet: the light is "reading" until the hub has answered.
      CHECK(reporter.standing() == Standing::None);
      reporter.begin();
      reporter.finish(200, reply(c.body), now + 100);
      CHECK(reporter.standing() == c.standing);
      // Heartbeats say `unchanged` with no cue, and a reader fault or a hub that is away says nothing about it.
      for (int i = 0; i < 3; ++i) {
        now += 31000;
        CHECK(reporter.ready(now));
        reporter.begin();
        reporter.finish(i == 1 ? -1 : 200, i == 1 ? Answer() : reply(UNCHANGED), now);
        CHECK(reporter.standing() == c.standing);
      }
      reporter.slotChanged(NO_UID, now + 1000);
      CHECK(reporter.standing() == Standing::None);
      reporter.begin();
      reporter.finish(200, reply(R"({"ok":true,"v":2,"seq":2,"result":"ended","cue":"bye","heartbeat_s":30})"), now + 1100);
      CHECK(reporter.standing() == Standing::None);
    }
  });

  check::run("a cartridge found at power-up stands as the boot report's answer says", [] {
    Reporter reporter(7);
    reporter.settle(A, false, 0);
    reporter.begin();
    reporter.finish(200, reply(R"({"ok":true,"v":2,"seq":0,"result":"resumed","cue":"ok","heartbeat_s":30})"), 100);
    CHECK(reporter.standing() == Standing::Tracking);
    // With nothing in the slot there is nothing to stand, whatever the answer's cue.
    Reporter empty(7);
    empty.settle(NO_UID, false, 0);
    empty.begin();
    empty.finish(200, reply(STARTED), 100);
    CHECK(empty.standing() == Standing::None);
  });

  check::run("an answer about the cartridge before says nothing about the one in the slot now", [] {
    Millis now = 0;
    Reporter reporter = running(now);
    reporter.slotChanged(A, now);
    reporter.begin();
    // A swap while the report about A is out: the answer's cue still plays, but B has not been spoken about.
    reporter.slotChanged(NO_UID, now + 10);
    reporter.slotChanged(Uid{{0x04, 0x0B, 0x00, 0x1C}, 4}, now + 20);
    CHECK(reporter.finish(200, reply(STARTED), now + 30) == Cue::Ok);
    CHECK(reporter.standing() == Standing::None);
    CHECK(reporter.reading());
    reporter.begin();
    reporter.finish(200, reply(R"({"ok":true,"v":2,"seq":3,"result":"unknown","cue":"unknown","heartbeat_s":30})"), now + 40);
    CHECK(reporter.standing() == Standing::Unknown);
    // The hub changing its mind about a cartridge that stays in (a label, a retry that now starts) is taken too.
    reporter.begin();
    reporter.finish(200, reply(R"({"ok":true,"v":2,"seq":3,"result":"started","cue":"ok","heartbeat_s":30})"), now + 50);
    CHECK(reporter.standing() == Standing::Tracking);
  });

  check::run("an error the player plays for want of an answer is not the hub's word about the cartridge", [] {
    // The light then says why instead: the hub can't be reached, or refuses (core/indicator.h).
    Millis now = 0;
    Reporter silent = running(now);
    silent.slotChanged(A, now);
    CHECK(silent.tick(now + 3000) == Cue::Error);
    CHECK(silent.standing() == Standing::None);
    Reporter refused = running(now);
    refused.slotChanged(A, now);
    refused.begin();
    CHECK(refused.finish(401, Answer(), now) == Cue::Error);
    CHECK(refused.standing() == Standing::None);
    // New hub settings don't forget what the hub said: its `unchanged` to the pair report means just that.
    Reporter paired = running(now);
    paired.slotChanged(A, now);
    paired.begin();
    paired.finish(200, reply(STARTED), now);
    paired.hubChanged(now + 100);
    CHECK(paired.standing() == Standing::Tracking);
  });

  return check::result();
}
