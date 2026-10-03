// One line per event on the serial console. Nothing secret is ever passed here: the API key and the Wi-Fi password
// only ever appear as "set" or "not set".
#pragma once

namespace cp {

void logf(const char* format, ...) __attribute__((format(printf, 1, 2)));

}  // namespace cp
