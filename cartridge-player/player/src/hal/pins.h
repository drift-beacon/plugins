// Wiring on the Waveshare ESP32-S3-Zero (README.md has the table). None of these is a strapping pin except BOOT,
// which is only read after start-up.
#pragma once

#include <cstdint>

namespace cp::pins {

constexpr int8_t READER_SCK = 12;
constexpr int8_t READER_MISO = 10;
constexpr int8_t READER_MOSI = 11;
constexpr int8_t READER_SS = 13;
/** Active buzzer: HIGH sounds it. */
constexpr uint8_t BUZZER = 2;
/** The on-board WS2812, driven through the core's rgbLedWrite. */
constexpr uint8_t LED = 21;
/** The BOOT button: LOW while pressed. */
constexpr uint8_t BOOT_BUTTON = 0;

}  // namespace cp::pins
