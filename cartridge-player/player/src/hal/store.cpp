#include "store.h"

#include <Preferences.h>

#include <cstring>

namespace cp::store {
namespace {

Preferences prefs;
bool opened = false;

// DESIGN.md "Player", Settings. NVS allows names of up to 15 characters.
constexpr const char* NAMESPACE = "cartridge";
constexpr const char* KEY_SSID = "ssid";
constexpr const char* KEY_PASSWORD = "password";
constexpr const char* KEY_HOST = "host";
constexpr const char* KEY_PORT = "port";  // uint16 via putUShort/getUShort: any other getter reads the default
constexpr const char* KEY_BASE = "base";
constexpr const char* KEY_API_KEY = "key";
constexpr const char* KEY_BUZZER = "buzzer";

/** A saved string, or "" when it's missing or longer than the player accepts. */
void readString(const char* key, char* out, size_t cap) {
  out[0] = '\0';
  if (prefs.isKey(key) && prefs.getString(key, out, cap) == 0) out[0] = '\0';
}

bool writeString(const char* key, const char* value) {
  prefs.putString(key, value);
  char back[KEY_SIZE];  // the longest value there is
  readString(key, back, sizeof back);
  return std::strcmp(back, value) == 0;
}

}  // namespace

bool begin() {
  opened = prefs.begin(NAMESPACE, false);
  return opened;
}

Settings load() {
  if (!opened) return Settings();
  static char ssid[SSID_SIZE];
  static char password[PASSWORD_SIZE];
  static char host[HOST_SIZE];
  static char base[BASE_SIZE];
  static char key[KEY_SIZE];
  readString(KEY_SSID, ssid, sizeof ssid);
  readString(KEY_PASSWORD, password, sizeof password);
  readString(KEY_HOST, host, sizeof host);
  readString(KEY_BASE, base, sizeof base);
  readString(KEY_API_KEY, key, sizeof key);
  StoredValues stored;
  stored.ssid = ssid;
  stored.password = password;
  stored.host = host;
  stored.port = prefs.getUShort(KEY_PORT, 0);
  stored.base = base;
  stored.key = key;
  stored.buzzer = prefs.getBool(KEY_BUZZER, true);
  return settingsFrom(stored);
}

bool saveWifi(const char* ssid, const char* password) {
  return opened && writeString(KEY_SSID, ssid) && writeString(KEY_PASSWORD, password);
}

bool save(const char* ssid, const char* password, const HubTarget& hub) {
  if (!opened) return false;
  // From here until the key is back, what is in flash loads as "no hub" (store.h says why).
  prefs.remove(KEY_API_KEY);
  if (prefs.isKey(KEY_API_KEY)) return false;
  if (!saveWifi(ssid, password) || !writeString(KEY_HOST, hub.host)) return false;
  prefs.putUShort(KEY_PORT, hub.port);
  if (prefs.getUShort(KEY_PORT, 0) != hub.port) return false;
  return writeString(KEY_BASE, hub.base) && writeString(KEY_API_KEY, hub.key);
}

bool saveBuzzer(bool on) {
  if (!opened) return false;
  prefs.putBool(KEY_BUZZER, on);
  return prefs.getBool(KEY_BUZZER, !on) == on;
}

bool erase() { return opened && prefs.clear(); }

}  // namespace cp::store
