// The player's two local inputs: the BOOT button (hold 3 s for setup mode) and the serial console. Both are polled
// from the loop, so neither can stall the reader.
#pragma once

#include <cstddef>
#include <cstdint>

#include "clock.h"

namespace cp {

/** Fires once when a button has been held down for `HOLD_MS`; it fires again only after a release. */
class LongPress {
 public:
  static constexpr Millis HOLD_MS = 3000;

  bool update(bool pressed, Millis now) {
    if (!pressed) {
      down_ = false;
      fired_ = false;
      return false;
    }
    if (!down_) {
      down_ = true;
      downAt_ = now;
    }
    if (!fired_ && since(now, downAt_) >= HOLD_MS) {
      fired_ = true;
      return true;
    }
    return false;
  }

 private:
  bool down_ = false;
  bool fired_ = false;
  Millis downAt_ = 0;
};

/** Collects serial characters into lines, with CR, LF or both as the end. Overlong lines are dropped whole. */
class LineReader {
 public:
  static constexpr size_t MAX = 48;

  /** Feeds one character; true when it ended a non-empty line, which `line()` then holds. */
  bool feed(char c) {
    if (c == '\r' || c == '\n') {
      const bool complete = length_ > 0 && !overflow_;
      buffer_[complete ? length_ : 0] = '\0';
      length_ = 0;
      overflow_ = false;
      return complete;
    }
    if (length_ + 1 >= MAX) {
      overflow_ = true;
      return false;
    }
    buffer_[length_++] = c;
    return false;
  }

  const char* line() const { return buffer_; }

 private:
  char buffer_[MAX] = "";
  size_t length_ = 0;
  bool overflow_ = false;
};

enum class Command : uint8_t { Unknown, Status, Config, Reset, Factory, Help, BuzzerOn, BuzzerOff };

/** A console line as a command: case doesn't matter, surrounding spaces don't either. */
inline Command parseCommand(const char* line) {
  char word[24];
  size_t length = 0;
  while (*line == ' ' || *line == '\t') ++line;
  for (; *line && length + 1 < sizeof word; ++line) {
    char c = *line;
    if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    if (c == '\t') c = ' ';
    word[length++] = c;
  }
  while (length > 0 && word[length - 1] == ' ') --length;
  word[length] = '\0';
  struct Name {
    const char* text;
    Command command;
  };
  static constexpr Name NAMES[] = {
      {"STATUS", Command::Status}, {"CONFIG", Command::Config},       {"RESET", Command::Reset},
      {"FACTORY", Command::Factory}, {"HELP", Command::Help},         {"BUZZER ON", Command::BuzzerOn},
      {"BUZZER OFF", Command::BuzzerOff},
  };
  for (const Name& name : NAMES) {
    const char* a = name.text;
    const char* b = word;
    while (*a && *a == *b) {
      ++a;
      ++b;
    }
    if (*a == '\0' && *b == '\0') return name.command;
  }
  return Command::Unknown;
}

/** A destructive command runs only when repeated within `WINDOW_MS`. */
class Confirmation {
 public:
  static constexpr Millis WINDOW_MS = 5000;

  /** True when this is the repeat; otherwise it arms the window and returns false. */
  bool ask(Millis now) {
    if (armed_ && since(now, armedAt_) <= WINDOW_MS) {
      armed_ = false;
      return true;
    }
    armed_ = true;
    armedAt_ = now;
    return false;
  }

  void cancel() { armed_ = false; }

 private:
  bool armed_ = false;
  Millis armedAt_ = 0;
};

}  // namespace cp
