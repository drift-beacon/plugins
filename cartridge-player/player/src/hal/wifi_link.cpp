#include "wifi_link.h"

#include <ESPmDNS.h>
#include <WiFi.h>

#include <cstring>

#include "../core/link.h"
#include "log.h"

namespace cp::wifi {
namespace {

// The setup network's own subnet. Not the core's default 192.168.4.1/24: some home routers hand out that very range,
// and with the access point up beside the station the hub's address would then be looked for on the wrong side.
const IPAddress ACCESS_POINT_IP(10, 123, 45, 1);
const IPAddress ACCESS_POINT_MASK(255, 255, 255, 0);

QueueHandle_t events = nullptr;
bool announced = false;
/** The network of the last association, for the Up event (the address arrives in a later event, without a name). */
char associated[SSID_SIZE] = "";

void copySsid(char* out, const uint8_t* ssid, size_t length) {
  const size_t kept = length < SSID_SIZE ? length : SSID_SIZE - 1;
  std::memcpy(out, ssid, kept);
  out[kept] = '\0';
}

void onEvent(arduino_event_t* event) {
  Event out = {};
  switch (event->event_id) {
    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      copySsid(associated, event->event_info.wifi_sta_connected.ssid, event->event_info.wifi_sta_connected.ssid_len);
      return;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      out.type = Event::Type::Up;
      std::memcpy(out.ssid, associated, sizeof out.ssid);
      break;
    case ARDUINO_EVENT_WIFI_STA_LOST_IP: out.type = Event::Type::LostAddress; break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      out.type = Event::Type::Down;
      out.reason = event->event_info.wifi_sta_disconnected.reason;
      copySsid(out.ssid, event->event_info.wifi_sta_disconnected.ssid,
               event->event_info.wifi_sta_disconnected.ssid_len);
      break;
    default: return;
  }
  if (events) xQueueSend(events, &out, 0);
}

}  // namespace

void begin(const Identity& identity) {
  events = xQueueCreate(8, sizeof(Event));
  WiFi.persistent(false);
  WiFi.setHostname(identity.hostname);
  WiFi.onEvent(onEvent);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);
  // Modem sleep adds up to a beacon interval (~100 ms) to every report; the player is mains powered.
  WiFi.setSleep(false);
}

bool nextEvent(Event& event) { return events && xQueueReceive(events, &event, 0) == pdTRUE; }

bool join(const char* ssid, const char* password) {
  if (!WiFi.STA.begin()) return false;
  // While the driver is still connecting it refuses a new network, and after the first failed join of a power-up the
  // core starts one retry of its own. Dropping whatever is going on first makes this join the only one in the air.
  WiFi.disconnect(false, false);
  return WiFi.STA.connect(ssid, password[0] ? password : nullptr);
}

void leave() { WiFi.disconnect(false, false); }

void openAccessPoint(const char* name) {
  WiFi.mode(WIFI_AP_STA);
  // The address goes in first, with the player itself as the DNS server its DHCP hands out (the captive portal).
  if (!WiFi.softAPConfig(ACCESS_POINT_IP, ACCESS_POINT_IP, ACCESS_POINT_MASK, IPAddress(), ACCESS_POINT_IP)) {
    logf("Setup: couldn't set the access point's address");
  }
  // Open, and for one phone at a time: there is nothing to protect before setup, and the network only exists for
  // the minutes that setup is open.
  if (!WiFi.softAP(name, nullptr, 1, 0, 1)) logf("Setup: couldn't start the access point");
  WiFi.AP.enableDhcpCaptivePortal();
}

void closeAccessPoint() {
  WiFi.softAPdisconnect(false);
  WiFi.mode(WIFI_STA);
}

void accessPointIp(char* out, size_t cap) { snprintf(out, cap, "%s", WiFi.softAPIP().toString().c_str()); }

bool onAccessPointNetwork(uint32_t address) {
  return sameSubnet(address, static_cast<uint32_t>(ACCESS_POINT_IP), static_cast<uint32_t>(ACCESS_POINT_MASK));
}

bool overStation(uint32_t local) {
  return cp::overStation(local, static_cast<uint32_t>(WiFi.localIP()), static_cast<uint32_t>(ACCESS_POINT_IP));
}

void stationIp(char* out, size_t cap) { snprintf(out, cap, "%s", WiFi.localIP().toString().c_str()); }

int32_t rssi() { return WiFi.RSSI(); }

void announce(const char* hostname) {
  if (announced) return;
  announced = MDNS.begin(hostname);
  if (announced) logf("Wi-Fi: answering as %s.local", hostname);
}

}  // namespace cp::wifi
