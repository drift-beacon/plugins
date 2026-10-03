#include "portal.h"

#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_random.h>

#include <cstring>

#include "../core/json.h"
#include "../core/scan.h"
#include "../core/text.h"
#include "../portal_page.h"
#include "log.h"
#include "wifi_link.h"

namespace cp::portal {
namespace {

constexpr uint8_t MAX_NETWORKS = 20;

struct Network {
  char ssid[SSID_SIZE];
  int8_t rssi;
  bool secure;
};

/**
 * Whether a connection is from one of the access point's own clients. Setup can be open while the player is on Wi-Fi,
 * and the server listens on every address. The address a connection was made to doesn't say which side it came in
 * on: the network stack takes a packet for the access point's address on the station side too, so a machine on the
 * home network can route to it through the player's station address. The client's own address does say: an answer to
 * an address on the access point's subnet only ever leaves through the access point, so nobody elsewhere can finish
 * a connection that claims one.
 */
bool onSetupNetwork(NetworkClient& client) {
  const bool askedHere = client.localIP() == WiFi.softAPIP();
  const bool fromItsNetwork = wifi::onAccessPointNetwork(static_cast<uint32_t>(client.remoteIP()));
  return askedHere && fromItsNetwork;
}

/**
 * The Arduino core's web server, made to take connections only from the access point's clients, and to forget each
 * request once it has been dealt with.
 *
 * The core reads and parses a whole request before any handler runs, waiting up to 5 s on every silence and keeping
 * every field it is sent: a machine on the home network could hold the loop still that way, or run the player out of
 * memory, and only then be told 403. So `serve` takes the next connection itself and closes one from the wrong side
 * unread; the core's own accept is skipped while a connection is in hand.
 *
 * It has no limit to set on a request from the right side: a client of the open access point can still do both.
 *
 * The core reads a request's body before any handler has looked at the request, so before the checks below. What a
 * multipart body leaves behind when it can't be read to the end (a part too many, an upload cut short) stays in the
 * server, and is what its arg(name) and hasArg(name) search first, for every request after it: one such POST, from
 * anyone who can reach the port and with no token, would stand in for the fields of every later Connect and erase.
 * The Host of the last request stays the same way for one that sends none. So nothing is left to stay: `forget` runs
 * after every pass of the server, and the handlers read a form only by position (`ownFields`).
 */
class SetupServer final : public WebServer {
 public:
  using WebServer::WebServer;

  void serve() {
    if (_currentStatus == HC_NONE) {
      NetworkClient next = _server.accept();
      if (!next) return;
      if (!onSetupNetwork(next)) {
        next.stop();
        return;
      }
      _currentClient = next;
      _currentStatus = HC_WAIT_READ;
      _statusChange = millis();
    }
    handleClient();
    // A request is parsed and answered within that one call, so nothing of it is needed after it.
    forget();
  }

  void forget() {
    delete[] _postArgs;
    _postArgs = nullptr;
    _postArgsLen = 0;
    delete[] _currentArgs;
    _currentArgs = nullptr;
    _currentArgCount = 0;
    _hostHeader = String();
  }
};

Host* host = nullptr;
SetupServer server(80);
DNSServer dns;
bool started = false;
bool routed = false;
char token[33];
/** The access point's address, the same with the default port, and the page's URL. */
char address[16];
char addressWithPort[20];
char homeUrl[32];

/** The last list a scan produced, and when the next scan is due (core/scan.h). */
Network networks[MAX_NETWORKS];
uint8_t networkCount = 0;
NetworkScan scan;

// Large enough for twenty networks whose names are all escapes.
char answer[6144];

void sendJson(int status, size_t length) {
  server.sendHeader("Cache-Control", "no-store");
  if (length == 0) {
    server.send(500, "application/json", "{\"error\":\"The answer didn't fit\",\"field\":null}");
    return;
  }
  server.send(status, "application/json", answer);
}

void sendError(int status, const char* message, Field field) {
  JsonWriter json(answer, sizeof answer);
  json.open().key("error").string(message).key("field");
  if (const char* name = fieldName(field)) {
    json.string(name);
  } else {
    json.null();
  }
  json.close();
  sendJson(status, json.finish());
}

/**
 * Requests that reached the player from its station side are refused. `SetupServer::serve` has already turned
 * those connections away unread; this is the same check again, where the answer is decided.
 */
bool fromAccessPoint() {
  if (onSetupNetwork(server.client())) return true;
  server.send(403, "text/plain", "The setup page only answers on the player's own network");
  return false;
}

/**
 * The request names the player's own address as its host. On the player's network every name resolves to the
 * player, so a page from anywhere, already open in the phone's browser, could otherwise call this API as its own
 * origin, read the token and change the player.
 */
bool addressedHere() {
  const String asked = server.hostHeader();
  return asked == address || asked == addressWithPort;
}

/** An API request: from the access point, and addressed to the player itself. */
bool forApi() {
  if (!fromAccessPoint()) return false;
  if (addressedHere()) return true;
  sendError(403, "Open the setup page at the player's own address", Field::None);
  return false;
}

/**
 * The request carries the token from /api/state, which only the setup page itself can send: a page from elsewhere,
 * open in the same phone's browser, can make the phone ask the player for anything, but can neither read the token
 * nor add a header. Only such a request counts as someone using the page (`Host::touched`).
 */
bool hasToken() {
  const String sent = server.header("X-Setup-Token");
  return token[0] != '\0' && std::strcmp(sent.c_str(), token) == 0;
}

/**
 * Mutating requests need the token and a urlencoded form body. A multipart body is refused here whatever it
 * carries, and none of it is ever read (`ownFields`).
 */
bool mayChange() {
  if (!forApi()) return false;
  if (!hasToken() || !isFormBody(server.header("Content-Type").c_str())) {
    sendError(403, "Reload the setup page and try again", Field::None);
    return false;
  }
  host->touched();
  return true;
}

/**
 * This request's own form fields, by position, for the core's form readers (core/setup.h). Never by name: the
 * server's lookup by name finds what an earlier request left behind before it finds this request's (`SetupServer`).
 * By position it holds only what this request's own query and urlencoded body said.
 */
const auto ownFields = [](auto&& take) {
  for (int i = 0; i < server.args(); ++i) take(server.argName(i).c_str(), server.arg(i).c_str());
};

/**
 * Sends the browser to the page. Captive-portal probes and whatever else a joined phone asks any host for end here;
 * they don't count as someone using the page, so a phone left on the network can't hold setup open.
 */
void redirectHome() {
  if (!fromAccessPoint()) return;
  server.sendHeader("Location", homeUrl);
  server.sendHeader("Cache-Control", "no-store");
  server.send(302, "text/plain", "");
}

void servePage() {
  if (!fromAccessPoint()) return;
  if (!addressedHere()) {
    redirectHome();
    return;
  }
  // Fetching the page isn't yet using it: any page in the phone's browser can make it do that. The page's first
  // requests with the token are.
  server.sendHeader("Cache-Control", "no-store");
  if (PORTAL_PAGE_GZ_LEN == 0) {
    server.send(503, "text/plain", "This firmware was built without its setup page: run node player/portal/build.mjs");
    return;
  }
  server.sendHeader("Content-Encoding", "gzip");
  server.send_P(200, "text/html; charset=utf-8", reinterpret_cast<const char*>(PORTAL_PAGE_GZ), PORTAL_PAGE_GZ_LEN);
}

void serveState() {
  if (!forApi()) return;
  // Answered without the token, since this is where the token comes from; counted as use only with it.
  if (hasToken()) host->touched();
  sendJson(200, writeSetupState(host->identity(), host->readerWorking(), token, host->saved(), host->attempt(), answer,
                                sizeof answer));
}

/** Asks the radio for a scan. It refuses while the station is joining, so the station holds still meanwhile. */
void startScan(Millis now) {
  host->pauseStation(true);
  scan.started(WiFi.scanNetworks(true, false) == WIFI_SCAN_RUNNING, now);
}

void keep(const char* ssid, int32_t rssi, bool secure) {
  if (!ssid[0]) return;
  for (uint8_t i = 0; i < networkCount; ++i) {
    if (std::strcmp(networks[i].ssid, ssid) == 0) {
      if (rssi > networks[i].rssi) {
        networks[i].rssi = static_cast<int8_t>(rssi);
        networks[i].secure = secure;
      }
      return;
    }
  }
  uint8_t slot = networkCount;
  if (networkCount == MAX_NETWORKS) {
    slot = 0;
    for (uint8_t i = 1; i < networkCount; ++i) {
      if (networks[i].rssi < networks[slot].rssi) slot = i;
    }
    if (networks[slot].rssi >= rssi) return;
  } else {
    ++networkCount;
  }
  copyText(networks[slot].ssid, sizeof networks[slot].ssid, ssid);
  networks[slot].rssi = static_cast<int8_t>(rssi);
  networks[slot].secure = secure;
}

void collectScan(int16_t found, Millis now) {
  networkCount = 0;
  for (int16_t i = 0; i < found; ++i) {
    keep(WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.encryptionType(i) != WIFI_AUTH_OPEN);
  }
  WiFi.scanDelete();
  // Strongest first.
  for (uint8_t i = 1; i < networkCount; ++i) {
    const Network moving = networks[i];
    uint8_t j = i;
    for (; j > 0 && networks[j - 1].rssi < moving.rssi; --j) networks[j] = networks[j - 1];
    networks[j] = moving;
  }
  scan.listed(now);
}

void serveScan() {
  if (!forApi()) return;
  // A scan holds the station still, so it isn't for whoever can make the phone send a GET.
  if (!hasToken()) {
    sendError(403, "Reload the setup page and try again", Field::None);
    return;
  }
  host->touched();
  const Millis now = millis();
  const NetworkScan::Told told = scan.request(now);
  if (scan.startDue(now)) startScan(now);
  JsonWriter json(answer, sizeof answer);
  json.open().key("scanning").boolean(told.scanning).key("failed").boolean(told.failed).key("networks").openArray();
  for (uint8_t i = 0; i < networkCount; ++i) {
    json.open().key("ssid").string(networks[i].ssid).key("rssi").number(networks[i].rssi);
    json.key("secure").boolean(networks[i].secure).close();
  }
  json.closeArray().close();
  sendJson(200, json.finish());
}

void serveConnect() {
  if (!mayChange()) return;
  static ConnectFields fields;
  readConnectFields(fields, ownFields);
  static ConnectPlan plan;
  Problem problem;
  if (!planConnect(fields.form(), host->saved(), plan, problem)) {
    sendError(400, problem.message, problem.field);
    return;
  }
  if (!host->connect(plan)) {
    sendError(400, "The player is already connecting: wait for it to finish", Field::None);
    return;
  }
  JsonWriter json(answer, sizeof answer);
  json.open().key("attempt").number(host->attempt().id()).close();
  sendJson(202, json.finish());
}

void serveReset() {
  if (!mayChange()) return;
  if (!confirmsErase(ownFields)) {
    sendError(400, "Send confirm=erase to erase the player", Field::None);
    return;
  }
  JsonWriter json(answer, sizeof answer);
  json.open().key("ok").boolean(true).close();
  sendJson(200, json.finish());
  host->factoryReset();
}

void serveExit() {
  if (!mayChange()) return;
  switch (host->exitSetup()) {
    case Link::Exit::NotSetUp: sendError(400, "Set the player up first", Field::None); return;
    case Link::Exit::Connecting: sendError(400, "Wait for Connect to finish", Field::None); return;
    case Link::Exit::Leaving: break;
  }
  JsonWriter json(answer, sizeof answer);
  json.open().key("ok").boolean(true).close();
  sendJson(200, json.finish());
}

void route() {
  static const char* COLLECTED[] = {"X-Setup-Token", "Content-Type"};
  server.collectHeaders(COLLECTED, 2);
  server.on("/", HTTP_GET, servePage);
  server.on("/api/state", HTTP_GET, serveState);
  server.on("/api/scan", HTTP_GET, serveScan);
  server.on("/api/connect", HTTP_POST, serveConnect);
  server.on("/api/reset", HTTP_POST, serveReset);
  server.on("/api/exit", HTTP_POST, serveExit);
  // What phones and laptops fetch to find out whether a network needs a sign-in page.
  static const char* const PROBES[] = {"/generate_204",         "/gen_204", "/hotspot-detect.html",
                                       "/library/test/success.html", "/ncsi.txt", "/connecttest.txt",
                                       "/redirect",             "/fwlink"};
  for (const char* probe : PROBES) server.on(probe, redirectHome);
  server.onNotFound(redirectHome);
}

}  // namespace

void begin(Host& owner) {
  host = &owner;
  static const char DIGITS[] = "0123456789abcdef";
  for (size_t i = 0; i < 16; ++i) {
    const uint8_t byte = static_cast<uint8_t>(esp_random());
    token[i * 2] = DIGITS[byte >> 4];
    token[i * 2 + 1] = DIGITS[byte & 0x0F];
  }
  token[32] = '\0';
}

void open() {
  if (started) return;
  if (!routed) {
    route();
    routed = true;
  }
  wifi::accessPointIp(address, sizeof address);
  std::snprintf(addressWithPort, sizeof addressWithPort, "%s:80", address);
  std::snprintf(homeUrl, sizeof homeUrl, "http://%s/", address);
  dns.start(53, "*", WiFi.softAPIP());
  server.begin();
  started = true;
}

void close() {
  if (!started) return;
  server.stop();
  dns.stop();
  if (scan.running()) WiFi.scanDelete();
  scan.abandon();
  host->pauseStation(false);
  started = false;
}

const char* home() { return homeUrl; }

void handle(Millis now) {
  if (!started) return;
  if (scan.wanted()) {
    if (scan.running()) {
      const int16_t found = WiFi.scanComplete();
      if (found >= 0) {
        collectScan(found, now);
      } else if (found == WIFI_SCAN_FAILED) {
        scan.started(false, now);
      }
    } else if (scan.startDue(now)) {
      startScan(now);
    }
    const bool running = scan.running();
    if (scan.timedOut(now) && running) WiFi.scanDelete();
    // With the list in, or the scan given up, the station may join again.
    if (!scan.wanted()) host->pauseStation(false);
  }
  server.serve();
}

}  // namespace cp::portal
