// The body of an HTTP answer, taken a byte at a time from whatever delivers it. The caller's byte source decides when
// there is no more (the hub closed the connection, or the time allowed for the body ran out), so a hub or proxy
// that stalls or trickles can't hold the reader: it gets what arrived, and a body cut short fails to parse.
#pragma once

#include <cstddef>

namespace cp {

namespace http_body {

inline int hexDigit(int byte) {
  if (byte >= '0' && byte <= '9') return byte - '0';
  if (byte >= 'a' && byte <= 'f') return byte - 'a' + 10;
  if (byte >= 'A' && byte <= 'F') return byte - 'A' + 10;
  return -1;
}

}  // namespace http_body

/**
 * A body sent as it is: `size` bytes when the hub gave a Content-Length, or everything until it closes the
 * connection when it didn't (`size` negative). `next()` returns the next byte, or a negative number when there is
 * no more. Keeps at most `cap` bytes and returns how many.
 */
template <class Next>
size_t readPlainBody(Next&& next, int size, char* out, size_t cap) {
  const size_t wanted = size < 0 || static_cast<size_t>(size) > cap ? cap : static_cast<size_t>(size);
  size_t length = 0;
  while (length < wanted) {
    const int byte = next();
    if (byte < 0) break;
    out[length++] = static_cast<char>(byte);
  }
  return length;
}

/**
 * A chunked body (Transfer-Encoding: chunked): a hex length line, that many bytes and a line end, repeated until a
 * length of zero. Keeps at most `cap` bytes and stops there.
 */
template <class Next>
size_t readChunkedBody(Next&& next, char* out, size_t cap) {
  size_t length = 0;
  for (;;) {
    size_t chunk = 0;
    bool sized = false;
    for (;;) {
      const int byte = next();
      if (byte < 0) return length;
      if (byte == '\n') break;
      const int digit = sized ? -1 : http_body::hexDigit(byte);
      if (digit >= 0) {
        chunk = chunk * 16 + static_cast<size_t>(digit);
        // More than is ever kept: stop counting before the number can overflow.
        if (chunk > cap) chunk = cap + 1;
      } else if (byte != '\r') {
        // A chunk extension: the digits before it are the length.
        sized = true;
      }
    }
    if (chunk == 0) return length;
    for (size_t i = 0; i < chunk; ++i) {
      const int byte = next();
      if (byte < 0 || length == cap) return length;
      out[length++] = static_cast<char>(byte);
    }
    int end = next();
    if (end == '\r') end = next();
    if (end != '\n') return length;
  }
}

}  // namespace cp
