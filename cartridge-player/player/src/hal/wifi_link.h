// The radio. Run mode is station only; setup mode adds the open access point. The core's own reconnect is off and
// credentials are never written to the Wi-Fi driver's flash: the loop decides when to join (core/link.h), and the
// only copy of the password is in the "cartridge" namespace.
#pragma once

#include <cstddef>
#include <cstdint>

#include "../core/device.h"
#include "../core/settings.h"

namespace cp::wifi {

/** What the station did, from the Wi-Fi task, handed to the loop through a queue. */
struct Event {
  enum class Type : uint8_t {
    Up,           // associated and has an address
    Down,         // a join failed, or the connection dropped
    LostAddress,  // the address is gone: the echo of a drop two minutes earlier, or a lease that ran out
  };
  Type type;
  /** For Down: the driver's disconnect reason (core/setup.h names the useful ones). */
  uint16_t reason;
  /** The network the event is about, so a late answer from the network before isn't taken for the one asked now. */
  char ssid[SSID_SIZE];
};

void begin(const Identity& identity);
bool nextEvent(Event& event);
/**
 * Starts joining a network, dropping whatever join or connection the station had. False when the driver wouldn't
 * take it (ask again shortly); the outcome arrives later as an event.
 */
bool join(const char* ssid, const char* password);
void leave();
void openAccessPoint(const char* name);
void closeAccessPoint();
/** The access point's address as text, for the setup page's own URL. */
void accessPointIp(char* out, size_t cap);
/** Whether an IPv4 address (as the Arduino core holds one, first byte lowest) is one of the access point's clients'. */
bool onAccessPointNetwork(uint32_t address);
/**
 * Whether a connection whose own end has this address runs over the station, as things are now. Safe to ask from
 * the hub task.
 */
bool overStation(uint32_t local);
void stationIp(char* out, size_t cap);
int32_t rssi();
/** Starts mDNS once the station has an address, so the player answers to <hostname>.local. */
void announce(const char* hostname);

}  // namespace cp::wifi
