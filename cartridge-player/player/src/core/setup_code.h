// The setup code the plugin's interface builds and the setup page accepts: "CP1-" and the base64url of
// {"h":host,"p":port,"b":base,"k":key?}. The same rules as `decodeSetupCode` in shared/setup-code.ts, down to which
// whitespace is trimmed and that a repeated field takes its last value; tests/firmware.test.mjs checks both agree.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

#include "json.h"
#include "settings.h"

namespace cp {

constexpr const char* SETUP_CODE_PREFIX = "CP1-";
/** Longer than any code `encodeSetupCode` can make (a 253-character host and a 256-character key). */
constexpr size_t SETUP_CODE_MAX = 1600;

namespace setup_code {

/** Bytes of the whitespace character starting at `p` (what JavaScript's trim() removes), or 0. */
inline size_t spaceAt(const unsigned char* p, const unsigned char* end) {
  const size_t left = static_cast<size_t>(end - p);
  if (left >= 1 && ((p[0] >= 0x09 && p[0] <= 0x0D) || p[0] == 0x20)) return 1;
  if (left >= 2 && p[0] == 0xC2 && p[1] == 0xA0) return 2;
  if (left < 3) return 0;
  if (p[0] == 0xE1 && p[1] == 0x9A && p[2] == 0x80) return 3;
  if (p[0] == 0xE2 && p[1] == 0x80 && ((p[2] >= 0x80 && p[2] <= 0x8A) || p[2] == 0xA8 || p[2] == 0xA9 || p[2] == 0xAF))
    return 3;
  if (p[0] == 0xE2 && p[1] == 0x81 && p[2] == 0x9F) return 3;
  if (p[0] == 0xE3 && p[1] == 0x80 && p[2] == 0x80) return 3;
  if (p[0] == 0xEF && p[1] == 0xBB && p[2] == 0xBF) return 3;
  return 0;
}

/** Bytes of the whitespace character ending at `end`, or 0. */
inline size_t spaceBefore(const unsigned char* begin, const unsigned char* end) {
  for (size_t length = 1; length <= 3 && static_cast<size_t>(end - begin) >= length; ++length) {
    if (spaceAt(end - length, end) == length) return length;
  }
  return 0;
}

inline int base64Value(unsigned char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '-') return 62;
  if (c == '_') return 63;
  return -1;
}

/** base64url without padding, as `atob` takes it once '-' and '_' are swapped back. Returns the length, or -1. */
inline long decodeBase64Url(const unsigned char* text, size_t length, char* out, size_t cap) {
  if (length == 0 || length % 4 == 1) return -1;
  uint32_t bits = 0;
  int count = 0;
  size_t at = 0;
  for (size_t i = 0; i < length; ++i) {
    const int value = base64Value(text[i]);
    if (value < 0) return -1;
    bits = (bits << 6) | static_cast<uint32_t>(value);
    count += 6;
    if (count >= 8) {
      count -= 8;
      if (at >= cap) return -1;
      out[at++] = static_cast<char>((bits >> count) & 0xFF);
    }
  }
  return static_cast<long>(at);
}

}  // namespace setup_code

/**
 * A pasted setup code (surrounding whitespace is fine), or false when it isn't a valid one. `hasKey` says whether it
 * carried the API key; without one the setup page asks for it.
 */
inline bool decodeSetupCode(const char* text, HubTarget& out, bool& hasKey) {
  const unsigned char* begin = reinterpret_cast<const unsigned char*>(text);
  const unsigned char* end = begin + std::strlen(text);
  if (static_cast<size_t>(end - begin) > SETUP_CODE_MAX) return false;
  while (size_t length = setup_code::spaceAt(begin, end)) begin += length;
  while (size_t length = setup_code::spaceBefore(begin, end)) end -= length;
  const size_t prefixLength = std::strlen(SETUP_CODE_PREFIX);
  if (static_cast<size_t>(end - begin) < prefixLength ||
      std::memcmp(begin, SETUP_CODE_PREFIX, prefixLength) != 0) {
    return false;
  }
  char payload[SETUP_CODE_MAX * 3 / 4 + 4];
  const long length = setup_code::decodeBase64Url(begin + prefixLength, static_cast<size_t>(end - begin) - prefixLength,
                                                  payload, sizeof payload);
  if (length < 0) return false;

  HubTarget hub;
  bool hostOk = false;
  bool portOk = false;
  bool baseOk = false;
  bool keySeen = false;
  bool keyOk = false;
  const bool parsed = json::readObject(payload, static_cast<size_t>(length), [&](const char* key, const JsonValue& value) {
    if (!key) return;
    const bool text = value.type == JsonValue::Type::String;
    if (std::strcmp(key, "h") == 0) {
      hostOk = text && json::decodeString(value, hub.host, sizeof hub.host) && !hostError(hub.host);
    } else if (std::strcmp(key, "p") == 0) {
      uint32_t port = 0;
      portOk = json::toU32(value, port) && !portError(port);
      hub.port = portOk ? static_cast<uint16_t>(port) : 0;
    } else if (std::strcmp(key, "b") == 0) {
      baseOk = text && json::decodeString(value, hub.base, sizeof hub.base) && !baseError(hub.base);
    } else if (std::strcmp(key, "k") == 0) {
      keySeen = true;
      keyOk = text && json::decodeString(value, hub.key, sizeof hub.key) && !keyError(hub.key);
    }
  });
  if (!parsed || !hostOk || !portOk || !baseOk || (keySeen && !keyOk)) return false;
  if (!keySeen) hub.key[0] = '\0';
  out = hub;
  hasKey = keySeen;
  return true;
}

}  // namespace cp
