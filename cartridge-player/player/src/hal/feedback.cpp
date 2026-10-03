#include "feedback.h"

#include <Arduino.h>

#include "pins.h"

namespace cp::feedback {
namespace {

bool buzzerOn = false;
Rgb shown = {0, 0, 0};
bool ledKnown = false;

}  // namespace

void begin() {
  pinMode(pins::BUZZER, OUTPUT);
  digitalWrite(pins::BUZZER, LOW);
  pinMode(pins::BOOT_BUTTON, INPUT_PULLUP);
}

void show(const Output& output) {
  if (output.buzzer != buzzerOn) {
    buzzerOn = output.buzzer;
    digitalWrite(pins::BUZZER, buzzerOn ? HIGH : LOW);
  }
  if (!ledKnown || output.led != shown) {
    ledKnown = true;
    shown = output.led;
    rgbLedWrite(pins::LED, shown.r, shown.g, shown.b);
  }
}

bool bootPressed() { return digitalRead(pins::BOOT_BUTTON) == LOW; }

}  // namespace cp::feedback
