// A few lines of test harness for the host tests: each test file is one program that exits non-zero on a failure.
// tests/firmware.test.mjs compiles and runs them; there is no framework to install.
#pragma once

#include <cstdio>
#include <cstring>

namespace check {

inline int failures = 0;
inline const char* current = "";

inline void fail(const char* file, int line, const char* what) {
  std::fprintf(stderr, "%s:%d: [%s] %s\n", file, line, current, what);
  ++failures;
}

/** A text that isn't the expected one. Printed directly: no buffer for a long text to be cut by. */
inline void failText(const char* file, int line, const char* what, const char* actual, const char* expected) {
  std::fprintf(stderr, "%s:%d: [%s] %s is \"%s\", expected \"%s\"\n", file, line, current, what,
               actual ? actual : "(null)", expected);
  ++failures;
}

/** Runs one named test: the name says which rule of the player's it protects. */
template <class Test>
void run(const char* name, Test&& test) {
  current = name;
  const int before = failures;
  test();
  std::printf("%s %s\n", failures == before ? "ok  " : "FAIL", name);
}

inline int result() { return failures == 0 ? 0 : 1; }

}  // namespace check

#define CHECK(condition) ((condition) ? (void)0 : check::fail(__FILE__, __LINE__, #condition))
#define CHECK_TEXT(actual, expected)                                                               \
  do {                                                                                             \
    const char* checkActual_ = (actual);                                                           \
    const char* checkExpected_ = (expected);                                                       \
    if (!checkActual_ || std::strcmp(checkActual_, checkExpected_) != 0) {                         \
      check::failText(__FILE__, __LINE__, #actual, checkActual_, checkExpected_);                  \
    }                                                                                              \
  } while (false)
