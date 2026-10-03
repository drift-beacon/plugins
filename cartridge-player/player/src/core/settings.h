// The player's settings and the rules every value must pass before it's saved or used. The hub rules are the same as
// `setupFieldError` in shared/setup-code.ts (tests/firmware.test.mjs checks both sides against the same vectors).
// `settingsFrom` is how saved values load: by the same rules, so nothing is used that setup would refuse.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

#include "text.h"

namespace cp {

/** Which setup field a problem is about. The setup page shows the message on that field. */
enum class Field : uint8_t { None, Ssid, Password, Host, Port, Base, Key, Code };

inline const char* fieldName(Field field) {
  switch (field) {
    case Field::None: return nullptr;
    case Field::Ssid: return "ssid";
    case Field::Password: return "password";
    case Field::Host: return "host";
    case Field::Port: return "port";
    case Field::Base: return "base";
    case Field::Key: return "key";
    case Field::Code: return "code";
  }
  return nullptr;
}

constexpr size_t SSID_SIZE = 33;
constexpr size_t PASSWORD_SIZE = 65;
constexpr size_t HOST_SIZE = 254;
/** "/api/plugins/" + an id of up to 128 characters + "/api". */
constexpr size_t BASE_SIZE = 146;
constexpr size_t KEY_SIZE = 257;

/** Where the plugin is and how to get in: what a setup code carries. */
struct HubTarget {
  char host[HOST_SIZE] = "";
  uint16_t port = 0;
  char base[BASE_SIZE] = "";
  char key[KEY_SIZE] = "";
};

/** Everything saved, as the player uses it. */
struct Settings {
  char ssid[SSID_SIZE] = "";
  char password[PASSWORD_SIZE] = "";
  HubTarget hub;
  bool buzzer = true;
  /** Wi-Fi and a complete hub: the player can run. Otherwise it stays in setup mode. */
  bool configured = false;

  bool hasWifi() const { return ssid[0] != '\0'; }
  bool hasHub() const { return hub.host[0] != '\0' && hub.port != 0 && hub.base[0] != '\0'; }
};

namespace rules {

inline bool isNameCharacter(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
         c == '.';
}

inline bool allName(const char* from, const char* to) {
  for (const char* c = from; c < to; ++c) {
    if (!isNameCharacter(*c)) return false;
  }
  return true;
}

}  // namespace rules

/** `setupFieldError("host", …)`: a host name or IPv4 address, no scheme, port or path. */
inline const char* hostError(const char* host) {
  const size_t length = std::strlen(host);
  if (length < 1 || length > 253 || !rules::allName(host, host + length)) {
    return "Enter the hub's host name or IP address, without http:// or a port";
  }
  return nullptr;
}

constexpr const char* PORT_ERROR = "Enter a port from 1 to 65535";

/** `setupFieldError("port", …)`. */
inline const char* portError(uint32_t port) { return port >= 1 && port <= 65535 ? nullptr : PORT_ERROR; }

/** A port typed into a form: digits only, then the same rule. */
inline const char* portTextError(const char* text, uint16_t& out) {
  uint32_t value = 0;
  size_t digits = 0;
  for (const char* c = text; *c; ++c) {
    if (*c < '0' || *c > '9' || ++digits > 5) return PORT_ERROR;
    value = value * 10 + static_cast<uint32_t>(*c - '0');
  }
  if (digits == 0 || portError(value)) return PORT_ERROR;
  out = static_cast<uint16_t>(value);
  return nullptr;
}

/** `setupFieldError("base", …)`: /api/plugins/<id>/api, the id 1–128 name characters and not "." or "..". */
inline const char* baseError(const char* base) {
  static const char* const ERROR = "The plugin path must look like /api/plugins/<id>/api";
  const char* prefix = "/api/plugins/";
  const char* suffix = "/api";
  const size_t prefixLength = std::strlen(prefix);
  const size_t suffixLength = std::strlen(suffix);
  const size_t length = std::strlen(base);
  if (length <= prefixLength + suffixLength || std::strncmp(base, prefix, prefixLength) != 0 ||
      std::strcmp(base + length - suffixLength, suffix) != 0) {
    return ERROR;
  }
  const char* id = base + prefixLength;
  const size_t idLength = length - prefixLength - suffixLength;
  if (idLength > 128 || !rules::allName(id, id + idLength)) return ERROR;
  if ((idLength == 1 && id[0] == '.') || (idLength == 2 && id[0] == '.' && id[1] == '.')) return ERROR;
  return nullptr;
}

/** `setupFieldError("key", …)`: 8–256 printable ASCII characters, no spaces. */
inline const char* keyError(const char* key) {
  const size_t length = std::strlen(key);
  if (length < 8 || length > 256) return "Paste the whole API key, without spaces";
  for (const char* c = key; *c; ++c) {
    if (*c < 0x21 || *c > 0x7E) return "Paste the whole API key, without spaces";
  }
  return nullptr;
}

/** A network name is 1–32 bytes. */
inline const char* ssidError(const char* ssid) {
  const size_t length = std::strlen(ssid);
  if (length == 0) return "Choose a network, or type its name";
  if (length > 32) return "A network name is at most 32 bytes";
  return nullptr;
}

/** Empty for an open network; otherwise a WPA passphrase (8–63 characters) or a 64-digit hex key. */
inline const char* passwordError(const char* password) {
  static const char* const ERROR = "A Wi-Fi password is 8 to 63 characters";
  const size_t length = std::strlen(password);
  if (length == 0) return nullptr;
  if (length == 64) {
    for (const char* c = password; *c; ++c) {
      if (!((*c >= '0' && *c <= '9') || (*c >= 'a' && *c <= 'f') || (*c >= 'A' && *c <= 'F'))) return ERROR;
    }
    return nullptr;
  }
  if (length < 8 || length > 63) return ERROR;
  for (const char* c = password; *c; ++c) {
    if (static_cast<unsigned char>(*c) < 0x20 || *c == 0x7F) return ERROR;
  }
  return nullptr;
}

/** The values as they come out of Preferences. */
struct StoredValues {
  const char* ssid = "";
  const char* password = "";
  const char* host = "";
  uint16_t port = 0;
  const char* base = "";
  const char* key = "";
  bool buzzer = true;
};

/**
 * Settings from what is saved. Wi-Fi is used whenever it's there; the hub only when all of it is valid, the key
 * included. With both, the player is configured.
 */
inline Settings settingsFrom(const StoredValues& stored) {
  Settings settings;
  settings.buzzer = stored.buzzer;
  if (!ssidError(stored.ssid) && !passwordError(stored.password)) {
    copyText(settings.ssid, sizeof settings.ssid, stored.ssid);
    copyText(settings.password, sizeof settings.password, stored.password);
  }
  if (!hostError(stored.host) && !portError(stored.port) && !baseError(stored.base) && !keyError(stored.key)) {
    copyText(settings.hub.host, sizeof settings.hub.host, stored.host);
    settings.hub.port = stored.port;
    copyText(settings.hub.base, sizeof settings.hub.base, stored.base);
    copyText(settings.hub.key, sizeof settings.hub.key, stored.key);
  }
  settings.configured = settings.hasWifi() && settings.hasHub();
  return settings;
}

}  // namespace cp
