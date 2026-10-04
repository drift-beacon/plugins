// What the setup page's Connect does (DESIGN.md "Setup page API"): check the form, then join Wi-Fi, probe the plugin
// and save, one step at a time, with a sentence on the right field when a step fails. Pure: the portal and the loop
// feed it what happened and do what it says. The words the page and the player exchange are here too (the form's
// field names, the body of /api/state), so the host tests bind them and hal/portal.cpp only moves bytes.
#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>

#include "clock.h"
#include "device.h"
#include "json.h"
#include "protocol.h"
#include "settings.h"
#include "setup_code.h"
#include "text.h"

namespace cp {

/** The fields of `POST /api/connect`, as text. Missing fields are "". */
struct ConnectForm {
  const char* ssid = "";
  const char* password = "";
  bool keepPassword = false;
  const char* code = "";
  const char* host = "";
  const char* port = "";
  const char* base = "";
  const char* key = "";
  bool keepKey = false;
};

/** Every field of the form, by the name the setup page posts it under. */
constexpr const char* const CONNECT_FIELD_NAMES[] = {"ssid", "password", "keepPassword", "code", "host",
                                                     "port", "base",     "key",          "keepKey"};

/**
 * A posted form's own text. Each field is cut one byte past what any rule allows, so an overlong value fails its
 * check instead of fitting.
 */
struct ConnectFields {
  char ssid[SSID_SIZE + 1] = "";
  char password[PASSWORD_SIZE + 1] = "";
  bool keepPassword = false;
  char code[SETUP_CODE_MAX + 2] = "";
  char host[HOST_SIZE + 1] = "";
  char port[8] = "";
  char base[BASE_SIZE + 1] = "";
  char key[KEY_SIZE + 1] = "";
  bool keepKey = false;

  /** The form for `planConnect`. It points into these fields, so it lives no longer than they do. */
  ConnectForm form() const {
    ConnectForm form;
    form.ssid = ssid;
    form.password = password;
    form.keepPassword = keepPassword;
    form.code = code;
    form.host = host;
    form.port = port;
    form.base = base;
    form.key = key;
    form.keepKey = keepKey;
    return form;
  }
};

/**
 * Puts one posted field where it belongs. A keep flag is set by exactly "1". False for a name the form doesn't
 * have, which changes nothing.
 */
inline bool setConnectField(ConnectFields& fields, const char* name, const char* value) {
  struct Text {
    const char* name;
    char* out;
    size_t cap;
  };
  const Text texts[] = {
      {"ssid", fields.ssid, sizeof fields.ssid}, {"password", fields.password, sizeof fields.password},
      {"code", fields.code, sizeof fields.code}, {"host", fields.host, sizeof fields.host},
      {"port", fields.port, sizeof fields.port}, {"base", fields.base, sizeof fields.base},
      {"key", fields.key, sizeof fields.key},
  };
  for (const Text& text : texts) {
    if (std::strcmp(name, text.name) != 0) continue;
    copyText(text.out, text.cap, value);
    return true;
  }
  const bool flag = std::strcmp(value, "1") == 0;
  if (std::strcmp(name, "keepPassword") == 0) {
    fields.keepPassword = flag;
  } else if (std::strcmp(name, "keepKey") == 0) {
    fields.keepKey = flag;
  } else {
    return false;
  }
  return true;
}

/**
 * Whether a request body of this Content-Type is a form the API reads: urlencoded, and nothing else. A multipart
 * body is never read, whatever it carries. The test is the one the Arduino core's web server uses to decide how to
 * parse a body (a prefix, case as written), so what passes here is what it parsed as a form.
 */
inline bool isFormBody(const char* contentType) {
  static const char FORM[] = "application/x-www-form-urlencoded";
  return std::strncmp(contentType, FORM, sizeof FORM - 1) == 0;
}

/**
 * Reads a Connect form from one request. `eachPair` hands over every name and value that request carried, in order,
 * and nothing from any other request (hal/portal.cpp says how). The form starts empty, so a field the request
 * leaves out is "" and a flag is off, whatever an earlier form said; of a name sent twice the last counts.
 */
template <class EachPair>
void readConnectFields(ConnectFields& fields, EachPair&& eachPair) {
  fields = ConnectFields();
  eachPair([&fields](const char* name, const char* value) { setConnectField(fields, name, value); });
}

/** `POST /api/reset` erases only for a form that says `confirm=erase`, read the same way. */
template <class EachPair>
bool confirmsErase(EachPair&& eachPair) {
  bool confirmed = false;
  eachPair([&confirmed](const char* name, const char* value) {
    if (std::strcmp(name, "confirm") == 0) confirmed = std::strcmp(value, "erase") == 0;
  });
  return confirmed;
}

/** A checked form: what to join and which hub to probe. */
struct ConnectPlan {
  char ssid[SSID_SIZE] = "";
  char password[PASSWORD_SIZE] = "";
  HubTarget hub;
  /** The hub came from a setup code, so problems with it are shown on the code field. */
  bool fromCode = false;
  bool keyInCode = false;
};

/** Why a form or a step was refused, and which field to show it on. */
struct Problem {
  Field field = Field::None;
  const char* message = "";
};

namespace setup_rules {

inline bool blank(const char* text) {
  for (const char* c = text; *c; ++c) {
    if (*c != ' ' && *c != '\t' && *c != '\r' && *c != '\n') return false;
  }
  return true;
}

inline bool fail(Problem& problem, Field field, const char* message) {
  problem.field = field;
  problem.message = message;
  return false;
}

inline bool sameEndpoint(const HubTarget& a, const HubTarget& b) {
  return std::strcmp(a.host, b.host) == 0 && a.port == b.port && std::strcmp(a.base, b.base) == 0;
}

}  // namespace setup_rules

/** A Connect to the saved Wi-Fi network: the same name and the same password. */
inline bool onSavedNetwork(const ConnectPlan& plan, const Settings& saved) {
  return saved.hasWifi() && std::strcmp(plan.ssid, saved.ssid) == 0 && std::strcmp(plan.password, saved.password) == 0;
}

/**
 * Whether a network is saved as soon as it is joined, before the hub has answered over it. Only while no API key is
 * saved: a player that has one keeps its Wi-Fi until the new hub has answered, so the saved key never ends up on a
 * network picked at the open setup page.
 */
inline bool savesWifiOnJoin(const Settings& saved) { return saved.hub.key[0] == '\0'; }

/**
 * Checks a Connect form against the saved settings. A saved secret is reused only where it was proven: the password
 * for the same network, the key for the same host, port and base on the same network, with its saved password kept
 * rather than typed. An address means nothing by itself: on another network 192.168.1.12 is another machine. So
 * nobody at the setup page can have the saved key sent to a host, or over a network, of their choosing, or learn
 * from the answer whether a password they typed is the saved one.
 */
inline bool planConnect(const ConnectForm& form, const Settings& saved, ConnectPlan& plan, Problem& problem) {
  using setup_rules::fail;
  plan = ConnectPlan();
  if (const char* error = ssidError(form.ssid)) return fail(problem, Field::Ssid, error);
  copyText(plan.ssid, sizeof plan.ssid, form.ssid);
  if (form.keepPassword) {
    if (!saved.hasWifi() || std::strcmp(saved.ssid, form.ssid) != 0) {
      return fail(problem, Field::Password, "Type the password: a saved one is only kept for its own network");
    }
    copyText(plan.password, sizeof plan.password, saved.password);
  } else {
    if (const char* error = passwordError(form.password)) return fail(problem, Field::Password, error);
    copyText(plan.password, sizeof plan.password, form.password);
  }

  if (!setup_rules::blank(form.code)) {
    bool hasKey = false;
    if (!decodeSetupCode(form.code, plan.hub, hasKey)) {
      return fail(problem, Field::Code, "That isn't a whole setup code. Copy it again from Drift Beacon");
    }
    plan.fromCode = true;
    plan.keyInCode = hasKey;
    if (hasKey) return true;
  } else {
    if (const char* error = hostError(form.host)) return fail(problem, Field::Host, error);
    copyText(plan.hub.host, sizeof plan.hub.host, form.host);
    if (const char* error = portTextError(form.port, plan.hub.port)) return fail(problem, Field::Port, error);
    if (const char* error = baseError(form.base)) return fail(problem, Field::Base, error);
    copyText(plan.hub.base, sizeof plan.hub.base, form.base);
  }

  if (form.key[0]) {
    if (const char* error = keyError(form.key)) return fail(problem, Field::Key, error);
    copyText(plan.hub.key, sizeof plan.hub.key, form.key);
    return true;
  }
  if (form.keepKey) {
    if (!saved.hub.key[0] || !setup_rules::sameEndpoint(saved.hub, plan.hub)) {
      return fail(problem, Field::Key, "Paste the API key: the saved one is only kept for the same hub address");
    }
    // The saved password must have been kept, not typed again: a typed one compared with it would tell anyone at
    // the open page whether a guess was right, as fast as they can ask. An open network has no password to guess.
    const bool passwordKept = form.keepPassword || saved.password[0] == '\0';
    if (!passwordKept || !onSavedNetwork(plan, saved)) {
      return fail(problem, Field::Key, "Paste the API key: the saved one is only kept on the saved Wi-Fi network");
    }
    copyText(plan.hub.key, sizeof plan.hub.key, saved.hub.key);
    return true;
  }
  return fail(problem, Field::Key, plan.fromCode ? "This setup code has no API key: paste the key as well"
                                                 : "Paste the whole API key, without spaces");
}

/**
 * Where an attempt is. `done` and `failed` stay until the next attempt or until setup mode is entered again, so a
 * phone that reconnects sees them.
 */
enum class Phase : uint8_t { Idle, Joining, Probing, Done, Failed };

inline const char* phaseName(Phase phase) {
  switch (phase) {
    case Phase::Idle: return "idle";
    case Phase::Joining: return "joining";
    case Phase::Probing: return "probing";
    case Phase::Done: return "done";
    case Phase::Failed: return "failed";
  }
  return "idle";
}

/** Wi-Fi disconnect reasons (ESP-IDF `wifi_err_reason_t`) that tell the user something. */
namespace wifi_reason {
constexpr uint16_t AUTH_EXPIRE = 2;
constexpr uint16_t FOUR_WAY_HANDSHAKE_TIMEOUT = 15;
constexpr uint16_t AUTH_FAILED_8021X = 23;
constexpr uint16_t NO_AP_FOUND = 201;
constexpr uint16_t AUTH_FAIL = 202;
constexpr uint16_t HANDSHAKE_TIMEOUT = 204;
constexpr uint16_t NO_AP_WITH_COMPATIBLE_SECURITY = 210;
constexpr uint16_t NO_AP_IN_AUTHMODE_THRESHOLD = 211;
constexpr uint16_t NO_AP_IN_RSSI_THRESHOLD = 212;
}  // namespace wifi_reason

/** What the caller does with a finished probe. */
enum class ProbeVerdict : uint8_t { Save, Retry, Failed };

/** One Connect, from joining to saved. */
class Attempt {
 public:
  static constexpr Millis JOIN_TIMEOUT_MS = 20000;
  /**
   * A network gets a second try: the first association after power-up often fails once, and the Wi-Fi core then
   * retries by itself, so an error shown on the first failure would be about a join that is still going on.
   */
  static constexpr uint8_t JOIN_TRIES = 2;
  static constexpr Millis JOIN_RETRY_MS = 500;
  /** How soon to ask again when the radio wouldn't take the join (it was still busy with its last one). */
  static constexpr Millis JOIN_BUSY_MS = 1000;
  /** A hub that was restarting, or a first packet lost right after joining, gets this many tries. */
  static constexpr uint8_t PROBE_TRIES = 3;
  static constexpr Millis PROBE_RETRY_MS = 1500;
  static constexpr Millis MAX_PROBE_WAIT_MS = 5000;

  void start(const ConnectPlan& plan, Millis now) {
    const uint32_t id = id_ + 1;
    *this = Attempt();
    id_ = id;
    plan_ = plan;
    joinWanted_ = true;
    joinAt_ = now;
    enter(Phase::Joining, now);
  }

  /**
   * Setup mode was entered again: the last result is old news, and a page opened now starts from the form. The id
   * carries on, so the page can still tell one attempt from the next.
   */
  void reset() {
    const uint32_t id = id_;
    *this = Attempt();
    id_ = id;
  }

  /** True when the caller should ask the radio to join the plan's network now. Then `joinStarted` or `joinRefused`. */
  bool joinDue(Millis now) const { return phase_ == Phase::Joining && joinWanted_ && reached(now, joinAt_); }
  void joinStarted() {
    joinWanted_ = false;
    joinAsked_ = true;
  }
  void joinRefused(Millis now) { joinAt_ = now + JOIN_BUSY_MS; }

  /** Wi-Fi is up with this address: the probe can go. */
  void joined(const char* ip, Millis now) {
    if (phase_ != Phase::Joining) return;
    copyText(ip_, sizeof ip_, ip);
    probeAt_ = now;
    enter(Phase::Probing, now);
  }

  /**
   * The station was refused or lost while joining. True when that ends the attempt; false while the network still
   * has a try left (`joinDue` says when).
   */
  bool joinFailed(uint16_t reason, Millis now) {
    if (phase_ != Phase::Joining) return false;
    joinReason_ = reason;
    if (++joinFailures_ < JOIN_TRIES) {
      joinWanted_ = true;
      joinAt_ = now + JOIN_RETRY_MS;
      return false;
    }
    failJoin();
    return true;
  }

  /** True once if joining has taken too long (the attempt has then failed, with the last thing the network said). */
  bool joinTimedOut(Millis now) {
    if (phase_ != Phase::Joining || since(now, phaseAt_) < JOIN_TIMEOUT_MS) return false;
    if (joinFailures_ > 0) {
      failJoin();
    } else if (joinAsked_) {
      failWith(Field::Ssid, "Joined %s, but got no address from it in 20 seconds");
    } else {
      failWith(Field::Ssid, "The player's radio was busy and never got to join %s. Try again");
    }
    return true;
  }

  /**
   * True when the caller should probe the hub now. It does so only with the station up: while an attempt is probing
   * the station is on the attempt's own network, because losing it ends the attempt (`linkLost`).
   */
  bool probeDue(Millis now) const { return phase_ == Phase::Probing && !probing_ && reached(now, probeAt_); }
  void probeStarted() {
    probing_ = true;
    ++tries_;
  }
  /**
   * A probe of this attempt's is out. An answer that arrives when none is belongs to an attempt that has ended
   * since (its network dropped), and is nobody's to act on.
   */
  bool probeOut() const { return phase_ == Phase::Probing && probing_; }

  /**
   * The station lost its network while the hub was being asked. That ends the attempt: a probe sent now would not
   * travel over the network that was joined, and it carries the plan's key. True when it ended it.
   */
  bool linkLost() {
    if (phase_ != Phase::Probing) return false;
    probing_ = false;
    failWith(Field::Ssid, "Lost %s before the hub answered. Try again");
    return true;
  }

  /** What the probe got: save the hub, wait and probe again, or the attempt has failed. */
  ProbeVerdict probeFinished(int status, const Answer& answer, Millis now) {
    probing_ = false;
    if (phase_ != Phase::Probing) return ProbeVerdict::Failed;
    switch (classify(status)) {
      case Delivery::Delivered:
        if (isProbeAnswer(answer)) return ProbeVerdict::Save;
        failHub(Field::Base, "Something answered at %s:%u, but it isn't Cartridge Player. Check the port and the path");
        return ProbeVerdict::Failed;
      case Delivery::KeyRejected:
        failHub(Field::Key, status == 403 ? "The hub refused this API key (it has no workspace)"
                                          : "The hub didn't accept this API key");
        return ProbeVerdict::Failed;
      case Delivery::NotFound:
        failHub(Field::Base, "Nothing answers at this plugin path. Is Cartridge Player installed, up to date and on?");
        return ProbeVerdict::Failed;
      case Delivery::Dropped:
      case Delivery::Retry:
        break;
    }
    const bool busy = status == 502 || status == 503 || status == 504 || requestedWait(answer) > 0;
    if ((status < 0 || busy) && tries_ < PROBE_TRIES) {
      const Millis wait = requestedWait(answer);
      probeAt_ = now + (wait == 0 ? PROBE_RETRY_MS : wait < MAX_PROBE_WAIT_MS ? wait : MAX_PROBE_WAIT_MS);
      return ProbeVerdict::Retry;
    }
    if (status < 0) {
      failHub(Field::Host, "Can't reach %s:%u. Check the address, and that the hub is on this network");
    } else if (busy) {
      failHub(Field::Host, "The hub at %s:%u is busy or restarting. Try again in a moment");
    } else {
      char format[96];
      std::snprintf(format, sizeof format, "The hub at %%s:%%u answered HTTP %d. Check the address", status);
      failHub(Field::Host, format);
    }
    return ProbeVerdict::Failed;
  }

  /** Everything saved: the setup page can show the result. */
  void done(Millis now) {
    message_[0] = '\0';
    field_ = Field::None;
    enter(Phase::Done, now);
  }

  /** Preferences refused a write. */
  void saveFailed() {
    field_ = Field::None;
    copyText(message_, sizeof message_, "The player couldn't save its settings. Try again, or reset it");
    phase_ = Phase::Failed;
  }

  bool active() const { return phase_ == Phase::Joining || phase_ == Phase::Probing; }
  uint32_t id() const { return id_; }
  Phase phase() const { return phase_; }
  Field field() const { return field_; }
  const char* message() const { return message_; }
  /** The address Wi-Fi gave, or "" before then. */
  const char* ip() const { return ip_; }
  const ConnectPlan& plan() const { return plan_; }

 private:
  void enter(Phase phase, Millis now) {
    phase_ = phase;
    phaseAt_ = now;
    if (phase != Phase::Failed) {
      field_ = Field::None;
      message_[0] = '\0';
    }
  }

  void failWith(Field field, const char* format) {
    std::snprintf(message_, sizeof message_, format, plan_.ssid);
    field_ = field;
    phase_ = Phase::Failed;
  }

  /** Joining failed for good: what the network's last refusal means, on the field it is about. */
  void failJoin() {
    using namespace wifi_reason;
    switch (joinReason_) {
      case NO_AP_FOUND:
      case NO_AP_IN_RSSI_THRESHOLD:
        failWith(Field::Ssid, "Can't find %s. Check the name, and that the player is in range of it");
        break;
      case AUTH_EXPIRE:
      case FOUR_WAY_HANDSHAKE_TIMEOUT:
      case AUTH_FAILED_8021X:
      case AUTH_FAIL:
      case HANDSHAKE_TIMEOUT:
        failWith(Field::Password, plan_.password[0] ? "%s didn't accept this password" : "%s needs a password");
        break;
      case NO_AP_WITH_COMPATIBLE_SECURITY:
      case NO_AP_IN_AUTHMODE_THRESHOLD:
        failWith(Field::Password, "Can't join %s with this password, or without one");
        break;
      default:
        failWith(Field::Ssid, "Couldn't join %s. Try again, closer to the router");
    }
  }

  /** A hub problem: on the setup code's field when the hub came from one. */
  void failHub(Field field, const char* format) {
    // A host can be longer than the message has room for: the message is cut there, which is fine for a hint.
    const int written =
        std::snprintf(message_, sizeof message_, format, plan_.hub.host, static_cast<unsigned>(plan_.hub.port));
    if (written < 0) message_[0] = '\0';
    const bool onCode = plan_.fromCode && (field != Field::Key || plan_.keyInCode);
    field_ = onCode ? Field::Code : field;
    phase_ = Phase::Failed;
  }

  ConnectPlan plan_;
  uint32_t id_ = 0;
  Phase phase_ = Phase::Idle;
  Millis phaseAt_ = 0;
  Field field_ = Field::None;
  char message_[160] = "";
  char ip_[16] = "";
  bool joinWanted_ = false;
  bool joinAsked_ = false;
  Millis joinAt_ = 0;
  uint8_t joinFailures_ = 0;
  uint16_t joinReason_ = 0;
  uint8_t tries_ = 0;
  bool probing_ = false;
  Millis probeAt_ = 0;
};

/**
 * The body of `GET /api/state`: who the player is, what is saved (a secret only as "there is one") and where the
 * last Connect stands, with the network it is for. Returns its length, or 0 when it doesn't fit.
 */
inline size_t writeSetupState(const Identity& identity, bool readerWorking, const char* token, const Settings& saved,
                              const Attempt& attempt, char* out, size_t cap) {
  JsonWriter json(out, cap);
  json.open();
  json.key("device").open();
  json.key("id").string(identity.id).key("name").string(identity.name).key("fw").string(FIRMWARE_VERSION);
  json.key("reader").string(readerWorking ? "ok" : "fault");
  json.close();
  json.key("token").string(token);
  json.key("configured").boolean(saved.configured);
  json.key("saved");
  if (saved.hasWifi() || saved.hasHub()) {
    json.open();
    json.key("ssid").stringOrNull(saved.ssid).key("hasPassword").boolean(saved.password[0] != '\0');
    json.key("host").stringOrNull(saved.hub.host).key("port");
    if (saved.hub.port) {
      json.number(saved.hub.port);
    } else {
      json.null();
    }
    json.key("base").stringOrNull(saved.hub.base).key("hasKey").boolean(saved.hub.key[0] != '\0');
    json.close();
  } else {
    json.null();
  }
  json.key("attempt").open();
  json.key("id").number(attempt.id()).key("phase").string(phaseName(attempt.phase()));
  json.key("message").string(attempt.message()).key("field");
  if (const char* name = fieldName(attempt.field())) {
    json.string(name);
  } else {
    json.null();
  }
  // The attempt's own network, not the form's or the saved one: a page opened part-way names what is being joined.
  json.key("ip").stringOrNull(attempt.ip()).key("ssid").stringOrNull(attempt.plan().ssid);
  json.close();
  json.close();
  return json.finish();
}

}  // namespace cp
