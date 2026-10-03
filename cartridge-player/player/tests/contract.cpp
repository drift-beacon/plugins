// The firmware's half of the cross-language checks in tests/firmware.test.mjs. It runs the production core and prints
// what the firmware would send or understand, one JSON object per line, for the plugin's own code to judge:
//
//   contract reports       report bodies from scripted sessions: reader polls through core/slot_feed.h, the same
//                          calls app.cpp makes, to the tracker, the reporter and the writer (a null body: the
//                          player has nothing to send at that point)
//   contract answers       for each {"status","body"} line on stdin: what the player reads from that answer
//   contract setup-codes   for each {"code"} line: what the setup page's decoder makes of it
//   contract fields        for each {"field","value"} line: the setup rule's verdict
//   contract lights        for each {"slot","body"} line: the light a player shows once the plugin has answered the
//                          report about its slot with that body (null: not answered yet), through the reporter and
//                          core/indicator.h, as its colour, how it moves and how often
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "../src/core/device.h"
#include "../src/core/indicator.h"
#include "../src/core/protocol.h"
#include "../src/core/reporter.h"
#include "../src/core/settings.h"
#include "../src/core/setup_code.h"
#include "../src/core/slot_feed.h"
#include "../src/core/tag_tracker.h"

using namespace cp;

namespace {

char out[8192];

const char* cueName(Cue cue) {
  switch (cue) {
    case Cue::None: return "none";
    case Cue::Ok: return "ok";
    case Cue::Bye: return "bye";
    case Cue::Unknown: return "unknown";
    case Cue::Error: return "error";
  }
  return "none";
}

const char* deliveryName(Delivery delivery) {
  switch (delivery) {
    case Delivery::Delivered: return "delivered";
    case Delivery::Dropped: return "dropped";
    case Delivery::KeyRejected: return "key-rejected";
    case Delivery::NotFound: return "not-found";
    case Delivery::Retry: return "retry";
  }
  return "retry";
}

void emit(JsonWriter& json) {
  if (json.finish() == 0) {
    std::fprintf(stderr, "contract: an output line didn't fit\n");
    std::exit(2);
  }
  std::puts(out);
}

/** Calls `handle` with each stdin line read as a JSON object's members. */
template <class Handle>
void eachLine(Handle&& handle) {
  std::string line;
  int c;
  while ((c = std::getchar()) != EOF) {
    if (c != '\n') {
      line += static_cast<char>(c);
      continue;
    }
    if (!line.empty()) handle(line);
    line.clear();
  }
  if (!line.empty()) handle(line);
}

/** A string member of an input line, decoded. */
std::string text(const JsonValue& value) {
  static char buffer[4096];
  json::decodeString(value, buffer, sizeof buffer);
  return buffer;
}

/** One power-up of a player: polls go in as the reader gives them, and each report due comes out as a line. */
class Session {
 public:
  void poll(int count, Read read, const Uid& uid) {
    for (int i = 0; i < count; ++i) {
      now_ += 50;
      feed_.poll(tracker_, reporter_, read, uid, now_);
    }
  }

  /** Sends the report that is due `later` ms on, answered 200 by the plugin. */
  void send(const char* name, Millis later, bool hasRssi, int32_t rssi, uint32_t uptime) {
    static const char* const answered = R"({"ok":true,"v":2,"seq":0,"result":"unchanged","cue":"none","heartbeat_s":30})";
    now_ += later;
    if (!reporter_.ready(now_)) {
      std::fprintf(stderr, "contract: no report due for %s\n", name);
      std::exit(2);
    }
    const ReportBody body = reportBody(reporter_.begin(), identity_, reporter_.boot(), hasRssi, rssi, uptime, now_);
    char report[REPORT_MAX];
    if (writeReport(body, report, sizeof report) == 0) std::exit(2);
    Answer reply;
    readAnswer(answered, std::strlen(answered), reply);
    reporter_.finish(200, reply, now_);
    JsonWriter json(out, sizeof out);
    json.open().key("name").string(name).key("body").string(report).close();
    emit(json);
  }

  /**
   * A point where the plugin must hear nothing: prints a null body when no report is due. One that is due after all
   * goes out under this name, for the test to show.
   */
  void quiet(const char* name) {
    if (reporter_.ready(now_)) {
      send(name, 0, true, -52, 0);
      return;
    }
    JsonWriter json(out, sizeof out);
    json.open().key("name").string(name).key("body").null().close();
    emit(json);
  }

  void linkUp() { reporter_.linkUp(now_); }
  void hubChanged() { reporter_.hubChanged(now_); }

 private:
  static Identity identity() {
    const uint8_t mac[6] = {0x24, 0x58, 0x7C, 0xA1, 0xB2, 0xC3};
    return identityFrom(mac);
  }

  const Identity identity_ = identity();
  TagTracker tracker_{0};
  SlotFeed feed_;
  Reporter reporter_{3141592653u};
  Millis now_ = 0;
};

void reports() {
  const Uid seven = {{0x04, 0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6}, 7};
  const Uid four = {{0x04, 0x0B, 0x00, 0x1C}, 4};
  const Uid ten = {{0x00, 0x01, 0x0F, 0x10, 0x7F, 0x80, 0xAB, 0xCD, 0xEF, 0xFF}, 10};

  Session session;
  session.poll(8, Read::Absent, NO_UID);
  session.send("boot-empty", 0, true, -52, 3);
  session.poll(2, Read::Present, seven);
  session.send("insert", 300, true, -55, 5);
  session.poll(2, Read::Present, four);
  session.send("swap", 0, true, -60, 6);
  // The reader has to fail for a second before it is a fault worth reporting.
  session.poll(25, Read::Fault, NO_UID);
  session.send("reader-fault", 0, true, -61, 7);
  // The reader works again, and the cartridge went while it didn't. Until the slot has been read (empty for 400 ms)
  // the fault stands, so nothing vouches for the cartridge that was there.
  session.poll(7, Read::Absent, NO_UID);
  session.quiet("reader-back-unread");
  session.poll(1, Read::Absent, NO_UID);
  session.send("eject", 0, false, 0, 8);
  session.poll(2, Read::Present, ten);
  session.send("ten-byte", 0, true, -128, 4294967295u);
  session.send("heartbeat", 30000, true, -50, 40);
  session.linkUp();
  session.send("reconnect", 0, true, -49, 41);
  session.hubChanged();
  session.send("pair", 0, true, -48, 42);

  // A reader that never answers from power-up: the hub still hears from the player, with the fault.
  Session deadReader;
  deadReader.poll(70, Read::Fault, NO_UID);
  deadReader.send("boot-dead-reader", 0, true, -52, 4);
  // It comes back with the cartridge that was left in. One good poll is not a read of the slot: the player must not
  // call it empty, or the plugin would end the session that cartridge has had running all along.
  deadReader.poll(1, Read::Present, seven);
  deadReader.quiet("dead-reader-back-unread");
  deadReader.poll(1, Read::Present, seven);
  deadReader.send("dead-reader-cartridge", 0, true, -52, 9);

  // The same with nothing in the slot: "empty, reader ok" goes out once the slot has been read empty, not before.
  Session deadReaderEmpty;
  deadReaderEmpty.poll(70, Read::Fault, NO_UID);
  deadReaderEmpty.send("boot-dead-reader-empty", 0, true, -52, 4);
  deadReaderEmpty.poll(7, Read::Absent, NO_UID);
  deadReaderEmpty.quiet("dead-reader-empty-unread");
  deadReaderEmpty.poll(1, Read::Absent, NO_UID);
  deadReaderEmpty.send("dead-reader-empty", 0, true, -52, 9);
}

void answers() {
  eachLine([](const std::string& line) {
    int status = 0;
    std::string body;
    json::readObject(line.data(), line.size(), [&](const char* key, const JsonValue& value) {
      if (key && std::strcmp(key, "status") == 0) {
        double raw = 0;
        json::toNumber(value, raw);
        status = static_cast<int>(raw);
      } else if (key && std::strcmp(key, "body") == 0) {
        body = text(value);
      }
    });
    Answer answer;
    const bool parsed = readAnswer(body.data(), body.size(), answer);
    JsonWriter json(out, sizeof out);
    json.open().key("parsed").boolean(parsed).key("ok").boolean(answer.ok).key("seq");
    if (answer.hasSeq) {
      json.number(answer.seq);
    } else {
      json.null();
    }
    json.key("result").string(answer.result).key("cue").string(cueName(answer.cue));
    json.key("heartbeat_s").number(answer.heartbeatS).key("activity").string(answer.activity);
    json.key("code").string(answer.code).key("retry_ms").number(answer.retryMs).key("error").string(answer.error);
    json.key("player").string(answer.player).key("protocol").number(answer.protocol);
    json.key("probe").boolean(isProbeAnswer(answer)).key("delivery").string(deliveryName(classify(status)));
    json.key("wait").number(requestedWait(answer)).close();
    emit(json);
  });
}

void setupCodes() {
  eachLine([](const std::string& line) {
    std::string code;
    json::readObject(line.data(), line.size(), [&](const char* key, const JsonValue& value) {
      if (key && std::strcmp(key, "code") == 0) code = text(value);
    });
    HubTarget hub;
    bool hasKey = false;
    const bool valid = decodeSetupCode(code.c_str(), hub, hasKey);
    JsonWriter json(out, sizeof out);
    json.open().key("valid").boolean(valid);
    if (valid) {
      json.key("host").string(hub.host).key("port").number(hub.port).key("base").string(hub.base).key("key");
      if (hasKey) {
        json.string(hub.key);
      } else {
        json.null();
      }
    }
    json.close();
    emit(json);
  });
}

/** The same verdicts as `setupFieldError` for a JSON value of any type. */
void fields() {
  eachLine([](const std::string& line) {
    std::string field;
    JsonValue value = {JsonValue::Type::Null, nullptr, 0};
    json::readObject(line.data(), line.size(), [&](const char* key, const JsonValue& member) {
      if (key && std::strcmp(key, "field") == 0) field = text(member);
      if (key && std::strcmp(key, "value") == 0) value = member;
    });
    const bool isText = value.type == JsonValue::Type::String;
    char decoded[1024] = "";
    const bool fits = isText && json::decodeString(value, decoded, sizeof decoded);
    const char* error = nullptr;
    if (field == "port") {
      uint32_t port = 0;
      error = json::toU32(value, port) ? portError(port) : PORT_ERROR;
    } else if (field == "host") {
      error = hostError(fits ? decoded : "");
    } else if (field == "base") {
      error = baseError(fits ? decoded : "");
    } else if (field == "key") {
      error = keyError(fits ? decoded : "");
    }
    JsonWriter json(out, sizeof out);
    json.open().key("error");
    if (error) {
      json.string(error);
    } else {
      json.null();
    }
    json.close();
    emit(json);
  });
}

/** A light's colour by name: which of the LED's three are lit. */
const char* hueName(const Rgb& light) {
  if (light.r && light.g && light.b) return "white";
  if (light.r && light.b) return "violet";
  if (light.r && light.g) return "amber";
  if (light.r) return "red";
  if (light.g) return "green";
  return light.b ? "blue" : "off";
}

void lights() {
  eachLine([](const std::string& line) {
    bool inSlot = false;
    bool answered = false;
    std::string body;
    json::readObject(line.data(), line.size(), [&](const char* key, const JsonValue& value) {
      if (key && std::strcmp(key, "slot") == 0) inSlot = text(value) == "in";
      if (key && std::strcmp(key, "body") == 0 && value.type == JsonValue::Type::String) {
        answered = true;
        body = text(value);
      }
    });
    // A player whose boot report (an empty slot) has been answered, as the firmware would be by now.
    static const char* const unchanged = R"({"ok":true,"v":2,"seq":0,"result":"unchanged","cue":"none","heartbeat_s":30})";
    Reporter reporter(1);
    Answer reply;
    reporter.settle(NO_UID, false, 0);
    reporter.begin();
    readAnswer(unchanged, std::strlen(unchanged), reply);
    reporter.finish(200, reply, 0);
    if (inSlot) reporter.slotChanged(Uid{{0x04, 0xA1, 0xB2, 0xC3}, 4}, 1000);
    if (inSlot && answered) {
      reporter.begin();
      readAnswer(body.data(), body.size(), reply);
      reporter.finish(200, reply, 1100);
    }
    // The line app.cpp builds every pass: on Wi-Fi, out of setup, with a reader that works.
    const AmbientInputs inputs = {false, false, reporter.reading(), true, reporter.hub(), reporter.standing()};
    const Ambient ambient = ambientFor(inputs);

    constexpr Millis SPAN = 6000;
    const Rgb first = Indicator::ambientLight(ambient, 0);
    const char* motion = "steady";
    for (Millis t = 1; t < SPAN; ++t) {
      const Rgb before = Indicator::ambientLight(ambient, t - 1);
      const Rgb light = Indicator::ambientLight(ambient, t);
      const int jump = std::abs(light.r - before.r) + std::abs(light.g - before.g) + std::abs(light.b - before.b);
      if (jump > 3) {
        motion = "blinking";
        break;
      }
      if (jump > 0) motion = "breathing";
    }
    // The shortest time after which the light repeats itself.
    Millis period = 0;
    for (Millis p = 1; p < SPAN && period == 0 && std::strcmp(motion, "steady") != 0; ++p) {
      bool repeats = true;
      for (Millis t = 0; t < SPAN && repeats; ++t) {
        repeats = Indicator::ambientLight(ambient, t) == Indicator::ambientLight(ambient, t + p);
      }
      if (repeats) period = p;
    }
    JsonWriter json(out, sizeof out);
    json.open().key("hue").string(hueName(first)).key("motion").string(motion).key("period_ms").number(period);
    json.close();
    emit(json);
  });
}

}  // namespace

int main(int argc, char** argv) {
  const char* command = argc > 1 ? argv[1] : "";
  if (std::strcmp(command, "reports") == 0) {
    reports();
  } else if (std::strcmp(command, "answers") == 0) {
    answers();
  } else if (std::strcmp(command, "setup-codes") == 0) {
    setupCodes();
  } else if (std::strcmp(command, "fields") == 0) {
    fields();
  } else if (std::strcmp(command, "lights") == 0) {
    lights();
  } else {
    std::fprintf(stderr, "usage: contract reports|answers|setup-codes|fields|lights\n");
    return 2;
  }
  return 0;
}
