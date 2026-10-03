#include "reader.h"

#include <Arduino.h>
#include <MFRC522.h>
#include <SPI.h>

#include <cstring>

#include "log.h"
#include "pins.h"

namespace cp::reader {
namespace {

MFRC522 chip(pins::READER_SS, MFRC522::UNUSED_PIN);

// The library's 25 ms receive timeout would make every empty poll block for 25 ms; a tag answers within about a
// millisecond, so 10 ms (400 ticks of 25 µs) is plenty and halves the time the loop spends in the reader.
constexpr uint8_t TIMER_RELOAD_HIGH = 0x01;
constexpr uint8_t TIMER_RELOAD_LOW = 0x90;
constexpr Millis FIRST_RETRY_MS = 1000;
constexpr Millis MAX_RETRY_MS = 30000;
/** A reader that has answered this long is taken as sound again: its next loss starts over at the first delay. */
constexpr Millis STEADY_MS = 10000;

bool working = false;
bool steady = false;
uint8_t lastVersion = 0;
Millis initAt = 0;
Millis workingSince = 0;
Millis retryDelay = FIRST_RETRY_MS;

/** A disconnected SPI bus reads back all zeros or all ones. */
bool answers(uint8_t value) { return value != 0x00 && value != 0xFF; }

bool setUp() {
  chip.PCD_Init();
  const uint8_t value = chip.PCD_ReadRegister(MFRC522::VersionReg);
  if (!answers(value)) return false;
  lastVersion = value;
  chip.PCD_WriteRegister(MFRC522::TReloadRegH, TIMER_RELOAD_HIGH);
  chip.PCD_WriteRegister(MFRC522::TReloadRegL, TIMER_RELOAD_LOW);
  return true;
}

/** When to try setting the reader up next. Each wait is twice the last, so a reader that keeps failing is left alone. */
void retryLater(Millis now) {
  initAt = now + retryDelay;
  retryDelay = retryDelay * 2 < MAX_RETRY_MS ? retryDelay * 2 : MAX_RETRY_MS;
}

void lost(Millis now, const char* why) {
  working = false;
  retryLater(now);
  logf("Reader: %s", why);
}

}  // namespace

void begin(Millis now) {
  SPI.begin(pins::READER_SCK, pins::READER_MISO, pins::READER_MOSI, pins::READER_SS);
  initAt = now;
}

Read poll(Uid& uid, Millis now) {
  if (!working) {
    if (!reached(now, initAt)) return Read::Fault;
    if (!setUp()) {
      if (retryDelay == FIRST_RETRY_MS) logf("Reader: not answering; check its wiring (trying again)");
      retryLater(now);
      return Read::Fault;
    }
    // The delay isn't reset here: a loose wire that lets every set-up through and fails the next read would then be
    // retried (with a log line and a 50 ms reset) every second for ever. It resets once the reader has held.
    working = true;
    steady = false;
    workingSince = now;
    logf("Reader: ready (MFRC522 version 0x%02X)", lastVersion);
  }
  if (!steady && since(now, workingSince) >= STEADY_MS) {
    steady = true;
    retryDelay = FIRST_RETRY_MS;
  }
  if (!answers(chip.PCD_ReadRegister(MFRC522::VersionReg))) {
    lost(now, "stopped answering");
    return Read::Fault;
  }
  if (chip.PCD_ReadRegister(MFRC522::TReloadRegL) != TIMER_RELOAD_LOW) {
    // A brown-out resets the chip to its defaults (antenna off) while it still answers. Checked on every poll: seen
    // any later, the silent antenna would already have read as "no cartridge" and ended the session. This poll
    // counts as a fault, which keeps the slot, and the next one reads again. A chip that resets again before it has
    // held for a while is a loss like any other, retried with backoff rather than set up on every poll.
    if (!steady) {
      lost(now, "keeps resetting itself; check its power");
    } else if (setUp()) {
      steady = false;
      workingSince = now;
      logf("Reader: reset itself; set up again");
    } else {
      lost(now, "reset itself and didn't come back");
    }
    return Read::Fault;
  }
  byte atqa[2];
  byte atqaSize = sizeof atqa;
  const MFRC522::StatusCode wake = chip.PICC_WakeupA(atqa, &atqaSize);
  if (wake != MFRC522::STATUS_OK && wake != MFRC522::STATUS_COLLISION) return Read::Absent;
  if (chip.PICC_Select(&chip.uid) != MFRC522::STATUS_OK) return Read::Absent;
  uid.size = chip.uid.size <= sizeof uid.bytes ? chip.uid.size : 0;
  std::memcpy(uid.bytes, chip.uid.uidByte, uid.size);
  chip.PICC_HaltA();
  return uid.size > 0 ? Read::Present : Read::Absent;
}

uint8_t version() { return lastVersion; }

}  // namespace cp::reader
