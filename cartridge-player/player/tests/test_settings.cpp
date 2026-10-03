// What is saved and what may be saved (DESIGN.md "Player", Settings).
#include "../src/core/settings.h"

#include "check.h"

using namespace cp;

namespace {

StoredValues whole() {
  StoredValues stored;
  stored.ssid = "Home";
  stored.password = "hunter22";
  stored.host = "192.168.1.12";
  stored.port = 9001;
  stored.base = "/api/plugins/github.12345.cartridge-player/api";
  stored.key = "db_0123456789abcdef";
  return stored;
}

}  // namespace

int main() {
  check::run("Wi-Fi rules: a name of 1-32 bytes; no password, an 8-63 character one or 64 hex digits", [] {
    CHECK(ssidError("Home") == nullptr);
    CHECK(ssidError("") != nullptr);
    CHECK(ssidError("123456789012345678901234567890123") != nullptr);
    CHECK(passwordError("") == nullptr);
    CHECK(passwordError("12345678") == nullptr);
    CHECK(passwordError("1234567") != nullptr);
    CHECK(passwordError("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef") == nullptr);
    CHECK(passwordError("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg") != nullptr);
    CHECK(passwordError("line\nbreak") != nullptr);
  });

  check::run("whole settings load as they were saved, and the player is configured", [] {
    const Settings settings = settingsFrom(whole());
    CHECK(settings.configured);
    CHECK_TEXT(settings.ssid, "Home");
    CHECK_TEXT(settings.password, "hunter22");
    CHECK_TEXT(settings.hub.host, "192.168.1.12");
    CHECK(settings.hub.port == 9001);
    CHECK_TEXT(settings.hub.base, "/api/plugins/github.12345.cartridge-player/api");
    CHECK_TEXT(settings.hub.key, "db_0123456789abcdef");
    CHECK(settings.buzzer);
  });

  check::run("a hub loads only whole: without a valid host, port, base or key there is none, and Wi-Fi is kept", [] {
    void (*const broken[])(StoredValues&) = {
        [](StoredValues& stored) { stored.host = "beacon.local:9001"; },
        [](StoredValues& stored) { stored.port = 0; },
        [](StoredValues& stored) { stored.base = ""; },
        [](StoredValues& stored) { stored.base = "/api/plugins/../api"; },
        [](StoredValues& stored) { stored.key = ""; },
        [](StoredValues& stored) { stored.key = "short"; },
    };
    for (const auto breakIt : broken) {
      StoredValues stored = whole();
      breakIt(stored);
      const Settings settings = settingsFrom(stored);
      CHECK(!settings.configured);
      CHECK(settings.hasWifi());
      CHECK(!settings.hasHub());
      CHECK_TEXT(settings.hub.key, "");
    }
  });

  check::run("not configured without Wi-Fi: a missing name or a password setup would refuse", [] {
    StoredValues stored = whole();
    stored.ssid = "";
    CHECK(!settingsFrom(stored).configured);
    CHECK(settingsFrom(stored).hasHub());
    stored = whole();
    stored.password = "abcde";
    CHECK(!settingsFrom(stored).hasWifi());
    CHECK(!settingsFrom(StoredValues()).configured);
  });

  return check::result();
}
