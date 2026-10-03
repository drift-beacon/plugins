// The setup page and its API (DESIGN.md "Setup page API"), served only in setup mode, only to clients of the
// player's own access point and only when asked for at the player's own address. Handlers run on the loop task, so
// they read the player's state directly; everything they change goes through `Host`.
#pragma once

#include "../core/clock.h"
#include "../core/device.h"
#include "../core/link.h"
#include "../core/settings.h"
#include "../core/setup.h"

namespace cp::portal {

/** What the setup page needs from the rest of the player. */
class Host {
 public:
  virtual const Identity& identity() const = 0;
  virtual const Settings& saved() const = 0;
  virtual const Attempt& attempt() const = 0;
  virtual bool readerWorking() const = 0;
  /** Starts a checked Connect. False when one is already running. */
  virtual bool connect(const ConnectPlan& plan) = 0;
  /** Leaves setup mode, once the answer has gone out. */
  virtual Link::Exit exitSetup() = 0;
  /** Erases everything and restarts, after the answer has gone out. */
  virtual void factoryReset() = 0;
  /** A request from the setup page arrived: setup stays open. */
  virtual void touched() = 0;
  /** Holds the station still while a scan runs (a scan fails while the station is joining). */
  virtual void pauseStation(bool paused) = 0;

 protected:
  ~Host() = default;
};

/** Makes the per-boot token; call once at start-up. */
void begin(Host& host);
/** Starts the page and the DNS that sends every name to it. The access point must be up. */
void open();
void close();
/** The page's URL, for the console. Set by `open`. */
const char* home();
/** Serves waiting requests and follows a running scan. Call every loop while open. */
void handle(Millis now);

}  // namespace cp::portal
