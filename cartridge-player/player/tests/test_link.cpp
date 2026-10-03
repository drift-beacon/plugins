// When setup mode opens and closes, and when the station tries again (DESIGN.md "Player", Setup mode).
#include "../src/core/link.h"

#include "check.h"

using namespace cp;

namespace {

constexpr Millis MINUTE = 60 * 1000;

Link configured(Millis now = 0) {
  Link link;
  link.begin(true, true, now);
  return link;
}

}  // namespace

int main() {
  check::run("a player that isn't set up is in setup mode and stays there", [] {
    Link link;
    link.begin(false, false, 0);
    CHECK(link.inSetup());
    CHECK(link.reason() == SetupReason::Unconfigured);
    link.update(24 * 60 * MINUTE);
    CHECK(link.inSetup());
    CHECK(link.exitSetup(24 * 60 * MINUTE) == Link::Exit::NotSetUp);
    link.update(25 * 60 * MINUTE);
    CHECK(link.inSetup());
  });

  check::run("a set-up player starts in run mode: no access point, nothing listening", [] {
    Link link = configured();
    CHECK(!link.inSetup());
    CHECK(link.shouldJoin(0));
  });

  check::run("BOOT or CONFIG opens setup; it closes after 10 minutes without a request", [] {
    Link link = configured();
    link.stationUp(0);
    link.requestSetup(SetupReason::Button, 1000);
    CHECK(link.inSetup() && link.reason() == SetupReason::Button);
    link.touched(5 * MINUTE);
    link.update(5 * MINUTE + 10 * MINUTE - 1);
    CHECK(link.inSetup());
    link.update(15 * MINUTE);
    CHECK(!link.inSetup());
  });

  check::run("POST /api/exit leaves setup once its answer has had time to reach the phone", [] {
    Link link = configured();
    link.requestSetup(SetupReason::Serial, 0);
    CHECK(link.exitSetup(1000) == Link::Exit::Leaving);
    link.update(1000);
    // The access point is what carries the answer: it stays for the moment that takes.
    CHECK(link.inSetup());
    link.update(1000 + Link::EXIT_DELAY_MS - 1);
    CHECK(link.inSetup());
    link.update(1000 + Link::EXIT_DELAY_MS);
    CHECK(!link.inSetup());
  });

  check::run("BOOT or a Connect right after Leave setup keeps setup open", [] {
    Link link = configured();
    link.requestSetup(SetupReason::Serial, 0);
    link.exitSetup(1000);
    link.requestSetup(SetupReason::Button, 1200);
    link.update(5000);
    CHECK(link.inSetup());

    link.exitSetup(6000);
    link.attemptStarted();
    link.attemptEnded(false, 7000);
    link.update(8000);
    CHECK(link.inSetup());
  });

  check::run("saved Wi-Fi not joined 5 minutes after power-up opens setup; joining closes it", [] {
    Link link = configured();
    link.update(5 * MINUTE - 1);
    CHECK(!link.inSetup());
    link.update(5 * MINUTE);
    CHECK(link.inSetup() && link.reason() == SetupReason::Offline);
    // The station keeps trying meanwhile.
    CHECK(link.shouldJoin(5 * MINUTE));
    link.joinStarted(5 * MINUTE);
    link.stationUp(6 * MINUTE);
    link.update(6 * MINUTE);
    CHECK(!link.inSetup());
  });

  check::run("Wi-Fi lost after it once worked doesn't open setup: the router will be back", [] {
    Link link = configured();
    link.stationUp(1000);
    link.stationDown(2000);
    link.update(60 * MINUTE);
    CHECK(!link.inSetup());
  });

  check::run("closing offline setup without joining opens it again 5 minutes later, not at once", [] {
    Link link = configured();
    link.update(5 * MINUTE);
    CHECK(link.inSetup());
    link.update(15 * MINUTE);
    CHECK(!link.inSetup());
    link.update(20 * MINUTE - 1);
    CHECK(!link.inSetup());
    link.update(20 * MINUTE);
    CHECK(link.inSetup());
  });

  check::run("a Connect holds setup open and the station still; success closes setup after 60 s", [] {
    Link link = configured();
    link.requestSetup(SetupReason::Button, 0);
    link.attemptStarted();
    CHECK(!link.shouldJoin(0));
    link.update(30 * MINUTE);
    CHECK(link.inSetup());
    CHECK(link.exitSetup(30 * MINUTE) == Link::Exit::Connecting);
    link.attemptEnded(true, 30 * MINUTE);
    link.update(31 * MINUTE - 1);
    CHECK(link.inSetup());
    link.update(31 * MINUTE);
    CHECK(!link.inSetup());
  });

  check::run("a failed Connect leaves setup open for another try", [] {
    Link link = configured();
    link.requestSetup(SetupReason::Button, 0);
    link.attemptStarted();
    link.attemptEnded(false, MINUTE);
    link.update(2 * MINUTE);
    CHECK(link.inSetup());
  });

  check::run("BOOT during the minute after a successful Connect keeps setup open, until idle", [] {
    Link link = configured();
    link.stationUp(0);
    link.requestSetup(SetupReason::Button, 0);
    link.attemptStarted();
    link.attemptEnded(true, 3000);
    link.touched(20000);
    link.requestSetup(SetupReason::Button, 30000);
    link.update(3000 + Link::DONE_GRACE_MS);
    CHECK(link.inSetup());
    link.update(30000 + Link::SETUP_IDLE_MS - 1);
    CHECK(link.inSetup());
    link.update(30000 + Link::SETUP_IDLE_MS);
    CHECK(!link.inSetup());
  });

  check::run("setup opened for want of Wi-Fi stays once someone uses it: a failed Connect still shows its error", [] {
    // A Connect that joined Wi-Fi but couldn't reach the hub: the station is up, and the phone needs the page.
    Link link = configured();
    link.update(5 * MINUTE);
    CHECK(link.reason() == SetupReason::Offline);
    link.attemptStarted();
    link.stationUp(5 * MINUTE + 4000);
    link.attemptEnded(false, 5 * MINUTE + 9000);
    link.update(5 * MINUTE + 9000);
    CHECK(link.inSetup());
    link.update(5 * MINUTE + 9000 + Link::SETUP_IDLE_MS);
    CHECK(!link.inSetup());

    // BOOT says the same: someone is here.
    Link held = configured();
    held.update(5 * MINUTE);
    held.requestSetup(SetupReason::Button, 5 * MINUTE + 1000);
    held.joinStarted(5 * MINUTE + 2000);
    held.stationUp(5 * MINUTE + 5000);
    held.update(5 * MINUTE + 5000);
    CHECK(held.inSetup());

    // Opened again later, untouched, it closes itself when Wi-Fi comes back as before.
    Link again = configured();
    again.update(5 * MINUTE);
    again.attemptStarted();
    again.attemptEnded(false, 6 * MINUTE);
    again.update(6 * MINUTE + Link::SETUP_IDLE_MS);
    CHECK(!again.inSetup());
    again.update(30 * MINUTE);
    CHECK(again.inSetup() && again.reason() == SetupReason::Offline);
    again.stationUp(31 * MINUTE);
    again.update(31 * MINUTE);
    CHECK(!again.inSetup());
  });

  check::run("setting up an unconfigured player closes setup 60 s after success", [] {
    Link link;
    link.begin(false, false, 0);
    link.attemptStarted();
    link.settingsChanged(true, true, MINUTE);
    link.attemptEnded(true, MINUTE);
    link.update(2 * MINUTE);
    CHECK(!link.inSetup());
  });

  check::run("rejoining backs off from 2 s to 60 s, and a lost connection is retried after 1 s", [] {
    Link link = configured();
    Millis now = 0;
    const Millis waits[] = {2000, 4000, 8000, 16000, 32000, 60000, 60000};
    for (Millis wait : waits) {
      CHECK(link.shouldJoin(now));
      link.joinStarted(now);
      link.stationDown(now + 100);
      now += 100;
      CHECK(!link.shouldJoin(now + wait - 1));
      now += wait;
    }
    link.joinStarted(now);
    link.stationUp(now);
    link.stationDown(now + 5000);
    CHECK(!link.shouldJoin(now + 5999));
    CHECK(link.shouldJoin(now + 6000));
  });

  check::run("a join that never answers is given up after 20 s and tried again", [] {
    Link link = configured();
    link.joinStarted(0);
    CHECK(!link.shouldJoin(19999));
    link.update(20000);
    CHECK(!link.shouldJoin(20000));
    CHECK(link.shouldJoin(22000));
  });

  check::run("a join the radio wouldn't take is asked again a second later, without using up the backoff", [] {
    Link link = configured();
    CHECK(link.shouldJoin(0));
    link.joinRefused(0);
    CHECK(!link.shouldJoin(Link::BUSY_REJOIN_MS - 1));
    CHECK(link.shouldJoin(Link::BUSY_REJOIN_MS));
    link.joinStarted(Link::BUSY_REJOIN_MS);
    link.stationDown(Link::BUSY_REJOIN_MS + 100);
    CHECK(link.shouldJoin(Link::BUSY_REJOIN_MS + 100 + Link::FIRST_REJOIN_MS));
  });

  check::run("the station waits while the setup page scans", [] {
    Link link = configured();
    link.pauseStation(true);
    CHECK(!link.shouldJoin(0));
    link.pauseStation(false);
    CHECK(link.shouldJoin(0));
  });

  check::run("the setup page's clients are told by their own address: on the access point's subnet or not", [] {
    // 10.123.45.1/24, as the Arduino core holds addresses: the first byte lowest.
    const auto ip = [](uint32_t a, uint32_t b, uint32_t c, uint32_t d) { return a | b << 8 | c << 16 | d << 24; };
    const uint32_t accessPoint = ip(10, 123, 45, 1);
    const uint32_t mask = ip(255, 255, 255, 0);
    CHECK(sameSubnet(ip(10, 123, 45, 2), accessPoint, mask));
    CHECK(sameSubnet(ip(10, 123, 45, 254), accessPoint, mask));
    // A machine on the home network that routes the access point's address through the player's station.
    CHECK(!sameSubnet(ip(192, 168, 1, 50), accessPoint, mask));
    CHECK(!sameSubnet(ip(10, 123, 46, 2), accessPoint, mask));
    CHECK(!sameSubnet(ip(10, 0, 45, 2), accessPoint, mask));
    // An address that isn't IPv4 reads as 0.
    CHECK(!sameSubnet(0, accessPoint, mask));
  });

  check::run("a request with the key only stands on a connection whose own end is the station's address", [] {
    const auto ip = [](uint32_t a, uint32_t b, uint32_t c, uint32_t d) { return a | b << 8 | c << 16 | d << 24; };
    const uint32_t accessPoint = ip(10, 123, 45, 1);
    const uint32_t station = ip(192, 168, 1, 57);
    CHECK(overStation(station, station, accessPoint));
    // The station dropped between the loop's check and the connect: the connection left by the access point.
    CHECK(!overStation(accessPoint, 0, accessPoint));
    CHECK(!overStation(accessPoint, station, accessPoint));
    // No address on either end (not IPv4, or not connected) is never the station's.
    CHECK(!overStation(0, 0, accessPoint));
    CHECK(!overStation(station, 0, accessPoint));
    // A home network that hands out the access point's range still works, short of the access point's own address.
    CHECK(overStation(ip(10, 123, 45, 7), ip(10, 123, 45, 7), accessPoint));
    CHECK(!overStation(accessPoint, accessPoint, accessPoint));
  });

  check::run("an address only counts for a network the player asked for and hasn't left itself since", [] {
    Link link = configured();
    CHECK(!link.expectsUp());
    link.joinStarted(0);
    CHECK(link.expectsUp());
    link.stationUp(1000);
    CHECK(link.expectsUp());
    // The player left (a failed Connect's network): what that network still has to say is no longer believed,
    link.stationLeft(2000);
    CHECK(!link.stationIsUp());
    CHECK(!link.expectsUp());
    // and the station goes back to the saved network, as after any drop.
    CHECK(!link.shouldJoin(2999));
    CHECK(link.shouldJoin(3000));
    link.joinStarted(3000);
    CHECK(link.expectsUp());
  });

  check::run("a join that failed or timed out may still come up: the driver retries, and a slow lease still arrives", [] {
    Link link = configured();
    link.joinStarted(0);
    link.stationDown(1000);
    CHECK(link.expectsUp());
    link.joinStarted(3000);
    link.update(3000 + Link::JOIN_TIMEOUT_MS);
    CHECK(link.expectsUp());
    // A station joined by a Connect (the attempt's join, not the link's) that loses its lease and gets one again.
    Link joinedByConnect = configured();
    joinedByConnect.attemptStarted();
    joinedByConnect.stationUp(0);
    joinedByConnect.stationDown(1000);
    CHECK(joinedByConnect.expectsUp());
  });

  return check::result();
}
