// The UID text is the key of every saved label: it must stay byte-identical.
#include "../src/core/uid.h"

#include "check.h"

using namespace cp;

int main() {
  check::run("UIDs format as upper-case hex pairs joined by ':', leading zeros kept", [] {
    char text[UID_TEXT_SIZE];
    const Uid four = {{0x04, 0xA1, 0x0B, 0xC3}, 4};
    CHECK(formatUid(four, text, sizeof text) == 11);
    CHECK_TEXT(text, "04:A1:0B:C3");
    const Uid seven = {{0x04, 0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6}, 7};
    formatUid(seven, text, sizeof text);
    CHECK_TEXT(text, "04:A1:B2:C3:D4:E5:F6");
    const Uid ten = {{0x00, 0x01, 0x0F, 0x10, 0x7F, 0x80, 0xAB, 0xCD, 0xEF, 0xFF}, 10};
    CHECK(formatUid(ten, text, sizeof text) == 29);
    CHECK_TEXT(text, "00:01:0F:10:7F:80:AB:CD:EF:FF");
  });

  check::run("a UID that doesn't fit is refused whole, never cut", [] {
    char small[11];
    const Uid four = {{0x04, 0xA1, 0x0B, 0xC3}, 4};
    CHECK(formatUid(four, small, sizeof small) == 0);
    char text[UID_TEXT_SIZE];
    CHECK(formatUid(NO_UID, text, sizeof text) == 0);
  });

  check::run("random-ID cards (4 bytes starting 0x08) are recognised; 7-byte ones starting 0x08 are not", [] {
    CHECK(isRandomUid(Uid{{0x08, 0x12, 0x34, 0x56}, 4}));
    CHECK(!isRandomUid(Uid{{0x04, 0x12, 0x34, 0x56}, 4}));
    CHECK(!isRandomUid(Uid{{0x08, 0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC}, 7}));
  });

  return check::result();
}
