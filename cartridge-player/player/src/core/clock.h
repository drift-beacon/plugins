// Time as millis() gives it: a 32-bit count that wraps after 49.7 days. The player runs for months, so every
// comparison goes through these helpers, which stay right across the wrap.
#pragma once

#include <cstdint>

namespace cp {

using Millis = uint32_t;

/** True once `now` has reached `at`, even if the counter wrapped in between (for spans under 24 days). */
constexpr bool reached(Millis now, Millis at) { return static_cast<int32_t>(now - at) >= 0; }

/** How long ago `then` was. */
constexpr Millis since(Millis now, Millis then) { return now - then; }

}  // namespace cp
