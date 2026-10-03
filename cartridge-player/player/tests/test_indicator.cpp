// What the player's light and buzzer say (DESIGN.md "Player", Feedback; README.md, "What the light and sounds mean").
#include "../src/core/indicator.h"

#include "check.h"

using namespace cp;

namespace {

AmbientInputs online() { return {false, false, false, true, HubState::Ok, Standing::None}; }

/** The colours a light can be told apart by: which of the LED's three are lit. */
enum Hue : unsigned { RED = 1, GREEN = 2, BLUE = 4, AMBER = 8, VIOLET = 16, WHITE = 32 };

unsigned hueOf(const Rgb& light) {
  if (light.r && light.g && light.b) return WHITE;
  if (light.r && light.b) return VIOLET;
  if (light.r && light.g) return AMBER;
  if (light.r) return RED;
  if (light.g) return GREEN;
  return light.b ? BLUE : 0;
}

/** How a light moves: not at all, smoothly (breathing), or in steps (blinking). */
enum class Motion { Steady, Breathing, Blinking };

struct Look {
  unsigned hues;
  Motion motion;
  bool dark;
};

bool operator==(const Look& a, const Look& b) { return a.hues == b.hues && a.motion == b.motion; }

int step(uint8_t a, uint8_t b) { return a > b ? a - b : b - a; }

/** What an ambient light looks like over ten seconds, millisecond by millisecond. */
Look lookOf(Ambient ambient) {
  Look look = {0, Motion::Steady, false};
  Rgb last = Indicator::ambientLight(ambient, 0);
  for (Millis t = 0; t < 10000; ++t) {
    const Rgb light = Indicator::ambientLight(ambient, t);
    look.hues |= hueOf(light);
    if (light == Indicator::OFF) look.dark = true;
    const int jump = step(light.r, last.r) + step(light.g, last.g) + step(light.b, last.b);
    if (jump > 3) {
      look.motion = Motion::Blinking;
    } else if (jump > 0 && look.motion == Motion::Steady) {
      look.motion = Motion::Breathing;
    }
    last = light;
  }
  return look;
}

/** How long a blinking light stays as it is, in milliseconds (0 when it never changes). */
Millis holdOf(Ambient ambient) {
  const Rgb first = Indicator::ambientLight(ambient, 0);
  for (Millis t = 1; t < 10000; ++t) {
    if (Indicator::ambientLight(ambient, t) != first) return t;
  }
  return 0;
}

const Ambient CARTRIDGE[] = {Ambient::Reading,    Ambient::Tracking, Ambient::Marked,
                             Ambient::Unlabelled, Ambient::Failed,   Ambient::Idle};
const Ambient PLAYER[] = {Ambient::Setup, Ambient::ReaderFault, Ambient::Refused, Ambient::Connecting};

/** Milliseconds the buzzer sounds during a cue, sampled every millisecond. */
int buzzing(Cue cue, bool enabled) {
  Indicator indicator;
  indicator.play(cue, 1000);
  int on = 0;
  for (Millis t = 1000; t < 3000; ++t) on += indicator.frame(Ambient::Idle, enabled, t).buzzer;
  return on;
}

}  // namespace

int main() {
  check::run("the player's own state comes first: setup, reader fault, reading, no Wi-Fi, hub refusing, hub away", [] {
    AmbientInputs in = online();
    CHECK(ambientFor(in) == Ambient::Idle);
    in.hub = HubState::Unreachable;
    CHECK(ambientFor(in) == Ambient::Connecting);
    in.hub = HubState::KeyRejected;
    CHECK(ambientFor(in) == Ambient::Refused);
    in.hub = HubState::NotFound;
    CHECK(ambientFor(in) == Ambient::Refused);
    in.hub = HubState::BadRequest;
    CHECK(ambientFor(in) == Ambient::Refused);
    in.stationUp = false;
    CHECK(ambientFor(in) == Ambient::Connecting);
    in.reading = true;
    CHECK(ambientFor(in) == Ambient::Reading);
    in.readerFault = true;
    CHECK(ambientFor(in) == Ambient::ReaderFault);
    in.inSetup = true;
    CHECK(ambientFor(in) == Ambient::Setup);
  });

  check::run("a hub that hasn't answered yet is shown as away, never as a healthy player", [] {
    AmbientInputs in = online();
    in.hub = HubState::Unknown;
    CHECK(ambientFor(in) == Ambient::Connecting);
  });

  check::run("with the hub answering, the light is the cartridge's: tracking, marked, unlabelled, failed, or none", [] {
    AmbientInputs in = online();
    in.standing = Standing::Tracking;
    CHECK(ambientFor(in) == Ambient::Tracking);
    in.standing = Standing::Marked;
    CHECK(ambientFor(in) == Ambient::Marked);
    in.standing = Standing::Unknown;
    CHECK(ambientFor(in) == Ambient::Unlabelled);
    in.standing = Standing::Error;
    CHECK(ambientFor(in) == Ambient::Failed);
    in.standing = Standing::None;
    CHECK(ambientFor(in) == Ambient::Idle);
  });

  check::run("a cartridge's light never covers a problem of the player's own", [] {
    // Green over a hub that can't be reached would promise that pulling the cartridge out ends its session now.
    const Standing standings[] = {Standing::Tracking, Standing::Marked, Standing::Unknown, Standing::Error};
    for (Standing standing : standings) {
      AmbientInputs in = online();
      in.standing = standing;
      in.hub = HubState::Unreachable;
      CHECK(ambientFor(in) == Ambient::Connecting);
      in.hub = HubState::KeyRejected;
      CHECK(ambientFor(in) == Ambient::Refused);
      in.hub = HubState::Ok;
      in.stationUp = false;
      CHECK(ambientFor(in) == Ambient::Connecting);
      in.stationUp = true;
      in.readerFault = true;
      CHECK(ambientFor(in) == Ambient::ReaderFault);
      in.readerFault = false;
      in.inSetup = true;
      CHECK(ambientFor(in) == Ambient::Setup);
    }
  });

  check::run("cues differ by rhythm: ok 80 ms, bye a 15 ms tick, unknown two beeps, error 600 ms", [] {
    CHECK(buzzing(Cue::Ok, true) == 80);
    CHECK(buzzing(Cue::Bye, true) == 15);
    CHECK(buzzing(Cue::Unknown, true) == 100);
    CHECK(buzzing(Cue::Error, true) == 600);
    CHECK(buzzing(Cue::None, true) == 0);
  });

  check::run("with the buzzer off, cues still light the LED", [] {
    CHECK(buzzing(Cue::Error, false) == 0);
    Indicator indicator;
    indicator.play(Cue::Error, 0);
    CHECK(indicator.frame(Ambient::Idle, false, 100).led == Indicator::RED);
  });

  check::run("after a cue the light goes back to what the player is doing", [] {
    Indicator indicator;
    indicator.play(Cue::Ok, 0);
    CHECK(indicator.frame(Ambient::Refused, true, 10).led == Indicator::GREEN);
    CHECK(indicator.frame(Ambient::Refused, true, 300).led == Indicator::RED);
    CHECK(!indicator.playing());
  });

  check::run("a new cue replaces one still playing", [] {
    Indicator indicator;
    indicator.play(Cue::Error, 0);
    indicator.play(Cue::Ok, 100);
    CHECK(indicator.frame(Ambient::Idle, true, 150).led == Indicator::GREEN);
  });

  check::run("the cartridge's lights are the replica's: fast blue blink, green breathing or still, slow amber and red", [] {
    // ui/src/components/scene/Led.tsx and deck.css: cp-blink 420 ms, the slow blink 1.1 s, cp-breathe 2.4 s.
    const Look reading = lookOf(Ambient::Reading);
    CHECK(reading.hues == BLUE && reading.motion == Motion::Blinking);
    CHECK(holdOf(Ambient::Reading) == 210);
    const Look tracking = lookOf(Ambient::Tracking);
    CHECK(tracking.hues == GREEN && tracking.motion == Motion::Breathing);
    CHECK(Indicator::ambientLight(Ambient::Tracking, 1200) == Indicator::GREEN);
    CHECK(Indicator::ambientLight(Ambient::Tracking, 0) == Indicator::ambientLight(Ambient::Tracking, 2400));
    // A point that was marked has nothing running: the same green, holding still.
    const Look marked = lookOf(Ambient::Marked);
    CHECK(marked.hues == GREEN && marked.motion == Motion::Steady);
    const Look unlabelled = lookOf(Ambient::Unlabelled);
    CHECK(unlabelled.hues == AMBER && unlabelled.motion == Motion::Blinking);
    CHECK(holdOf(Ambient::Unlabelled) == 550);
    const Look failed = lookOf(Ambient::Failed);
    CHECK(failed.hues == RED && failed.motion == Motion::Blinking);
    CHECK(holdOf(Ambient::Failed) == 550);
  });

  check::run("an empty slot is a faint white: lit, so the player reads as powered, and no colour that means anything", [] {
    const Look idle = lookOf(Ambient::Idle);
    CHECK(idle.hues == WHITE && idle.motion == Motion::Steady);
    const Rgb light = Indicator::ambientLight(Ambient::Idle, 0);
    CHECK(light.r > 0 && light.r < 8 && light.g < 8 && light.b < 8);
  });

  check::run("no light ever goes dark: a player that is on always shows it", [] {
    for (Ambient ambient : CARTRIDGE) CHECK(!lookOf(ambient).dark);
    for (Ambient ambient : PLAYER) CHECK(!lookOf(ambient).dark);
  });

  check::run("the player's own lights: setup breathes blue, no network pulses violet, a refusing hub is steady red", [] {
    const Look setup = lookOf(Ambient::Setup);
    CHECK(setup.hues == BLUE && setup.motion == Motion::Breathing);
    const Look connecting = lookOf(Ambient::Connecting);
    CHECK(connecting.hues == VIOLET && connecting.motion == Motion::Breathing);
    const Look refused = lookOf(Ambient::Refused);
    CHECK(refused.hues == RED && refused.motion == Motion::Steady);
    const Look fault = lookOf(Ambient::ReaderFault);
    CHECK(fault.hues == (RED | BLUE) && fault.motion == Motion::Blinking);
  });

  check::run("none of the player's own lights can be taken for a cartridge's: each differs in colour or in pattern", [] {
    for (Ambient own : PLAYER) {
      for (Ambient cartridge : CARTRIDGE) CHECK(!(lookOf(own) == lookOf(cartridge)));
    }
    // And each light of either kind says one thing only.
    const Ambient all[] = {Ambient::Reading, Ambient::Tracking, Ambient::Marked,      Ambient::Unlabelled,
                           Ambient::Failed,  Ambient::Idle,     Ambient::Setup,       Ambient::ReaderFault,
                           Ambient::Refused, Ambient::Connecting};
    for (Ambient a : all) {
      for (Ambient b : all) CHECK(a == b || !(lookOf(a) == lookOf(b)));
    }
  });

  check::run("the unknown cue is amber like the light that follows it; violet is kept for the network", [] {
    Indicator indicator;
    indicator.play(Cue::Unknown, 0);
    CHECK(hueOf(indicator.frame(Ambient::Unlabelled, true, 10).led) == AMBER);
    CHECK(hueOf(indicator.frame(Ambient::Unlabelled, true, 300).led) == AMBER);
    indicator.play(Cue::Ok, 1000);
    CHECK(hueOf(indicator.frame(Ambient::Tracking, true, 1010).led) == GREEN);
    indicator.play(Cue::Error, 2000);
    CHECK(hueOf(indicator.frame(Ambient::Failed, true, 2010).led) == RED);
  });

  return check::result();
}
