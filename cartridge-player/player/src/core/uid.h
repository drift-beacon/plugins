// A cartridge's NFC UID. Its text form is the key of the plugin's `tagMappings` storage: upper-case hex pairs joined
// by ':' ("04:A1:B2:C3"). Changing a single character of it would turn every labelled cartridge into an unknown
// one, so the formatter is pinned by golden vectors in tests/test_uid.cpp.
#pragma once

#include <cstddef>
#include <cstdint>

namespace cp {

/** A UID as the reader returns it: 4, 7 or 10 bytes. `size` 0 means none (an empty slot). */
struct Uid {
  uint8_t bytes[10];
  uint8_t size;
};

constexpr Uid NO_UID = {{0}, 0};

/** Longest text form, with its terminator: ten bytes as "XX" plus nine separators. */
constexpr size_t UID_TEXT_SIZE = 30;

inline bool sameUid(const Uid& a, const Uid& b) {
  if (a.size != b.size) return false;
  for (uint8_t i = 0; i < a.size; ++i) {
    if (a.bytes[i] != b.bytes[i]) return false;
  }
  return true;
}

/**
 * Cards that make up a new UID on every power-up (phones, some bank cards) answer with a 4-byte UID starting with
 * 0x08. They can never be a cartridge, and counting them would make one "new cartridge" per placement.
 */
inline bool isRandomUid(const Uid& uid) { return uid.size == 4 && uid.bytes[0] == 0x08; }

/** Writes the UID as "04:A1:B2:C3". Returns the length, or 0 when `cap` is too small or the UID is empty. */
inline size_t formatUid(const Uid& uid, char* out, size_t cap) {
  static const char DIGITS[] = "0123456789ABCDEF";
  if (uid.size == 0 || uid.size > sizeof uid.bytes) return 0;
  const size_t length = uid.size * 3u - 1u;
  if (cap <= length) return 0;
  char* at = out;
  for (uint8_t i = 0; i < uid.size; ++i) {
    if (i > 0) *at++ = ':';
    *at++ = DIGITS[uid.bytes[i] >> 4];
    *at++ = DIGITS[uid.bytes[i] & 0x0F];
  }
  *at = '\0';
  return length;
}

}  // namespace cp
