// Settings in flash: Preferences namespace "cartridge" (DESIGN.md "Player", Settings). Every write is read back.
#pragma once

#include "../core/settings.h"

namespace cp::store {

/** Opens the namespace. False when flash can't be opened (the player then runs in setup mode, unsaved). */
bool begin();
Settings load();
/** The Wi-Fi a first setup has joined, kept even if the hub step then fails. */
bool saveWifi(const char* ssid, const char* password);
/**
 * Everything a finished Connect proved: the hub, and the Wi-Fi it answered over. The saved API key is removed first
 * and the new one written last, and without a key nothing loads as a hub. So a power cut or a failed write part-way
 * leaves a player that asks for setup again, never one that pairs the old key with a new address or network.
 */
bool save(const char* ssid, const char* password, const HubTarget& hub);
bool saveBuzzer(bool on);
/** Clears the whole namespace. */
bool erase();

}  // namespace cp::store
