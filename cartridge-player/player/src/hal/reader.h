// The MFRC522 behind one call: what is on the antenna now. A missing or browned-out reader is reported as a fault
// (never as "no cartridge") and set up again with backoff, so a loose wire can't end a session or stop the player.
#pragma once

#include <cstdint>

#include "../core/clock.h"
#include "../core/tag_tracker.h"
#include "../core/uid.h"

namespace cp::reader {

void begin(Millis now);
/** One poll: WUPA, select and HALT, so a cartridge answers every poll and presence is never a guess. */
Read poll(Uid& uid, Millis now);
/** The chip's version register when it last answered (0x91/0x92 for genuine chips, others for clones). */
uint8_t version();

}  // namespace cp::reader
