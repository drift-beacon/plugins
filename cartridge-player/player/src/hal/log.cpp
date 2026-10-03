#include "log.h"

#include <Arduino.h>

#include <cstdarg>
#include <cstdio>

namespace cp {

void logf(const char* format, ...) {
  char line[200];
  va_list args;
  va_start(args, format);
  std::vsnprintf(line, sizeof line, format, args);
  va_end(args);
  Serial.println(line);
}

}  // namespace cp
