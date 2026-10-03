// Just enough JSON for the player: a writer that escapes into a caller's buffer, and a validating reader for the small
// flat objects it receives (the hub's replies, probe answers, setup codes). No heap, no library: replies are under
// 512 bytes, and a full JSON library would cost more flash than the rest of the protocol together.
#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>

namespace cp {

/** Builds a JSON document in a fixed buffer. Anything that doesn't fit makes `finish()` return 0, never a cut body. */
class JsonWriter {
 public:
  JsonWriter(char* out, size_t cap) : out_(out), cap_(cap) {
    if (cap_ > 0) out_[0] = '\0';
  }

  JsonWriter& open() { return enter('{'); }
  JsonWriter& close() { return leave('}'); }
  JsonWriter& openArray() { return enter('['); }
  JsonWriter& closeArray() { return leave(']'); }

  JsonWriter& key(const char* name) {
    separate();
    quoted(name, std::strlen(name));
    put(':');
    afterKey_ = true;
    return *this;
  }

  JsonWriter& string(const char* text) { return string(text, std::strlen(text)); }
  JsonWriter& string(const char* text, size_t length) {
    separate();
    quoted(text, length);
    return *this;
  }
  /** A string, or null when it's empty: "nothing saved" reads better as null than as "". */
  JsonWriter& stringOrNull(const char* text) { return text[0] ? string(text) : null(); }

  JsonWriter& number(int64_t value) {
    separate();
    char digits[24];
    size_t count = 0;
    const bool negative = value < 0;
    uint64_t magnitude = negative ? 0u - static_cast<uint64_t>(value) : static_cast<uint64_t>(value);
    do {
      digits[count++] = static_cast<char>('0' + magnitude % 10);
      magnitude /= 10;
    } while (magnitude > 0);
    if (negative) put('-');
    while (count > 0) put(digits[--count]);
    return *this;
  }

  JsonWriter& boolean(bool value) {
    separate();
    raw(value ? "true" : "false");
    return *this;
  }

  JsonWriter& null() {
    separate();
    raw("null");
    return *this;
  }

  /** The document's length, or 0 when it overflowed or isn't closed. */
  size_t finish() const { return overflow_ || depth_ != 0 ? 0 : length_; }

 private:
  static constexpr int MAX_DEPTH = 8;

  JsonWriter& enter(char bracket) {
    separate();
    put(bracket);
    if (depth_ < MAX_DEPTH) {
      first_[depth_++] = true;
    } else {
      overflow_ = true;
    }
    return *this;
  }

  JsonWriter& leave(char bracket) {
    if (depth_ == 0) {
      overflow_ = true;
    } else {
      --depth_;
    }
    put(bracket);
    return *this;
  }

  void separate() {
    if (afterKey_) {
      afterKey_ = false;
      return;
    }
    if (depth_ == 0) return;
    if (first_[depth_ - 1]) {
      first_[depth_ - 1] = false;
    } else {
      put(',');
    }
  }

  void quoted(const char* text, size_t length) {
    static const char DIGITS[] = "0123456789abcdef";
    put('"');
    for (size_t i = 0; i < length; ++i) {
      const unsigned char c = static_cast<unsigned char>(text[i]);
      switch (c) {
        case '"': raw("\\\""); break;
        case '\\': raw("\\\\"); break;
        case '\n': raw("\\n"); break;
        case '\r': raw("\\r"); break;
        case '\t': raw("\\t"); break;
        default:
          if (c < 0x20 || c == 0x7F) {
            raw("\\u00");
            put(DIGITS[c >> 4]);
            put(DIGITS[c & 0x0F]);
          } else {
            put(static_cast<char>(c));
          }
      }
    }
    put('"');
  }

  void raw(const char* text) {
    while (*text) put(*text++);
  }

  void put(char c) {
    if (length_ + 1 >= cap_) {
      overflow_ = true;
      return;
    }
    out_[length_++] = c;
    out_[length_] = '\0';
  }

  char* out_;
  size_t cap_;
  size_t length_ = 0;
  bool overflow_ = false;
  bool afterKey_ = false;
  bool first_[MAX_DEPTH] = {};
  int depth_ = 0;
};

/** One value inside a document being read: where its text is, and what kind it is. */
struct JsonValue {
  enum class Type : uint8_t { String, Number, True, False, Null, Object, Array };
  Type type;
  const char* raw;
  size_t length;
};

namespace json {

/** Nesting deeper than this is refused: nothing the player reads needs more than two levels. */
constexpr int MAX_DEPTH = 16;
/** Member names longer than this can't be ours; they are still checked, then ignored. */
constexpr size_t MAX_KEY = 32;

inline bool isSpace(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }
inline bool isDigit(char c) { return c >= '0' && c <= '9'; }

inline int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/** A strict JSON scanner over a byte range. Each step returns null on a syntax error. */
class Scanner {
 public:
  Scanner(const char* end) : end_(end) {}

  const char* space(const char* p) const {
    while (p < end_ && isSpace(*p)) ++p;
    return p;
  }

  /** Past the closing quote of the string starting at `p`. Raw control characters are an error, as in JSON.parse. */
  const char* string(const char* p) const {
    if (p >= end_ || *p != '"') return nullptr;
    ++p;
    while (p < end_) {
      const unsigned char c = static_cast<unsigned char>(*p);
      if (c == '"') return p + 1;
      if (c < 0x20) return nullptr;
      if (c == '\\') {
        if (++p >= end_) return nullptr;
        switch (*p) {
          case '"': case '\\': case '/': case 'b': case 'f': case 'n': case 'r': case 't': ++p; break;
          case 'u':
            if (end_ - p < 5) return nullptr;
            for (int i = 1; i <= 4; ++i) {
              if (hexValue(p[i]) < 0) return nullptr;
            }
            p += 5;
            break;
          default: return nullptr;
        }
      } else {
        ++p;
      }
    }
    return nullptr;
  }

  const char* number(const char* p) const {
    if (p < end_ && *p == '-') ++p;
    if (p >= end_) return nullptr;
    if (*p == '0') {
      ++p;
    } else if (isDigit(*p)) {
      while (p < end_ && isDigit(*p)) ++p;
    } else {
      return nullptr;
    }
    if (p < end_ && *p == '.') {
      ++p;
      if (p >= end_ || !isDigit(*p)) return nullptr;
      while (p < end_ && isDigit(*p)) ++p;
    }
    if (p < end_ && (*p == 'e' || *p == 'E')) {
      ++p;
      if (p < end_ && (*p == '+' || *p == '-')) ++p;
      if (p >= end_ || !isDigit(*p)) return nullptr;
      while (p < end_ && isDigit(*p)) ++p;
    }
    return p;
  }

  const char* literal(const char* p, const char* word) const {
    const size_t length = std::strlen(word);
    if (static_cast<size_t>(end_ - p) < length || std::strncmp(p, word, length) != 0) return nullptr;
    return p + length;
  }

  /** Past the value starting at `p` (already past any space), filling `out`. */
  const char* value(const char* p, int depth, JsonValue& out) const {
    if (p >= end_) return nullptr;
    out.raw = p;
    const char* next = nullptr;
    switch (*p) {
      case '"': out.type = JsonValue::Type::String; next = string(p); break;
      case '{': out.type = JsonValue::Type::Object; next = container(p, depth, '}'); break;
      case '[': out.type = JsonValue::Type::Array; next = container(p, depth, ']'); break;
      case 't': out.type = JsonValue::Type::True; next = literal(p, "true"); break;
      case 'f': out.type = JsonValue::Type::False; next = literal(p, "false"); break;
      case 'n': out.type = JsonValue::Type::Null; next = literal(p, "null"); break;
      default: out.type = JsonValue::Type::Number; next = number(p);
    }
    if (next) out.length = static_cast<size_t>(next - p);
    return next;
  }

  /** Past a nested object or array, checking everything inside it. */
  const char* container(const char* p, int depth, char closing) const {
    if (depth >= MAX_DEPTH) return nullptr;
    p = space(p + 1);
    if (p < end_ && *p == closing) return p + 1;
    while (p < end_) {
      if (closing == '}') {
        p = string(p);
        if (!p) return nullptr;
        p = space(p);
        if (p >= end_ || *p != ':') return nullptr;
        p = space(p + 1);
      }
      JsonValue ignored;
      p = value(p, depth + 1, ignored);
      if (!p) return nullptr;
      p = space(p);
      if (p >= end_) return nullptr;
      if (*p == closing) return p + 1;
      if (*p != ',') return nullptr;
      p = space(p + 1);
    }
    return nullptr;
  }

 private:
  const char* end_;
};

inline void putBytes(const char* bytes, size_t count, char* out, size_t cap, size_t& at, bool& complete) {
  if (!complete || at + count >= cap) {
    complete = false;
    return;
  }
  for (size_t i = 0; i < count; ++i) out[at++] = bytes[i];
}

inline void putUtf8(uint32_t code, char* out, size_t cap, size_t& at, bool& complete) {
  char bytes[4];
  size_t count;
  if (code < 0x80) {
    bytes[0] = static_cast<char>(code);
    count = 1;
  } else if (code < 0x800) {
    bytes[0] = static_cast<char>(0xC0 | (code >> 6));
    bytes[1] = static_cast<char>(0x80 | (code & 0x3F));
    count = 2;
  } else if (code < 0x10000) {
    bytes[0] = static_cast<char>(0xE0 | (code >> 12));
    bytes[1] = static_cast<char>(0x80 | ((code >> 6) & 0x3F));
    bytes[2] = static_cast<char>(0x80 | (code & 0x3F));
    count = 3;
  } else {
    bytes[0] = static_cast<char>(0xF0 | (code >> 18));
    bytes[1] = static_cast<char>(0x80 | ((code >> 12) & 0x3F));
    bytes[2] = static_cast<char>(0x80 | ((code >> 6) & 0x3F));
    bytes[3] = static_cast<char>(0x80 | (code & 0x3F));
    count = 4;
  }
  putBytes(bytes, count, out, cap, at, complete);
}

inline uint32_t hex4(const char* p) {
  return static_cast<uint32_t>(hexValue(p[0]) << 12 | hexValue(p[1]) << 8 | hexValue(p[2]) << 4 | hexValue(p[3]));
}

/**
 * The text of a string value, unescaped, into `out` (always terminated). Returns false when it didn't fit (or held
 * U+0000): what fits is kept, cut at a whole character, which is right for log lines and never matches a value the
 * player compares.
 */
inline bool decodeString(const JsonValue& value, char* out, size_t cap, size_t* written = nullptr) {
  if (cap == 0) return false;
  size_t at = 0;
  bool complete = value.type == JsonValue::Type::String;
  const char* p = value.raw + 1;
  const char* end = complete ? value.raw + value.length - 1 : p;
  while (p < end && complete) {
    if (*p != '\\') {
      putBytes(p++, 1, out, cap, at, complete);
      continue;
    }
    ++p;
    switch (*p) {
      case 'b': putUtf8('\b', out, cap, at, complete); ++p; break;
      case 'f': putUtf8('\f', out, cap, at, complete); ++p; break;
      case 'n': putUtf8('\n', out, cap, at, complete); ++p; break;
      case 'r': putUtf8('\r', out, cap, at, complete); ++p; break;
      case 't': putUtf8('\t', out, cap, at, complete); ++p; break;
      case 'u': {
        uint32_t code = hex4(p + 1);
        p += 5;
        if (code >= 0xD800 && code <= 0xDBFF && end - p >= 6 && p[0] == '\\' && p[1] == 'u') {
          const uint32_t low = hex4(p + 2);
          if (low >= 0xDC00 && low <= 0xDFFF) {
            code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
            p += 6;
          }
        }
        // A C string can't hold U+0000, and a value that needed one can't be one the player accepts.
        if (code == 0) complete = false;
        putUtf8(code, out, cap, at, complete);
        break;
      }
      default: putBytes(p++, 1, out, cap, at, complete);
    }
  }
  if (!complete) {
    // Don't leave half a UTF-8 character at the cut.
    size_t lead = at;
    while (lead > 0 && (static_cast<unsigned char>(out[lead - 1]) & 0xC0) == 0x80) --lead;
    if (lead > 0 && static_cast<unsigned char>(out[lead - 1]) >= 0xC0) {
      const unsigned char first = static_cast<unsigned char>(out[--lead]);
      const size_t needed = first >= 0xF0 ? 4 : first >= 0xE0 ? 3 : 2;
      if (at - lead < needed) at = lead;
    }
  }
  out[at] = '\0';
  if (written) *written = at;
  return complete;
}

/** A number value as a double. The scanner has already checked its syntax, and a delimiter always follows it. */
inline bool toNumber(const JsonValue& value, double& out) {
  if (value.type != JsonValue::Type::Number) return false;
  out = std::strtod(value.raw, nullptr);
  return true;
}

/** A whole number from 0 to 2^32-1 (9001.0 counts, as with Number.isInteger). */
inline bool toU32(const JsonValue& value, uint32_t& out) {
  double number;
  if (!toNumber(value, number) || !std::isfinite(number) || std::floor(number) != number) return false;
  if (number < 0 || number > 4294967295.0) return false;
  out = static_cast<uint32_t>(number);
  return true;
}

/**
 * Reads a whole document whose top level is an object, calling `visit(key, value)` for each member in order (so a
 * repeated name ends with its last value, as in JSON.parse). `key` is null for names longer than MAX_KEY. Returns
 * false on any syntax error, trailing text, or a top level that isn't an object.
 */
template <class Visit>
bool readObject(const char* text, size_t length, Visit&& visit) {
  const char* end = text + length;
  Scanner scan(end);
  const char* p = scan.space(text);
  if (p >= end || *p != '{') return false;
  // Check the whole document first, so nothing is visited from a body that turns out to be broken.
  const char* last = scan.container(p, 0, '}');
  if (!last || scan.space(last) != end) return false;
  p = scan.space(p + 1);
  if (*p == '}') return true;
  for (;;) {
    JsonValue name;
    name.type = JsonValue::Type::String;
    name.raw = p;
    const char* afterName = scan.string(p);
    name.length = static_cast<size_t>(afterName - p);
    char key[MAX_KEY + 1];
    const bool fits = decodeString(name, key, sizeof key);
    p = scan.space(scan.space(afterName) + 1);
    JsonValue value;
    p = scan.space(scan.value(p, 1, value));
    visit(fits ? key : nullptr, value);
    if (*p == '}') return true;
    p = scan.space(p + 1);
  }
}

}  // namespace json
}  // namespace cp
