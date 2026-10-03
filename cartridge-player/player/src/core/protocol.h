// What the player says to the plugin and what it understands back: the C++ side of shared/protocol.ts.
// tests/firmware.test.mjs feeds the bodies written here through `parseReport`, and the replies built by
// `playerReply`/`probeReply` through `readAnswer`, so a change on one side that the other can't read fails there.
// The bodies come from the same calls the firmware makes (core/slot_feed.h), not from a copy in the test.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

#include "json.h"
#include "uid.h"

namespace cp {

constexpr const char* PLAYER_KIND = "cartridge-player";
constexpr uint32_t PROTOCOL = 2;
/** Every reply carries the heartbeat; this is only used until the first one arrives. */
constexpr uint32_t DEFAULT_HEARTBEAT_S = 30;
/** The route under the plugin's API base, for reports and the setup probe alike. */
constexpr const char* REPORT_ROUTE = "/player";
/** Replies are kept under 512 bytes by the plugin; the player reads at most this much. */
constexpr size_t ANSWER_MAX = 512;
/** A report with the longest UID and names is about 260 bytes. */
constexpr size_t REPORT_MAX = 384;

/** Why a report was sent. The plugin acts on what it says, not why; `boot` marks a fresh start. */
enum class Reason : uint8_t { Boot, Pair, Change, Heartbeat, Reconnect };

inline const char* reasonName(Reason reason) {
  switch (reason) {
    case Reason::Boot: return "boot";
    case Reason::Pair: return "pair";
    case Reason::Change: return "change";
    case Reason::Heartbeat: return "heartbeat";
    case Reason::Reconnect: return "reconnect";
  }
  return "heartbeat";
}

/**
 * The one `result` the player tells from the others (`ReportResult` in shared/protocol.ts): its cue is `ok`, like a
 * session that started, but nothing is running after it, and the light says so (core/reporter.h).
 */
constexpr const char* RESULT_MARKED = "marked";

/** The sound and light for a reply, as the plugin chooses it (`cueFor` in shared/protocol.ts). */
enum class Cue : uint8_t { None, Ok, Bye, Unknown, Error };

inline Cue cueNamed(const char* name) {
  if (std::strcmp(name, "ok") == 0) return Cue::Ok;
  if (std::strcmp(name, "bye") == 0) return Cue::Bye;
  if (std::strcmp(name, "unknown") == 0) return Cue::Unknown;
  if (std::strcmp(name, "error") == 0) return Cue::Error;
  return Cue::None;
}

/** Everything a protocol-2 report says. Text fields point at the caller's buffers. */
struct ReportBody {
  const char* deviceId;
  const char* firmware;
  const char* name;
  uint32_t boot;
  uint32_t seq;
  Reason reason;
  Uid tag;
  uint32_t ageMs;
  bool hasRssi;
  int32_t rssi;
  uint32_t uptimeS;
  bool readerFault;
};

/**
 * The report body `parseReport` reads:
 * {"v":2,"device":{"id","fw","name"},"boot","seq","reason","tag":"04:A2:…"|null,"age_ms","rssi","uptime_s","reader"}.
 * Returns its length, or 0 when it doesn't fit.
 */
inline size_t writeReport(const ReportBody& report, char* out, size_t cap) {
  JsonWriter json(out, cap);
  json.open().key("v").number(PROTOCOL);
  json.key("device").open();
  json.key("id").string(report.deviceId).key("fw").string(report.firmware).key("name").string(report.name);
  json.close();
  json.key("boot").number(report.boot).key("seq").number(report.seq).key("reason").string(reasonName(report.reason));
  char tag[UID_TEXT_SIZE];
  if (formatUid(report.tag, tag, sizeof tag)) {
    json.key("tag").string(tag);
  } else {
    json.key("tag").null();
  }
  json.key("age_ms").number(report.ageMs);
  json.key("rssi");
  if (report.hasRssi) {
    json.number(report.rssi);
  } else {
    json.null();
  }
  json.key("uptime_s").number(report.uptimeS).key("reader").string(report.readerFault ? "fault" : "ok");
  json.close();
  return json.finish();
}

/**
 * What the player takes from any answer: a reply (`playerReply`), an `ErrorReply`, a probe answer (`probeReply`) or
 * the platform's own `{ success: false, error }`. Missing fields keep their defaults; unknown ones are ignored.
 */
struct Answer {
  bool parsed = false;
  bool ok = false;
  bool hasSeq = false;
  uint32_t seq = 0;
  char result[16] = "";
  Cue cue = Cue::None;
  uint32_t heartbeatS = 0;
  char activity[48] = "";
  char code[16] = "";
  uint32_t retryMs = 0;
  char player[24] = "";
  uint32_t protocol = 0;
  char error[96] = "";
};

/** Reads an answer body. False when it isn't a JSON object (an HTML error page, a cut body). */
inline bool readAnswer(const char* body, size_t length, Answer& out) {
  out = Answer();
  out.parsed = json::readObject(body, length, [&out](const char* key, const JsonValue& value) {
    if (!key) return;
    const bool text = value.type == JsonValue::Type::String;
    if (std::strcmp(key, "ok") == 0) {
      out.ok = value.type == JsonValue::Type::True;
    } else if (std::strcmp(key, "seq") == 0) {
      out.hasSeq = json::toU32(value, out.seq);
    } else if (std::strcmp(key, "result") == 0) {
      if (!text || !json::decodeString(value, out.result, sizeof out.result)) out.result[0] = '\0';
    } else if (std::strcmp(key, "cue") == 0) {
      char name[12];
      out.cue = text && json::decodeString(value, name, sizeof name) ? cueNamed(name) : Cue::None;
    } else if (std::strcmp(key, "heartbeat_s") == 0) {
      if (!json::toU32(value, out.heartbeatS)) out.heartbeatS = 0;
    } else if (std::strcmp(key, "activity") == 0) {
      if (text) {
        json::decodeString(value, out.activity, sizeof out.activity);
      } else {
        out.activity[0] = '\0';
      }
    } else if (std::strcmp(key, "code") == 0) {
      if (!text || !json::decodeString(value, out.code, sizeof out.code)) out.code[0] = '\0';
    } else if (std::strcmp(key, "retry_ms") == 0) {
      if (!json::toU32(value, out.retryMs)) out.retryMs = 0;
    } else if (std::strcmp(key, "player") == 0) {
      if (!text || !json::decodeString(value, out.player, sizeof out.player)) out.player[0] = '\0';
    } else if (std::strcmp(key, "protocol") == 0) {
      if (!json::toU32(value, out.protocol)) out.protocol = 0;
    } else if (std::strcmp(key, "error") == 0) {
      if (text) {
        json::decodeString(value, out.error, sizeof out.error);
      } else {
        out.error[0] = '\0';
      }
    }
  });
  if (!out.parsed) out = Answer();
  return out.parsed;
}

/** The probe answer a player checks before it saves a hub: this plugin, speaking protocol 2. */
inline bool isProbeAnswer(const Answer& answer) {
  return answer.ok && std::strcmp(answer.player, PLAYER_KIND) == 0 && answer.protocol == PROTOCOL;
}

/** What became of a request, by the rules in DESIGN.md "Delivery". */
enum class Delivery : uint8_t {
  Delivered,    // 2xx: the plugin has it (for a report, only with the plugin's reply: `reportDelivery`)
  Dropped,      // 400: sending the same report again won't help
  KeyRejected,  // 401/403
  NotFound,     // 404: wrong path, or the plugin is off
  Retry,        // no answer, 502/503/504, `code: "retry"`, anything else: try again later
};

/** `status` is the HTTP status, or negative when no answer came (refused, timed out, no route). */
inline Delivery classify(int status) {
  if (status >= 200 && status < 300) return Delivery::Delivered;
  if (status == 400) return Delivery::Dropped;
  if (status == 401 || status == 403) return Delivery::KeyRejected;
  if (status == 404) return Delivery::NotFound;
  return Delivery::Retry;
}

/**
 * What became of a report. A 2xx only counts when its body is the plugin's reply (every reply carries `ok: true`).
 * Anything else answering 2xx at the hub's address (a proxy's page, another device with the hub's old IP), or a
 * reply cut short on the way, is retried: the repeat gets the plugin's cached reply, and a stranger never looks
 * like a healthy hub.
 */
inline Delivery reportDelivery(int status, const Answer& answer) {
  const Delivery delivery = classify(status);
  return delivery == Delivery::Delivered && !answer.ok ? Delivery::Retry : delivery;
}

/** How long the plugin asked the player to wait (`ErrorReply` `retry_ms`), or 0 when it didn't. */
inline uint32_t requestedWait(const Answer& answer) {
  return std::strcmp(answer.code, "retry") == 0 ? answer.retryMs : 0;
}

}  // namespace cp
