// Reading the hub's answer body (core/http_body.h): plain or chunked, never more than the player keeps, and never
// past the point where the byte source says there is no more (DESIGN.md "Player", Delivery).
#include "../src/core/http_body.h"
#include "../src/core/protocol.h"

#include <string>

#include "check.h"

using namespace cp;

namespace {

/** Bytes as they come off a socket; -1 after the last (the hub closed it, or the time for the body ran out). */
struct Source {
  std::string bytes;
  size_t at = 0;
  int operator()() { return at < bytes.size() ? static_cast<unsigned char>(bytes[at++]) : -1; }
};

std::string plain(const std::string& bytes, int size, size_t cap = ANSWER_MAX) {
  Source source{bytes};
  char out[ANSWER_MAX + 1];
  return std::string(out, readPlainBody(source, size, out, cap));
}

std::string chunked(const std::string& bytes, size_t cap = ANSWER_MAX) {
  Source source{bytes};
  char out[ANSWER_MAX + 1];
  return std::string(out, readChunkedBody(source, out, cap));
}

const char* const REPLY = R"({"ok":true,"v":2,"seq":1,"result":"started","cue":"ok","heartbeat_s":30,"activity":"Deep work"})";

}  // namespace

int main() {
  check::run("a body with a length is read to that length; without one, until the hub closes", [] {
    CHECK(plain(std::string(REPLY) + "more on the same connection", static_cast<int>(std::strlen(REPLY))) == REPLY);
    CHECK(plain(REPLY, -1) == REPLY);
    CHECK(plain("", 0).empty());
  });

  check::run("a body that stops early gives what arrived, which then fails to parse as a reply", [] {
    const std::string cut = plain(std::string(REPLY).substr(0, 40), static_cast<int>(std::strlen(REPLY)));
    CHECK(cut.size() == 40);
    Answer answer;
    CHECK(!readAnswer(cut.data(), cut.size(), answer));
  });

  check::run("at most 512 bytes are kept, whatever length the hub claims or sends", [] {
    const std::string big(2000, 'x');
    CHECK(plain(big, 2000).size() == ANSWER_MAX);
    CHECK(plain(big, -1).size() == ANSWER_MAX);
    CHECK(chunked("7D0\r\n" + big + "\r\n0\r\n\r\n").size() == ANSWER_MAX);
    CHECK(chunked("FFFFFFFFFFFFFFFFFFFF\r\n" + big).size() == ANSWER_MAX);
    CHECK(plain(big, 2000, 8).size() == 8);
  });

  check::run("a chunked body is put back together: several chunks, either hex case, extensions ignored", [] {
    const std::string reply = REPLY;
    const std::string first = reply.substr(0, 26);
    const std::string second = reply.substr(26, 11);
    const std::string third = reply.substr(37);
    char size[8];
    std::snprintf(size, sizeof size, "%zx", third.size());
    const std::string body = "1A\r\n" + first + "\r\nb;name=value\r\n" + second + "\r\n" + size + "\r\n" + third +
                             "\r\n0\r\n\r\n";
    CHECK(chunked(body) == reply);
    Answer answer;
    const std::string read = chunked(body);
    CHECK(readAnswer(read.data(), read.size(), answer) && answer.cue == Cue::Ok);
    // Bare line feeds, as a careless proxy sends them.
    CHECK(chunked("5\nhello\n0\n\n") == "hello");
  });

  check::run("a chunked body that stalls or breaks its framing ends where it broke", [] {
    CHECK(chunked("5\r\nhel") == "hel");
    CHECK(chunked("5\r\nhello\r\n") == "hello");
    CHECK(chunked("5\r\nhelloXX3\r\nabc\r\n0\r\n\r\n") == "hello");
    CHECK(chunked("").empty());
    CHECK(chunked("\r\n").empty());
    CHECK(chunked("zz\r\nhello").empty());
  });

  return check::result();
}
