#include "app.h"

#include <Arduino.h>
#include <esp_mac.h>
#include <esp_random.h>
#include <esp_task_wdt.h>
#include <esp_timer.h>

#include <cstring>

#include "core/clock.h"
#include "core/device.h"
#include "core/indicator.h"
#include "core/inputs.h"
#include "core/link.h"
#include "core/protocol.h"
#include "core/reporter.h"
#include "core/settings.h"
#include "core/setup.h"
#include "core/slot_feed.h"
#include "core/tag_tracker.h"
#include "core/text.h"
#include "core/uid.h"
#include "hal/feedback.h"
#include "hal/hub_client.h"
#include "hal/log.h"
#include "hal/portal.h"
#include "hal/reader.h"
#include "hal/store.h"
#include "hal/wifi_link.h"

namespace cp::app {
namespace {

constexpr Millis POLL_EVERY_MS = 50;
/** The loop feeds the watchdog every pass; nothing it does takes anywhere near this long. */
constexpr uint32_t WATCHDOG_MS = 20000;
/**
 * The hub task isn't on the watchdog (hal/hub_client.h). A request can honestly take about 22 s: three silent DNS
 * servers, then the connect timeout. One still out after this long is stuck, and a restart is the only way to get
 * the task back.
 */
constexpr Millis HUB_STUCK_MS = 30000;
/** Lets the last HTTP answer and serial line out before a restart. */
constexpr Millis RESTART_DELAY_MS = 600;
constexpr size_t CONSOLE_BYTES_PER_PASS = 64;

/**
 * The disconnect reasons a station gives when it is told to leave a network or to drop a join: the player's own
 * doing (hal/wifi_link.cpp drops whatever is going on before every join), so nothing failed.
 */
bool ownLeave(uint16_t reason) { return reason == 3 || reason == 8; }

enum class Job : uint8_t { None, Report, Probe };

Identity identity;
Settings settings;
TagTracker tracker(0);
SlotFeed slotFeed;
Reporter reporter(0);
Link link;
Attempt attempt;
Indicator indicator;
LongPress bootButton;
LineReader console;
Confirmation factoryConfirm;

Job job = Job::None;
Millis jobStartedAt = 0;
hub::Request request;
hub::Response response;
Millis pollAt = 0;
bool readerWorking = false;
uint32_t setupGeneration = 0;
char stationIp[16] = "";
int lastReportStatus = 0;
Reason sentReason = Reason::Boot;
bool restartPending = false;
bool eraseBeforeRestart = false;
Millis restartAt = 0;

uint32_t uptimeSeconds() { return static_cast<uint32_t>(esp_timer_get_time() / 1000000); }

void scheduleRestart(bool erase, Millis now) {
  restartPending = true;
  eraseBeforeRestart = erase;
  restartAt = now + RESTART_DELAY_MS;
}

void logSlot(const char* what, const Uid& slot) {
  char text[UID_TEXT_SIZE];
  logf("Slot: %s %s", what, formatUid(slot, text, sizeof text) ? text : "(empty)");
}

void logSettings() {
  logf("Settings: Wi-Fi %s, password %s", settings.hasWifi() ? settings.ssid : "not set",
       settings.password[0] ? "set" : "not set");
  if (settings.hasHub()) {
    logf("Settings: hub %s:%u%s, API key %s", settings.hub.host, settings.hub.port, settings.hub.base,
         settings.hub.key[0] ? "set" : "not set");
  } else {
    logf("Settings: no hub yet");
  }
}

void printStatus() {
  const uint32_t up = uptimeSeconds();
  logf("Cartridge Player %s, %s (%s), up %luh %02lum", FIRMWARE_VERSION, identity.id, identity.name,
       static_cast<unsigned long>(up / 3600), static_cast<unsigned long>(up / 60 % 60));
  if (readerWorking) {
    logf("Reader: ok (MFRC522 version 0x%02X)", reader::version());
  } else {
    logf("Reader: not answering");
  }
  // Only a slot the reader has read is called empty; a cartridge it can't see any more is the last one it saw.
  char tag[UID_TEXT_SIZE];
  const bool holds = formatUid(tracker.slot(), tag, sizeof tag);
  logf("Slot: %s%s", holds ? tag : tracker.known() ? "empty" : "not read",
       holds && !tracker.known() ? " (as last read)" : "");
  if (!settings.hasWifi()) {
    logf("Wi-Fi: not set up");
  } else if (link.stationIsUp()) {
    logf("Wi-Fi: %s, %s, %ld dBm, %s.local", settings.ssid, stationIp, static_cast<long>(wifi::rssi()),
         identity.hostname);
  } else {
    logf("Wi-Fi: joining %s", settings.ssid);
  }
  if (settings.hasHub()) {
    logf("Hub: %s:%u%s, API key %s; %s%s%s", settings.hub.host, settings.hub.port, settings.hub.base,
         settings.hub.key[0] ? "set" : "not set", hubStateName(reporter.hub()),
         reporter.lastResult()[0] ? ", last result " : "", reporter.lastResult());
  } else {
    logf("Hub: not set up");
  }
  if (link.inSetup()) {
    logf("Setup: open (%s): join %s, then open %s", setupReasonName(link.reason()), identity.name, portal::home());
  } else {
    logf("Setup: closed (hold BOOT for 3 s or send CONFIG to open it)");
  }
  logf("Buzzer: %s", settings.buzzer ? "on" : "off");
}

void printHelp() {
  logf("Commands:");
  logf("  STATUS      what the player is doing");
  logf("  CONFIG      open setup mode (network %s)", identity.name);
  logf("  RESET       restart");
  logf("  FACTORY     erase every setting (send it twice within 5 s)");
  logf("  BUZZER ON   sounds on (BUZZER OFF: light only)");
  logf("  HELP        this list");
}

void applySetupMode() {
  if (link.generation() == setupGeneration) return;
  setupGeneration = link.generation();
  if (link.inSetup()) {
    // What the last Connect came to belongs to the last time setup was open.
    attempt.reset();
    wifi::openAccessPoint(identity.name);
    portal::open();
    logf("Setup: open (%s): join %s, then open %s", setupReasonName(link.reason()), identity.name, portal::home());
  } else {
    portal::close();
    wifi::closeAccessPoint();
    logf("Setup: closed");
  }
}

/** The BOOT button or CONFIG. With setup already open it keeps it open, and the page starts over from the form. */
void requestSetup(SetupReason reason, Millis now) {
  link.requestSetup(reason, now);
  if (!attempt.active()) attempt.reset();
}

void endAttempt(bool succeeded, Millis now) {
  if (!succeeded && !(link.stationIsUp() && onSavedNetwork(attempt.plan(), settings))) {
    // Whatever the attempt reached is not a network the player was set up for. Leave it in this same pass, before
    // the reporter runs again, so nothing (the saved key least of all) is sent over it; the link then goes back to
    // the saved network.
    wifi::leave();
    link.stationLeft(now);
    stationIp[0] = '\0';
  }
  link.attemptEnded(succeeded, now);
  if (succeeded) {
    logf("Setup: done; the access point closes in a minute");
    indicator.play(Cue::Ok, now);
  } else {
    logf("Setup: failed: %s", attempt.message());
    indicator.play(Cue::Error, now);
  }
}

/** Wi-Fi joined during a Connect: probe the hub over it. A first setup keeps the network even if the probe fails. */
void attemptJoined(Millis now) {
  attempt.joined(stationIp, now);
  const ConnectPlan& plan = attempt.plan();
  logf("Setup: joined %s as %s", plan.ssid, stationIp);
  if (!savesWifiOnJoin(settings) || onSavedNetwork(plan, settings)) return;
  if (!store::saveWifi(plan.ssid, plan.password)) {
    attempt.saveFailed();
    endAttempt(false, now);
    return;
  }
  copyText(settings.ssid, sizeof settings.ssid, plan.ssid);
  copyText(settings.password, sizeof settings.password, plan.password);
  link.settingsChanged(settings.configured, settings.hasWifi(), now);
}

/**
 * The station is off its network. A Connect that was asking the hub ends here: with the station down its next probe
 * would leave by whatever interface is left (in setup mode, the open access point), carrying the plan's key.
 */
void stationWentDown(Millis now) {
  link.stationDown(now);
  stationIp[0] = '\0';
  if (attempt.linkLost()) endAttempt(false, now);
}

void handleWifiEvents(Millis now) {
  wifi::Event event;
  while (wifi::nextEvent(event)) {
    const bool joining = attempt.phase() == Phase::Joining;
    const bool wasUp = link.stationIsUp();
    // The network the player asked for last. An event that names another one is a late answer from the network
    // before; one that names none counts, so a driver that leaves the name out can't hide a failure.
    const char* asked = joining ? attempt.plan().ssid : settings.ssid;
    const bool late = event.ssid[0] != '\0' && std::strcmp(event.ssid, asked) != 0;
    switch (event.type) {
      case wifi::Event::Type::Up:
        if (late) break;
        // The name isn't proof: a network a failed Connect just left can share the saved one's. After the player's
        // own leave no address counts until it joins again (a Connect's join is the attempt's, not the link's).
        if (!joining && !link.expectsUp()) break;
        link.stationUp(now);
        wifi::stationIp(stationIp, sizeof stationIp);
        if (!wasUp) {
          logf("Wi-Fi: connected as %s (%ld dBm)", stationIp, static_cast<long>(wifi::rssi()));
          wifi::announce(identity.hostname);
          reporter.linkUp(now);
        }
        if (joining) attemptJoined(now);
        break;
      case wifi::Event::Type::Down:
        if (wasUp) {
          logf("Wi-Fi: disconnected (reason %u)", event.reason);
          stationWentDown(now);
        } else if (!late && !ownLeave(event.reason)) {
          // A join failed. For the link it's one more try used up; a Connect gets the reason, to tell the user.
          stationWentDown(now);
          if (joining && attempt.joinFailed(event.reason, now)) endAttempt(false, now);
        }
        break;
      case wifi::Event::Type::LostAddress:
        // Usually the echo, two minutes on, of a drop that was handled then. Otherwise the lease ran out while the
        // station stayed associated: join again for a new one.
        if (!wasUp) break;
        logf("Wi-Fi: lost its address");
        stationWentDown(now);
        break;
    }
  }
}

void pollReader(Millis now) {
  if (!reached(now, pollAt)) return;
  pollAt = now + POLL_EVERY_MS;
  Uid uid = NO_UID;
  const Read read = reader::poll(uid, now);
  readerWorking = read != Read::Fault;
  const SlotStep step = slotFeed.poll(tracker, reporter, read, uid, now);
  if (step.settled && !tracker.known()) {
    logf("Slot: not read at start-up (the reader isn't answering)");
  } else if (step.settled) {
    logSlot("at start-up", tracker.slot());
  } else {
    if (step.out) logSlot("out", NO_UID);
    if (step.in) logSlot("in", tracker.slot());
  }
}

void runCommand(const char* line, Millis now) {
  const Command command = parseCommand(line);
  if (command != Command::Factory) factoryConfirm.cancel();
  switch (command) {
    case Command::Status: printStatus(); break;
    case Command::Config:
      // Opening logs where to go; an open setup only stays open, so say it again here.
      if (link.inSetup()) logf("Setup: already open: join %s, then open %s", identity.name, portal::home());
      requestSetup(SetupReason::Serial, now);
      break;
    case Command::Reset:
      logf("Restarting");
      scheduleRestart(false, now);
      break;
    case Command::Factory:
      if (factoryConfirm.ask(now)) {
        logf("Erasing every setting and restarting");
        scheduleRestart(true, now);
      } else {
        logf("This erases Wi-Fi and hub settings. Send FACTORY again within 5 s to go ahead");
      }
      break;
    case Command::BuzzerOn:
    case Command::BuzzerOff:
      settings.buzzer = command == Command::BuzzerOn;
      if (!store::saveBuzzer(settings.buzzer)) logf("Buzzer: couldn't save the setting; it lasts until restart");
      logf("Buzzer: %s", settings.buzzer ? "on" : "off");
      break;
    case Command::Help: printHelp(); break;
    case Command::Unknown: logf("Unknown command \"%s\": send HELP for the list", line); break;
  }
}

void readConsole(Millis now) {
  for (size_t count = 0; count < CONSOLE_BYTES_PER_PASS && Serial.available() > 0; ++count) {
    if (console.feed(static_cast<char>(Serial.read()))) runCommand(console.line(), now);
  }
}

void startProbe(Millis now) {
  const HubTarget& hub = attempt.plan().hub;
  request.post = false;
  copyText(request.host, sizeof request.host, hub.host);
  request.port = hub.port;
  std::snprintf(request.path, sizeof request.path, "%s%s", hub.base, REPORT_ROUTE);
  copyText(request.key, sizeof request.key, hub.key);
  request.length = 0;
  if (!hub::send(request)) return;
  job = Job::Probe;
  jobStartedAt = now;
  attempt.probeStarted();
  logf("Setup: asking %s:%u%s", request.host, request.port, request.path);
}

void driveAttempt(Millis now) {
  if (attempt.joinTimedOut(now)) endAttempt(false, now);
  // The radio only changes network between requests: a report already on its way carries the saved key, and must
  // have finished (or failed) on the network it was meant for.
  if (job == Job::None && attempt.joinDue(now)) {
    if (wifi::join(attempt.plan().ssid, attempt.plan().password)) {
      attempt.joinStarted();
    } else {
      attempt.joinRefused(now);
    }
  }
  // A probe only ever goes over the network the attempt joined: the station is up on it for as long as the attempt
  // is probing (losing it ends the attempt, in `stationWentDown`), and nothing is sent the moment it isn't.
  if (job == Job::None && link.stationIsUp() && attempt.probeDue(now)) startProbe(now);
}

void finishProbe(const Answer& answer, Millis now) {
  switch (attempt.probeFinished(response.status, answer, now)) {
    case ProbeVerdict::Retry: return;
    case ProbeVerdict::Failed: endAttempt(false, now); return;
    case ProbeVerdict::Save: break;
  }
  // Only now, with the hub answering over it, does a set-up player take on a new network (and its key a new hub).
  const ConnectPlan& plan = attempt.plan();
  if (!store::save(plan.ssid, plan.password, plan.hub)) {
    attempt.saveFailed();
    endAttempt(false, now);
    return;
  }
  copyText(settings.ssid, sizeof settings.ssid, plan.ssid);
  copyText(settings.password, sizeof settings.password, plan.password);
  settings.hub = plan.hub;
  settings.configured = settings.hasWifi() && settings.hasHub();
  link.settingsChanged(settings.configured, settings.hasWifi(), now);
  reporter.hubChanged(now);
  attempt.done(now);
  endAttempt(true, now);
}

void startReport(Millis now) {
  const ReportDraft draft = reporter.begin();
  sentReason = draft.reason;
  const ReportBody body =
      reportBody(draft, identity, reporter.boot(), link.stationIsUp(), wifi::rssi(), uptimeSeconds(), now);
  request.post = true;
  copyText(request.host, sizeof request.host, settings.hub.host);
  request.port = settings.hub.port;
  std::snprintf(request.path, sizeof request.path, "%s%s", settings.hub.base, REPORT_ROUTE);
  copyText(request.key, sizeof request.key, settings.hub.key);
  const size_t length = writeReport(body, request.body, sizeof request.body);
  request.length = static_cast<uint16_t>(length);
  if (length == 0 || !hub::send(request)) {
    indicator.play(reporter.finish(-1, Answer(), now), now);
    return;
  }
  job = Job::Report;
  jobStartedAt = now;
}

void logReport(const Answer& answer) {
  // A heartbeat only makes a line when its outcome differs from the last report's; everything else always does.
  const bool repeat = sentReason == Reason::Heartbeat && response.status == lastReportStatus;
  lastReportStatus = response.status;
  if (repeat) return;
  const char* reason = reasonName(sentReason);
  if (response.status < 0) {
    logf("Hub: %s report got no answer from %s:%u; trying again", reason, request.host, request.port);
  } else if (answer.result[0]) {
    logf("Hub: %s report answered %d %s%s%s", reason, response.status, answer.result,
         answer.activity[0] ? ": " : "", answer.activity);
  } else if (answer.error[0]) {
    logf("Hub: %s report answered %d: %s", reason, response.status, answer.error);
  } else if (classify(response.status) == Delivery::Delivered) {
    // Every reply of the plugin's has a result, so this came from something else at the hub's address.
    logf("Hub: %s report answered %d, but not with the plugin's reply; trying again", reason, response.status);
  } else {
    logf("Hub: %s report answered %d (%s)", reason, response.status, hubStateName(reporter.hub()));
  }
}

void collectHub(Millis now) {
  if (job == Job::None || !hub::receive(response)) return;
  Answer answer;
  readAnswer(response.body, response.length, answer);
  const Job finished = job;
  job = Job::None;
  if (finished == Job::Probe) {
    // The attempt may have ended while its probe was out (its network dropped): that answer is nobody's, and acting
    // on it would end an attempt twice, or hand a new Connect the answer to the last one.
    if (attempt.probeOut()) finishProbe(answer, now);
    return;
  }
  indicator.play(reporter.finish(response.status, answer, now), now);
  logReport(answer);
}

void driveReporter(Millis now) {
  if (job != Job::None || !settings.configured || !link.stationIsUp() || attempt.active()) return;
  if (reporter.ready(now)) startReport(now);
}

void watchHub(Millis now) {
  if (job == Job::None || restartPending || since(now, jobStartedAt) < HUB_STUCK_MS) return;
  logf("Hub: request stuck for %lu s; restarting", static_cast<unsigned long>(HUB_STUCK_MS / 1000));
  scheduleRestart(false, now);
}

class PortalHost final : public portal::Host {
 public:
  const Identity& identity() const override { return app::identity; }
  const Settings& saved() const override { return settings; }
  const Attempt& attempt() const override { return app::attempt; }
  bool readerWorking() const override { return app::readerWorking; }

  bool connect(const ConnectPlan& plan) override {
    if (app::attempt.active()) return false;
    const Millis now = millis();
    app::attempt.start(plan, now);
    link.attemptStarted();
    logf("Setup: connecting to %s, then %s:%u", plan.ssid, plan.hub.host, plan.hub.port);
    // Already on that network: don't drop it (and the phone with it) just to join it again. Otherwise the loop
    // starts the join (driveAttempt).
    if (link.stationIsUp() && onSavedNetwork(plan, settings)) app::attempt.joined(stationIp, now);
    return true;
  }

  Link::Exit exitSetup() override { return link.exitSetup(millis()); }
  void factoryReset() override { scheduleRestart(true, millis()); }
  void touched() override { link.touched(millis()); }
  void pauseStation(bool paused) override { link.pauseStation(paused); }
};

PortalHost portalHost;

}  // namespace

void setup() {
  // The USB serial port keeps the core's transmit timeout. With no host it never waits anyway, and with a zero
  // timeout a line longer than the port's buffer is cut short, or stalls the loop once a monitor stops reading.
  Serial.begin(115200);

  esp_task_wdt_config_t watchdog = {WATCHDOG_MS, 1u << 0, true};
  esp_task_wdt_reconfigure(&watchdog);
  enableLoopWDT();

  uint8_t mac[6] = {};
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  identity = identityFrom(mac);
  logf("Cartridge Player %s, %s (%s)", FIRMWARE_VERSION, identity.id, identity.name);

  feedback::begin();
  if (!store::begin()) logf("Settings: flash couldn't be opened; nothing will be saved");
  settings = store::load();
  logSettings();

  const Millis now = millis();
  tracker = TagTracker(now);
  reporter = Reporter(esp_random());
  reader::begin(now);
  wifi::begin(identity);
  if (!hub::begin()) logf("Hub: couldn't start the network task");
  portal::begin(portalHost);
  link.begin(settings.configured, settings.hasWifi(), now);
  applySetupMode();
  logf("Send HELP for serial commands");
}

void loop() {
  const Millis now = millis();
  handleWifiEvents(now);
  pollReader(now);
  if (bootButton.update(feedback::bootPressed(), now)) {
    logf("Setup: BOOT button held");
    requestSetup(SetupReason::Button, now);
  }
  readConsole(now);

  link.update(now);
  applySetupMode();
  if (link.shouldJoin(now)) {
    if (wifi::join(settings.ssid, settings.password)) {
      link.joinStarted(now);
    } else {
      link.joinRefused(now);
    }
  }

  driveAttempt(now);
  driveReporter(now);
  collectHub(now);
  watchHub(now);
  indicator.play(reporter.tick(now), now);
  if (link.inSetup()) portal::handle(now);

  const AmbientInputs ambient = {link.inSetup(),     slotFeed.readerFault(), reporter.reading(),
                                 link.stationIsUp(), reporter.hub(),         reporter.standing()};
  feedback::show(indicator.frame(ambientFor(ambient), settings.buzzer, now));

  if (restartPending && reached(now, restartAt)) {
    if (eraseBeforeRestart) store::erase();
    ESP.restart();
  }

  // Nothing above waits, so without this the loop would spin a whole core flat out between 50 ms polls. One tick
  // hands the core to the idle task; polling and cue timing stay within a millisecond.
  delay(1);
}

}  // namespace cp::app
