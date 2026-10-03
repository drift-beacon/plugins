// The buzzer, the LED and the BOOT button: the only things on the board a person touches or hears.
#pragma once

#include "../core/indicator.h"

namespace cp::feedback {

void begin();
/** Drives the outputs; writes to the LED only when its colour changes. */
void show(const Output& output);
bool bootPressed();

}  // namespace cp::feedback
