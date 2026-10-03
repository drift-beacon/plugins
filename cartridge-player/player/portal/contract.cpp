// The player's half of the setup page's checks in tests/portal.test.mjs. It runs the production core (no Arduino in
// it, so it compiles on a host) and prints the player's verdict on what the page sends and shows, one JSON object
// per line, for the page's own script to be judged against:
//
//   contract names     every `field` and `phase` name the player can put in /api/state, and every `form` field it
//                      reads from POST /api/connect
//   contract wifi      for each {"field":"ssid"|"password","value"} line on stdin: the player's rule for that value
//   contract connect   for each {"saved":{…},"form":{…}} line: what the player makes of a POST /api/connect form
//   contract state     for each {"saved":{…}} line: the /api/state body the player writes. With a "form", while
//                      that Connect is joining; with "ip" too, while it probes; with "lost": true, after the
//                      network couldn't be found
//   contract scan      for each {"pollMs","polls"} line: what GET /api/scan tells a page that asks that often, as
//                      {"told":[{"scanning","failed"},…]}, while the radio takes no scan
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "../src/core/device.h"
#include "../src/core/json.h"
#include "../src/core/scan.h"
#include "../src/core/settings.h"
#include "../src/core/setup.h"
#include "../src/core/text.h"

using namespace cp;

namespace {

char out[4096];

void emit(JsonWriter& json) {
  if (json.finish() == 0) {
    std::fprintf(stderr, "contract: an output line didn't fit\n");
    std::exit(2);
  }
  std::puts(out);
}

/** Calls `handle` with each line of stdin. */
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

std::string text(const JsonValue& value) {
  static char buffer[4096];
  json::decodeString(value, buffer, sizeof buffer);
  return buffer;
}

/** Both enums are a byte wide, and a value that is no enumerator gets the switch's fallback (null, "idle"). */
void names() {
  JsonWriter json(out, sizeof out);
  json.open().key("fields").openArray();
  for (int value = 0; value < 256; ++value) {
    if (const char* name = fieldName(static_cast<Field>(value))) json.string(name);
  }
  json.closeArray().key("phases").openArray();
  std::string seen;
  for (int value = 0; value < 256; ++value) {
    const std::string name = phaseName(static_cast<Phase>(value));
    if (seen.find("," + name + ",") != std::string::npos) continue;
    seen += "," + name + ",";
    json.string(name.c_str());
  }
  json.closeArray().key("form").openArray();
  for (const char* name : CONNECT_FIELD_NAMES) json.string(name);
  json.closeArray().close();
  emit(json);
}

void wifi() {
  eachLine([](const std::string& line) {
    std::string field;
    std::string value;
    json::readObject(line.data(), line.size(), [&](const char* key, const JsonValue& member) {
      if (key && std::strcmp(key, "field") == 0) field = text(member);
      if (key && std::strcmp(key, "value") == 0) value = text(member);
    });
    const char* error = field == "ssid" ? ssidError(value.c_str()) : passwordError(value.c_str());
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

/** What the test says is saved: {"ssid","password","host","port","base","key"}, any of them left out. */
Settings savedFrom(const JsonValue& object) {
  Settings saved;
  json::readObject(object.raw, object.length, [&](const char* key, const JsonValue& value) {
    if (!key) return;
    const std::string name = key;
    uint32_t port = 0;
    if (name == "ssid") copyText(saved.ssid, sizeof saved.ssid, text(value).c_str());
    if (name == "password") copyText(saved.password, sizeof saved.password, text(value).c_str());
    if (name == "host") copyText(saved.hub.host, sizeof saved.hub.host, text(value).c_str());
    if (name == "port" && json::toU32(value, port)) saved.hub.port = static_cast<uint16_t>(port);
    if (name == "base") copyText(saved.hub.base, sizeof saved.hub.base, text(value).c_str());
    if (name == "key") copyText(saved.hub.key, sizeof saved.hub.key, text(value).c_str());
  });
  saved.configured = saved.hasWifi() && saved.hasHub() && saved.hub.key[0] != '\0';
  return saved;
}

/** One line of `connect` or `state`. */
struct Request {
  Settings saved;
  ConnectFields fields;
  bool hasForm = false;
  /** A posted field the player has no place for. */
  std::string unread;
  std::string ip;
  bool lost = false;
};

/**
 * The form goes through the player's own reader, `setConnectField`, under the names the page posted: the same call
 * serveConnect in src/hal/portal.cpp makes for every field, where one the page left out arrives as "".
 */
Request requestFrom(const std::string& line) {
  Request request;
  json::readObject(line.data(), line.size(), [&](const char* name, const JsonValue& member) {
    if (!name) return;
    const std::string key = name;
    if (key == "saved" && member.type == JsonValue::Type::Object) request.saved = savedFrom(member);
    if (key == "ip") request.ip = text(member);
    if (key == "lost") request.lost = member.type == JsonValue::Type::True;
    if (key != "form") return;
    request.hasForm = true;
    json::readObject(member.raw, member.length, [&](const char* field, const JsonValue& value) {
      if (field && !setConnectField(request.fields, field, text(value).c_str())) request.unread = field;
    });
  });
  return request;
}

void connect() {
  eachLine([](const std::string& line) {
    const Request request = requestFrom(line);
    static ConnectPlan plan;
    Problem problem;
    JsonWriter json(out, sizeof out);
    json.open();
    if (!request.unread.empty()) {
      json.key("ok").boolean(false).key("unread").string(request.unread.c_str());
    } else if (planConnect(request.fields.form(), request.saved, plan, problem)) {
      json.key("ok").boolean(true).key("ssid").string(plan.ssid).key("password").string(plan.password);
      json.key("host").string(plan.hub.host).key("port").number(plan.hub.port).key("base").string(plan.hub.base);
      json.key("key").string(plan.hub.key);
    } else {
      const char* field = fieldName(problem.field);
      json.key("ok").boolean(false).key("field").stringOrNull(field ? field : "");
      json.key("message").string(problem.message);
    }
    json.close();
    emit(json);
  });
}

void state() {
  eachLine([](const std::string& line) {
    const Request request = requestFrom(line);
    Attempt attempt;
    if (request.hasForm) {
      static ConnectPlan plan;
      Problem problem;
      if (!request.unread.empty() || !planConnect(request.fields.form(), request.saved, plan, problem)) {
        std::fprintf(stderr, "contract: state needs a form the player accepts\n");
        std::exit(2);
      }
      attempt.start(plan, 0);
      if (request.lost) {
        while (!attempt.joinFailed(wifi_reason::NO_AP_FOUND, 1000)) {
        }
      } else if (!request.ip.empty()) {
        attempt.joined(request.ip.c_str(), 1000);
      }
    }
    const uint8_t mac[6] = {0x24, 0x58, 0x7c, 0xa1, 0xb2, 0xc3};
    if (writeSetupState(identityFrom(mac), true, "8f3a5c1d", request.saved, attempt, out, sizeof out) == 0) {
      std::fprintf(stderr, "contract: the state didn't fit\n");
      std::exit(2);
    }
    std::puts(out);
  });
}

void scan() {
  eachLine([](const std::string& line) {
    uint32_t pollMs = 0;
    uint32_t polls = 0;
    json::readObject(line.data(), line.size(), [&](const char* key, const JsonValue& value) {
      if (key && std::strcmp(key, "pollMs") == 0) json::toU32(value, pollMs);
      if (key && std::strcmp(key, "polls") == 0) json::toU32(value, polls);
    });
    NetworkScan scan;
    JsonWriter json(out, sizeof out);
    json.open().key("told").openArray();
    Millis now = 0;
    for (uint32_t poll = 0; poll < polls; ++poll) {
      const NetworkScan::Told told = scan.request(now);
      json.open().key("scanning").boolean(told.scanning).key("failed").boolean(told.failed).close();
      // The loop until the next request, as handle() in src/hal/portal.cpp runs it, with a radio that refuses every
      // scan (the station is joining).
      for (const Millis next = now + pollMs; now < next; now += 10) {
        if (scan.startDue(now)) scan.started(false, now);
        scan.timedOut(now);
      }
    }
    json.closeArray().close();
    emit(json);
  });
}

}  // namespace

int main(int argc, char** argv) {
  const char* command = argc > 1 ? argv[1] : "";
  if (std::strcmp(command, "names") == 0) {
    names();
  } else if (std::strcmp(command, "wifi") == 0) {
    wifi();
  } else if (std::strcmp(command, "connect") == 0) {
    connect();
  } else if (std::strcmp(command, "state") == 0) {
    state();
  } else if (std::strcmp(command, "scan") == 0) {
    scan();
  } else {
    std::fprintf(stderr, "usage: contract names|wifi|connect|state|scan\n");
    return 2;
  }
  return 0;
}
