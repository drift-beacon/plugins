// Who this player is: its firmware version and the names derived from its MAC address. The same suffix appears in
// its id (sent in every report), its setup network's name and its host name, so all three point at one device.
#pragma once

#include <cstdint>

namespace cp {

#define CP_FIRMWARE_VERSION "2.0.0"

constexpr const char* FIRMWARE_VERSION = CP_FIRMWARE_VERSION;
/** Sent as the User-Agent of every request, so the hub's logs say which firmware spoke. */
constexpr const char* USER_AGENT = "CartridgePlayer/" CP_FIRMWARE_VERSION;

struct Identity {
  /** "cp-" and the last three MAC bytes, for example "cp-a1b2c3". */
  char id[10];
  /** The setup network's name, for example "Cartridge-A1B2". */
  char name[15];
  /** The DHCP and mDNS host name, for example "cartridge-a1b2c3". */
  char hostname[17];
};

inline Identity identityFrom(const uint8_t mac[6]) {
  static const char LOWER[] = "0123456789abcdef";
  static const char UPPER[] = "0123456789ABCDEF";
  Identity identity = {};
  char suffix[7];
  for (int i = 0; i < 3; ++i) {
    suffix[i * 2] = LOWER[mac[3 + i] >> 4];
    suffix[i * 2 + 1] = LOWER[mac[3 + i] & 0x0F];
  }
  suffix[6] = '\0';
  const char* idPrefix = "cp-";
  const char* namePrefix = "Cartridge-";
  const char* hostPrefix = "cartridge-";
  char* at = identity.id;
  for (const char* c = idPrefix; *c; ++c) *at++ = *c;
  for (const char* c = suffix; *c; ++c) *at++ = *c;
  *at = '\0';
  at = identity.name;
  for (const char* c = namePrefix; *c; ++c) *at++ = *c;
  for (int i = 0; i < 2; ++i) {
    *at++ = UPPER[mac[3 + i] >> 4];
    *at++ = UPPER[mac[3 + i] & 0x0F];
  }
  *at = '\0';
  at = identity.hostname;
  for (const char* c = hostPrefix; *c; ++c) *at++ = *c;
  for (const char* c = suffix; *c; ++c) *at++ = *c;
  *at = '\0';
  return identity;
}

}  // namespace cp
