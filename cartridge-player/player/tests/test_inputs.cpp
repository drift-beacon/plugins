// The BOOT button and the serial console (DESIGN.md "Player", Setup mode and Serial).
#include "../src/core/inputs.h"

#include "check.h"

using namespace cp;

namespace {

int feed(LineReader& reader, const char* text, const char** last = nullptr) {
  int lines = 0;
  for (const char* c = text; *c; ++c) {
    if (reader.feed(*c)) {
      ++lines;
      if (last) *last = reader.line();
    }
  }
  return lines;
}

}  // namespace

int main() {
  check::run("holding BOOT for 3 s fires once; it fires again only after letting go", [] {
    LongPress button;
    int fired = 0;
    for (Millis t = 0; t <= 2990; t += 10) fired += button.update(true, t);
    CHECK(fired == 0);
    for (Millis t = 3000; t <= 10000; t += 10) fired += button.update(true, t);
    CHECK(fired == 1);
    button.update(false, 10010);
    for (Millis t = 10020; t <= 13020; t += 10) fired += button.update(true, t);
    CHECK(fired == 2);
  });

  check::run("a short press (or a bounce) never opens setup", [] {
    LongPress button;
    int fired = 0;
    for (Millis t = 0; t < 20000; t += 10) fired += button.update((t / 1000) % 2 == 0, t);
    CHECK(fired == 0);
  });

  check::run("console lines end with CR, LF or both, whichever the terminal sends", [] {
    LineReader reader;
    const char* last = nullptr;
    CHECK(feed(reader, "STATUS\r\nHELP\nCONFIG\r", &last) == 3);
    CHECK_TEXT(last, "CONFIG");
    CHECK(feed(reader, "\r\n\n") == 0);
  });

  check::run("an overlong line is dropped whole, and the next line still works", [] {
    LineReader reader;
    const char* last = nullptr;
    CHECK(feed(reader, "STATUSSTATUSSTATUSSTATUSSTATUSSTATUSSTATUSSTATUSSTATUS\n") == 0);
    CHECK(feed(reader, "status\n", &last) == 1);
    CHECK_TEXT(last, "status");
  });

  check::run("commands ignore case and surrounding spaces", [] {
    CHECK(parseCommand("status") == Command::Status);
    CHECK(parseCommand("  Config ") == Command::Config);
    CHECK(parseCommand("RESET") == Command::Reset);
    CHECK(parseCommand("factory") == Command::Factory);
    CHECK(parseCommand("help") == Command::Help);
    CHECK(parseCommand("buzzer off") == Command::BuzzerOff);
    CHECK(parseCommand("Buzzer On") == Command::BuzzerOn);
    CHECK(parseCommand("statusx") == Command::Unknown);
    CHECK(parseCommand("FACTORY NOW") == Command::Unknown);
  });

  check::run("FACTORY erases only when repeated within 5 s", [] {
    Confirmation confirm;
    CHECK(!confirm.ask(0));
    CHECK(confirm.ask(5000));
    CHECK(!confirm.ask(6000));
    CHECK(!confirm.ask(11001));
    CHECK(confirm.ask(12000));
    CHECK(!confirm.ask(13000));
    confirm.cancel();
    CHECK(!confirm.ask(14000));
  });

  return check::result();
}
