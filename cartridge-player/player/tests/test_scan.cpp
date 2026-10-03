// The setup page's network scan (core/scan.h, DESIGN.md "Setup page API", GET /api/scan): when one starts, how long
// the radio is asked, and what the page is told. The portal makes these same calls around the radio's own.
#include "../src/core/scan.h"

#include "check.h"

using namespace cp;

int main() {
  check::run("the first request starts a scan and is told to ask again; the list then answers for 15 s", [] {
    NetworkScan scan;
    NetworkScan::Told told = scan.request(1000);
    CHECK(told.scanning && !told.failed);
    CHECK(scan.startDue(1000));
    scan.started(true, 1000);
    CHECK(!scan.startDue(1100) && scan.running());
    // Asking again while it runs starts nothing new.
    told = scan.request(2000);
    CHECK(told.scanning && !scan.startDue(2000));
    scan.listed(3000);
    CHECK(!scan.wanted() && !scan.running());
    told = scan.request(3000 + NetworkScan::FRESH_MS - 1);
    CHECK(!told.scanning && !told.failed && !scan.wanted());
    told = scan.request(3000 + NetworkScan::FRESH_MS);
    CHECK(told.scanning && scan.startDue(3000 + NetworkScan::FRESH_MS));
  });

  check::run("a radio that won't scan (the station is joining) is asked again every second", [] {
    NetworkScan scan;
    scan.request(0);
    scan.started(false, 0);
    CHECK(scan.wanted() && !scan.running());
    CHECK(!scan.startDue(NetworkScan::RETRY_MS - 1));
    CHECK(scan.startDue(NetworkScan::RETRY_MS));
    // A scan that broke off part-way is asked for again the same way.
    scan.started(true, 1000);
    scan.started(false, 1500);
    CHECK(!scan.startDue(2499) && scan.startDue(2500));
  });

  check::run("a scan that can't be had in 12 s gives up, and the page hears it: once, with nothing started", [] {
    NetworkScan scan;
    scan.request(0);
    scan.started(false, 0);
    CHECK(!scan.timedOut(NetworkScan::TIMEOUT_MS - 1));
    CHECK(scan.request(NetworkScan::TIMEOUT_MS - 1).scanning);
    CHECK(scan.timedOut(NetworkScan::TIMEOUT_MS));
    CHECK(!scan.timedOut(NetworkScan::TIMEOUT_MS + 1));
    CHECK(!scan.wanted() && !scan.running());
    // The request that finds it failed is told so and starts nothing: the page offers "Scan again".
    NetworkScan::Told told = scan.request(13000);
    CHECK(told.failed && !told.scanning);
    CHECK(!scan.wanted() && !scan.startDue(13000));
    // The next one starts over, and isn't told about the old failure again.
    told = scan.request(14000);
    CHECK(!told.failed && told.scanning);
    CHECK(scan.startDue(14000));
  });

  check::run("giving up records no list: an old one isn't fresh again, and a running scan is dropped", [] {
    NetworkScan scan;
    scan.request(0);
    scan.started(true, 0);
    scan.listed(500);
    scan.request(20000);
    scan.started(true, 20000);
    CHECK(scan.timedOut(32000));
    CHECK(!scan.running());
    CHECK(scan.request(32500).failed);
    CHECK(scan.request(33000).scanning);
  });

  check::run("closing setup drops a wanted scan without a failure for the next page to be told", [] {
    NetworkScan scan;
    scan.request(0);
    scan.started(true, 0);
    scan.abandon();
    CHECK(!scan.wanted() && !scan.running());
    const NetworkScan::Told told = scan.request(60000);
    CHECK(!told.failed && told.scanning);
    // The same for one that had already given up before anyone asked again.
    scan.started(false, 60000);
    CHECK(scan.timedOut(72000));
    scan.abandon();
    CHECK(!scan.request(100000).failed);
  });

  check::run("the scan's timers hold across the 49-day wrap of millis()", [] {
    NetworkScan scan;
    const Millis start = 0xFFFFFF00u;
    scan.request(start);
    scan.started(false, start);
    CHECK(scan.startDue(start + NetworkScan::RETRY_MS));
    CHECK(!scan.timedOut(start + NetworkScan::TIMEOUT_MS - 1));
    CHECK(scan.timedOut(start + NetworkScan::TIMEOUT_MS));
  });

  return check::result();
}
