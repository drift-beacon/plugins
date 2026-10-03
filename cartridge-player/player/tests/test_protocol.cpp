// The report the player writes and the answers it reads (shared/protocol.ts on the plugin's side; the
// cross-language checks are in tests/firmware.test.mjs). Also the JSON reader and writer under them.
#include "../src/core/device.h"
#include "../src/core/protocol.h"

#include "check.h"

using namespace cp;

namespace {

ReportBody sample() {
  ReportBody body = {};
  body.deviceId = "cp-a1b2c3";
  body.firmware = "2.0.0";
  body.name = "Cartridge-A1B2";
  body.boot = 3141592653u;
  body.seq = 42;
  body.reason = Reason::Change;
  body.tag = Uid{{0x04, 0xA1, 0xB2, 0xC3}, 4};
  body.ageMs = 1200;
  body.hasRssi = true;
  body.rssi = -58;
  body.uptimeS = 86400;
  body.readerFault = false;
  return body;
}

bool read(const char* body, Answer& answer) { return readAnswer(body, std::strlen(body), answer); }

}  // namespace

int main() {
  check::run("a report has every field parseReport reads, with the tag as text and null for an empty slot", [] {
    char out[REPORT_MAX];
    ReportBody body = sample();
    CHECK(writeReport(body, out, sizeof out) > 0);
    CHECK_TEXT(out,
               R"({"v":2,"device":{"id":"cp-a1b2c3","fw":"2.0.0","name":"Cartridge-A1B2"},"boot":3141592653,)"
               R"("seq":42,"reason":"change","tag":"04:A1:B2:C3","age_ms":1200,"rssi":-58,"uptime_s":86400,)"
               R"("reader":"ok"})");
    body.tag = NO_UID;
    body.hasRssi = false;
    body.readerFault = true;
    body.reason = Reason::Heartbeat;
    writeReport(body, out, sizeof out);
    CHECK(std::strstr(out, R"("tag":null)") != nullptr);
    CHECK(std::strstr(out, R"("rssi":null)") != nullptr);
    CHECK(std::strstr(out, R"("reader":"fault")") != nullptr);
    CHECK(std::strstr(out, R"("reason":"heartbeat")") != nullptr);
  });

  check::run("the longest report fits the request buffer; a buffer too small gives no body at all", [] {
    char out[REPORT_MAX];
    ReportBody body = sample();
    body.tag = Uid{{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}, 10};
    body.boot = 4294967295u;
    body.seq = 4294967295u;
    body.ageMs = 4294967295u;
    body.uptimeS = 4294967295u;
    body.rssi = -128;
    body.reason = Reason::Reconnect;
    CHECK(writeReport(body, out, sizeof out) > 0);
    char small[64];
    CHECK(writeReport(body, small, sizeof small) == 0);
  });

  check::run("the writer escapes quotes, backslashes and control characters", [] {
    char out[64];
    JsonWriter json(out, sizeof out);
    json.open().key("ssid").string("a\"b\\c\nd\x01").close();
    CHECK(json.finish() > 0);
    CHECK_TEXT(out, R"({"ssid":"a\"b\\c\nd\u0001"})");
  });

  check::run("a reply is read whatever the order of its fields, and extra or nested fields are skipped", [] {
    Answer answer;
    CHECK(read(R"({"activity":"Deep work","future":{"x":[1,{"y":null}]},"cue":"ok","result":"started",)"
               R"("heartbeat_s":45,"seq":7,"v":2,"ok":true})",
               answer));
    CHECK(answer.ok && answer.hasSeq && answer.seq == 7);
    CHECK_TEXT(answer.result, "started");
    CHECK(answer.cue == Cue::Ok);
    CHECK(answer.heartbeatS == 45);
    CHECK_TEXT(answer.activity, "Deep work");
  });

  check::run("error replies and the platform's own errors are read too", [] {
    Answer answer;
    CHECK(read(R"({"ok":false,"v":2,"code":"retry","error":"Busy","retry_ms":1500})", answer));
    CHECK(!answer.ok);
    CHECK(requestedWait(answer) == 1500);
    CHECK(read(R"({"success":false,"error":"Plugin is disabled or unavailable"})", answer));
    CHECK(!answer.ok && requestedWait(answer) == 0);
    CHECK_TEXT(answer.error, "Plugin is disabled or unavailable");
  });

  check::run("a probe answer is accepted only from this plugin speaking protocol 2", [] {
    Answer answer;
    CHECK(read(R"({"ok":true,"player":"cartridge-player","protocol":2,"heartbeat_s":30})", answer));
    CHECK(isProbeAnswer(answer));
    read(R"({"ok":true,"player":"something-else","protocol":2})", answer);
    CHECK(!isProbeAnswer(answer));
    read(R"({"ok":true,"player":"cartridge-player","protocol":3})", answer);
    CHECK(!isProbeAnswer(answer));
  });

  check::run("bodies that aren't one JSON object are refused whole: HTML, cut, trailing text, arrays", [] {
    const char* const broken[] = {
        "<html>Bad gateway</html>", R"({"ok":true,"result":"sta)", R"({"ok":true} x)", R"([{"ok":true}])",
        R"({"ok":true,})",          R"({"a":"line)" "\n" R"("})",  R"({"a":01})",      R"({'ok':true})",
        "",
    };
    for (const char* body : broken) {
      Answer answer;
      CHECK(!read(body, answer));
      CHECK(!answer.ok);
    }
  });

  check::run("unicode escapes decode to UTF-8; an overlong activity is cut at a whole character", [] {
    Answer answer;
    read(R"({"activity":"Café 🎵 \"x\""})", answer);
    CHECK_TEXT(answer.activity, "Caf\xC3\xA9 \xF0\x9F\x8E\xB5 \"x\"");
    read(R"({"activity":"123456789012345678901234567890123456789012345éé"})", answer);
    CHECK(std::strlen(answer.activity) == 47);
    CHECK_TEXT(answer.activity, "123456789012345678901234567890123456789012345\xC3\xA9");
  });

  check::run("statuses map to the delivery rules: 2xx delivered, 400 dropped, 401/403 key, 404 path, rest retry", [] {
    CHECK(classify(200) == Delivery::Delivered);
    CHECK(classify(204) == Delivery::Delivered);
    CHECK(classify(400) == Delivery::Dropped);
    CHECK(classify(401) == Delivery::KeyRejected);
    CHECK(classify(403) == Delivery::KeyRejected);
    CHECK(classify(404) == Delivery::NotFound);
    const int retries[] = {-1, 500, 502, 503, 504, 405, 301};
    for (int status : retries) CHECK(classify(status) == Delivery::Retry);
  });

  check::run("the device id, setup network and host name all come from the same MAC bytes", [] {
    const uint8_t mac[6] = {0x24, 0x58, 0x7C, 0xA1, 0xB2, 0x03};
    const Identity identity = identityFrom(mac);
    CHECK_TEXT(identity.id, "cp-a1b203");
    CHECK_TEXT(identity.name, "Cartridge-A1B2");
    CHECK_TEXT(identity.hostname, "cartridge-a1b203");
  });

  check::run("the User-Agent names the firmware and its own version, three numbers with dots", [] {
    const char* prefix = "CartridgePlayer/";
    CHECK(std::strncmp(USER_AGENT, prefix, std::strlen(prefix)) == 0);
    CHECK_TEXT(USER_AGENT + std::strlen(prefix), FIRMWARE_VERSION);
    int dots = 0;
    bool digitBefore = false;
    bool wellFormed = true;
    for (const char* c = FIRMWARE_VERSION; *c; ++c) {
      if (*c >= '0' && *c <= '9') {
        digitBefore = true;
      } else if (*c == '.' && digitBefore) {
        ++dots;
        digitBefore = false;
      } else {
        wellFormed = false;
      }
    }
    CHECK(wellFormed && digitBefore && dots == 2);
  });

  return check::result();
}
