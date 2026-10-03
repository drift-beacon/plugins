// Fixed-size text: every string the player keeps lives in a char array of known size, never on the heap.
#pragma once

#include <cstddef>
#include <cstring>

namespace cp {

/** Copies `text` into `out`, cut to fit and always terminated. Returns false when it was cut. */
inline bool copyText(char* out, size_t cap, const char* text) {
  if (cap == 0) return false;
  const size_t length = std::strlen(text);
  const size_t kept = length < cap ? length : cap - 1;
  std::memcpy(out, text, kept);
  out[kept] = '\0';
  return kept == length;
}

}  // namespace cp
