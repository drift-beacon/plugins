// The player: wires the pure core (src/core) to the hardware adapters (src/hal). player.ino only calls these two.
#pragma once

namespace cp::app {

void setup();
/** One pass: never waits on the network, the reader or the console, so a cartridge is read every ~50 ms. */
void loop();

}  // namespace cp::app
