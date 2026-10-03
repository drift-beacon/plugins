#include "hub_client.h"

#include <HTTPClient.h>
#include <NetworkClient.h>

#include <cstdio>

#include "../core/device.h"
#include "../core/http_body.h"
#include "wifi_link.h"

namespace cp::hub {
namespace {

constexpr int32_t CONNECT_TIMEOUT_MS = 1500;
/** The longest silence allowed while the status line and headers arrive. */
constexpr uint16_t READ_TIMEOUT_MS = 2500;
/** The whole body must arrive within this, however the hub paces it. */
constexpr uint32_t BODY_TIMEOUT_MS = 3000;

QueueHandle_t requests = nullptr;
QueueHandle_t responses = nullptr;

/**
 * The answer's body as bytes, under one deadline. HTTPClient's own body reader has none: a hub or proxy that stalls
 * mid-body, or trickles it, would keep this task (and every later report) waiting for as long as the socket stays
 * open.
 */
class BodyBytes {
 public:
  explicit BodyBytes(NetworkClient& stream) : stream_(stream), startedAt_(millis()) {}

  /** The next byte, or -1 once the hub has closed the connection or the body's time is up. */
  int operator()() {
    for (;;) {
      if (stream_.available() > 0) return stream_.read();
      if (!stream_.connected() || millis() - startedAt_ >= BODY_TIMEOUT_MS) return -1;
      delay(1);
    }
  }

 private:
  NetworkClient& stream_;
  uint32_t startedAt_;
};

/**
 * A connection that only stands while it runs over the station. The loop starts a request with the station up, but
 * the connection is made later, on this task, after any name lookup: should the station drop in between, in setup
 * mode the open access point is the only interface left, and the request carries the API key. So every connection
 * HTTPClient makes (it goes through this one call, the first time and whenever it finds the last one closed) is
 * looked at before anything is written on it, and closed unless its own end is the station's address.
 */
class StationClient final : public NetworkClient {
 public:
  using NetworkClient::connect;

  int connect(IPAddress ip, uint16_t port, int32_t timeoutMs) override {
    if (!NetworkClient::connect(ip, port, timeoutMs)) return 0;
    if (wifi::overStation(static_cast<uint32_t>(localIP()))) return 1;
    stop();
    return 0;
  }
};

void perform(const Request& request, Response& response) {
  response.status = -1;
  response.length = 0;
  response.body[0] = '\0';
  StationClient client;
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(CONNECT_TIMEOUT_MS);
  http.setTimeout(READ_TIMEOUT_MS);
  http.setUserAgent(USER_AGENT);
  static const char* COLLECTED[] = {"Transfer-Encoding"};
  http.collectHeaders(COLLECTED, 1);
  if (!http.begin(client, request.host, request.port, request.path, false)) return;
  char authorization[8 + KEY_SIZE];
  std::snprintf(authorization, sizeof authorization, "Bearer %s", request.key);
  http.addHeader("Authorization", authorization);
  int status;
  if (request.post) {
    http.addHeader("Content-Type", "application/json");
    status = http.POST(reinterpret_cast<uint8_t*>(const_cast<char*>(request.body)), request.length);
  } else {
    status = http.GET();
  }
  if (status > 0) {
    response.status = status;
    BodyBytes bytes(http.getStream());
    const size_t length = http.header("Transfer-Encoding").equalsIgnoreCase("chunked")
                              ? readChunkedBody(bytes, response.body, ANSWER_MAX)
                              : readPlainBody(bytes, http.getSize(), response.body, ANSWER_MAX);
    response.length = static_cast<uint16_t>(length);
    response.body[response.length] = '\0';
  }
  http.end();
}

void run(void*) {
  static Request request;
  static Response response;
  for (;;) {
    if (xQueueReceive(requests, &request, portMAX_DELAY) != pdTRUE) continue;
    perform(request, response);
    xQueueSend(responses, &response, portMAX_DELAY);
  }
}

}  // namespace

bool begin() {
  requests = xQueueCreate(1, sizeof(Request));
  responses = xQueueCreate(1, sizeof(Response));
  if (!requests || !responses) return false;
  // Core 0, next to the Wi-Fi stack; the loop runs on core 1.
  return xTaskCreatePinnedToCore(run, "hub", 8192, nullptr, 2, nullptr, 0) == pdPASS;
}

bool send(const Request& request) { return xQueueSend(requests, &request, 0) == pdTRUE; }

bool receive(Response& response) { return xQueueReceive(responses, &response, 0) == pdTRUE; }

}  // namespace cp::hub
