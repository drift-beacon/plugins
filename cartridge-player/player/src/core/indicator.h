// The buzzer and the on-board LED, as a function of time: a cue (the plugin's answer to a report) plays over an
// ambient light that says what the player is doing (DESIGN.md "Player", Feedback). Nothing here waits, so the loop
// keeps polling the reader while a beep plays.
//
// The ambient light says one of two kinds of thing. What the cartridge in the slot is doing is shown the way the
// interface draws its replica of the player (ui/src/components/scene/Led.tsx): fast blue blink while reading,
// breathing green while tracking, steady green once marked, slow amber blink for an unlabelled cartridge, slow red
// blink for one that went wrong, and no colour for an empty slot (tests/firmware.test.mjs compares the two). What
// the player itself is doing (setup, no network, a refusing hub, a dead reader) never looks like any of those: each
// differs from every cartridge light in hue or in pattern, and player/tests/test_indicator.cpp holds that.
#pragma once

#include <cstdint>

#include "clock.h"
#include "protocol.h"
#include "reporter.h"

namespace cp {

struct Rgb {
  uint8_t r;
  uint8_t g;
  uint8_t b;
};

inline bool operator==(const Rgb& a, const Rgb& b) { return a.r == b.r && a.g == b.g && a.b == b.b; }
inline bool operator!=(const Rgb& a, const Rgb& b) { return !(a == b); }

/** What the buzzer and the LED should be doing right now. */
struct Output {
  bool buzzer;
  Rgb led;
};

/** The light between cues, most important first: the player's own states, then the cartridge's. */
enum class Ambient : uint8_t {
  Setup,        // breathing blue: the setup network is open
  ReaderFault,  // red and blue in turn: the reader isn't answering
  Reading,      // fast blue blink: a new cartridge's report is unanswered
  Refused,      // steady red: the hub refuses the key, the path, or the report
  Connecting,   // slow violet pulse: joining Wi-Fi, or the hub can't be reached
  Tracking,     // breathing green: the hub said `ok` to the cartridge in the slot, and its session runs
  Marked,       // steady green: the hub said `ok` and marked a point; nothing runs
  Unlabelled,   // slow amber blink: the hub said `unknown` to it
  Failed,       // slow red blink: the hub said `error` to it
  Idle,         // faint white: online, nothing to show (an empty slot)
};

/** What the light depends on. */
struct AmbientInputs {
  bool inSetup;
  bool readerFault;
  bool reading;
  bool stationUp;
  HubState hub;
  Standing standing;
};

inline Ambient ambientFor(const AmbientInputs& in) {
  if (in.inSetup) return Ambient::Setup;
  if (in.readerFault) return Ambient::ReaderFault;
  if (in.reading) return Ambient::Reading;
  if (!in.stationUp) return Ambient::Connecting;
  switch (in.hub) {
    case HubState::KeyRejected:
    case HubState::NotFound:
    case HubState::BadRequest:
      return Ambient::Refused;
    case HubState::Unknown:
    case HubState::Unreachable:
      return Ambient::Connecting;
    case HubState::Ok:
      break;
  }
  // Only with the hub answering is its last word about the cartridge worth showing: a player that can't reach it
  // says so first, since nothing done with the cartridge is heard until it can.
  switch (in.standing) {
    case Standing::Tracking: return Ambient::Tracking;
    case Standing::Marked: return Ambient::Marked;
    case Standing::Unknown: return Ambient::Unlabelled;
    case Standing::Error: return Ambient::Failed;
    case Standing::None: break;
  }
  return Ambient::Idle;
}

class Indicator {
 public:
  struct Step {
    uint16_t ms;
    bool buzzer;
    Rgb led;
  };

  static constexpr Rgb OFF = {0, 0, 0};
  static constexpr Rgb GREEN = {0, 48, 8};
  static constexpr Rgb SOFT_WHITE = {14, 14, 12};
  static constexpr Rgb AMBER = {45, 20, 0};
  static constexpr Rgb RED = {56, 0, 0};
  static constexpr Rgb BLUE = {0, 0, 64};
  /** The player's own colour for "no network": no cartridge light and no cue has it. */
  static constexpr Rgb VIOLET = {32, 0, 44};
  /** Enough to read as powered, with no colour to mean anything: green is for a cartridge that is tracking. */
  static constexpr Rgb FAINT_WHITE = {4, 4, 3};

  /** The replica's loops (ui/src/components/deck.css): `cp-blink` for reading, the slow one, and `cp-breathe`. */
  static constexpr Millis FAST_BLINK_MS = 420;
  static constexpr Millis SLOW_BLINK_MS = 1100;
  static constexpr Millis BREATHE_MS = 2400;

  /** Starts a cue, replacing one still playing. `None` leaves things as they are. */
  void play(Cue cue, Millis now) {
    // The buzzer is active (a fixed tone), so cues differ in length and rhythm rather than pitch.
    static constexpr Step CHIRP[] = {{80, true, GREEN}, {220, false, GREEN}};
    static constexpr Step TICK[] = {{15, true, SOFT_WHITE}, {285, false, SOFT_WHITE}};
    static constexpr Step DOUBLE_BEEP[] = {{50, true, AMBER}, {80, false, OFF}, {50, true, AMBER}, {270, false, AMBER}};
    static constexpr Step LONG_BEEP[] = {{600, true, RED}, {250, false, RED}};
    switch (cue) {
      case Cue::None: return;
      case Cue::Ok: start(CHIRP, 2, now); return;
      case Cue::Bye: start(TICK, 2, now); return;
      case Cue::Unknown: start(DOUBLE_BEEP, 4, now); return;
      case Cue::Error: start(LONG_BEEP, 2, now); return;
    }
  }

  bool playing() const { return steps_ != nullptr; }

  Output frame(Ambient ambient, bool buzzerEnabled, Millis now) {
    if (steps_) {
      Millis elapsed = since(now, startedAt_);
      for (uint8_t i = 0; i < count_; ++i) {
        if (elapsed < steps_[i].ms) return {buzzerEnabled && steps_[i].buzzer, steps_[i].led};
        elapsed -= steps_[i].ms;
      }
      steps_ = nullptr;
    }
    return {false, ambientLight(ambient, now)};
  }

  static Rgb ambientLight(Ambient ambient, Millis now) {
    switch (ambient) {
      case Ambient::Setup: {
        const uint32_t level = 6 + wave(now, 3000) * 50 / 255;
        return {0, 0, static_cast<uint8_t>(level)};
      }
      // Two colours in turn: no cartridge light has more than one, so a dead reader is never taken for a cartridge
      // that went wrong (red) or one being read (blue).
      case Ambient::ReaderFault: return now % 400 < 200 ? RED : BLUE;
      case Ambient::Reading: return blink(BLUE, now, FAST_BLINK_MS);
      case Ambient::Refused: return RED;
      case Ambient::Connecting: return dimmed(VIOLET, 20 + wave(now, 2000) * 235 / 255);
      // Between 45% and full, as the replica breathes.
      case Ambient::Tracking: return dimmed(GREEN, 115 + wave(now, BREATHE_MS) * 140 / 255);
      case Ambient::Marked: return GREEN;
      case Ambient::Unlabelled: return blink(AMBER, now, SLOW_BLINK_MS);
      case Ambient::Failed: return blink(RED, now, SLOW_BLINK_MS);
      case Ambient::Idle: return FAINT_WHITE;
    }
    return OFF;
  }

 private:
  /** A triangle wave from 0 to 255 and back over `period` ms. */
  static uint32_t wave(Millis now, Millis period) {
    const Millis half = period / 2;
    const Millis at = now % period;
    return at < half ? at * 255 / half : (period - at) * 255 / half;
  }

  /** A colour at `level` out of 255. */
  static Rgb dimmed(const Rgb& colour, uint32_t level) {
    return {static_cast<uint8_t>(colour.r * level / 255), static_cast<uint8_t>(colour.g * level / 255),
            static_cast<uint8_t>(colour.b * level / 255)};
  }

  /** Half the period lit, half at a fifth: the replica's blink dims rather than goes dark, so it still reads as on. */
  static Rgb blink(const Rgb& colour, Millis now, Millis period) {
    return now % period < period / 2 ? colour : dimmed(colour, 51);
  }

  void start(const Step* steps, uint8_t count, Millis now) {
    steps_ = steps;
    count_ = count;
    startedAt_ = now;
  }

  const Step* steps_ = nullptr;
  uint8_t count_ = 0;
  Millis startedAt_ = 0;
};

}  // namespace cp
