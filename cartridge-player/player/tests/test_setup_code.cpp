// Setup codes as the interface makes them (shared/setup-code.ts). These are hand-made vectors; the cross-language
// check against encodeSetupCode itself is in tests/firmware.test.mjs.
#include "../src/core/setup_code.h"

#include "check.h"

using namespace cp;

namespace {

/** base64url without padding, the way the interface writes it. */
void encode(const char* json, char* out) {
  static const char DIGITS[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::strcpy(out, "CP1-");
  char* at = out + 4;
  const size_t length = std::strlen(json);
  for (size_t i = 0; i < length; i += 3) {
    const uint32_t a = static_cast<unsigned char>(json[i]);
    const uint32_t b = i + 1 < length ? static_cast<unsigned char>(json[i + 1]) : 0;
    const uint32_t c = i + 2 < length ? static_cast<unsigned char>(json[i + 2]) : 0;
    const uint32_t bits = a << 16 | b << 8 | c;
    *at++ = DIGITS[bits >> 18 & 63];
    *at++ = DIGITS[bits >> 12 & 63];
    if (i + 1 < length) *at++ = DIGITS[bits >> 6 & 63];
    if (i + 2 < length) *at++ = DIGITS[bits & 63];
  }
  *at = '\0';
}

bool decode(const char* json, HubTarget& hub, bool& hasKey) {
  char code[SETUP_CODE_MAX];
  encode(json, code);
  return decodeSetupCode(code, hub, hasKey);
}

}  // namespace

int main() {
  check::run("a code with a key gives host, port, base and key", [] {
    HubTarget hub;
    bool hasKey = false;
    CHECK(decode(R"({"h":"192.168.1.12","p":9001,"b":"/api/plugins/x/api","k":"db_abcdefgh"})", hub, hasKey));
    CHECK(hasKey);
    CHECK_TEXT(hub.host, "192.168.1.12");
    CHECK(hub.port == 9001);
    CHECK_TEXT(hub.base, "/api/plugins/x/api");
    CHECK_TEXT(hub.key, "db_abcdefgh");
  });

  check::run("a code without a key is valid; the setup page then asks for the key", [] {
    HubTarget hub;
    bool hasKey = true;
    CHECK(decode(R"({"h":"beacon.local","p":80,"b":"/api/plugins/cartridge-player-dev/api"})", hub, hasKey));
    CHECK(!hasKey);
    CHECK_TEXT(hub.key, "");
  });

  check::run("pasted with spaces or line breaks around it, a code still works", [] {
    char code[SETUP_CODE_MAX];
    encode(R"({"h":"h","p":1,"b":"/api/plugins/x/api"})", code);
    char padded[SETUP_CODE_MAX + 16];
    std::snprintf(padded, sizeof padded, " \n\t%s\r\n \xC2\xA0", code);
    HubTarget hub;
    bool hasKey = false;
    CHECK(decodeSetupCode(padded, hub, hasKey));
  });

  check::run("a repeated field takes its last value, as JSON.parse does", [] {
    HubTarget hub;
    bool hasKey = false;
    CHECK(decode(R"({"h":"bad host","h":"good","p":"9001","p":9001.0,"b":"/api/plugins/x/api"})", hub, hasKey));
    CHECK_TEXT(hub.host, "good");
    CHECK(!decode(R"({"h":"good","h":"bad host","p":9001,"b":"/api/plugins/x/api"})", hub, hasKey));
  });

  check::run("codes that break a rule are refused", [] {
    const char* const bad[] = {
        R"({"h":"http://x","p":9001,"b":"/api/plugins/x/api"})",
        R"({"h":"x","p":0,"b":"/api/plugins/x/api"})",
        R"({"h":"x","p":65536,"b":"/api/plugins/x/api"})",
        R"({"h":"x","p":9001.5,"b":"/api/plugins/x/api"})",
        R"({"h":"x","p":"9001","b":"/api/plugins/x/api"})",
        R"({"h":"x","p":9001,"b":"/api/plugins/x/api/player"})",
        R"({"h":"x","p":9001,"b":"/api/plugins/../api"})",
        R"({"h":"x","p":9001,"b":"/api/plugins/x/api","k":"short"})",
        R"({"h":"x","p":9001,"b":"/api/plugins/x/api","k":null})",
        R"({"h":"x","p":9001,"b":"/api/plugins/x/api","k":"has space"})",
        R"({"h":"x\u0000y","p":9001,"b":"/api/plugins/x/api"})",
        R"({"p":9001,"b":"/api/plugins/x/api"})",
        R"([{"h":"x","p":9001,"b":"/api/plugins/x/api"}])",
        R"({"h":"x","p":9001,"b":"/api/plugins/x/api"} x)",
    };
    for (const char* json : bad) {
      HubTarget hub;
      bool hasKey = false;
      CHECK(!decode(json, hub, hasKey));
    }
  });

  check::run("text that isn't a code is refused: wrong prefix, bad base64, nothing after the prefix", [] {
    const char* const bad[] = {"", "CP1-", "cp1-eyJ9", "CP2-eyJ9", "CP1-e", "CP1-ey J9", "CP1-eyJ9=",
                               "db_0123456789"};
    for (const char* code : bad) {
      HubTarget hub;
      bool hasKey = false;
      CHECK(!decodeSetupCode(code, hub, hasKey));
    }
  });

  return check::result();
}
