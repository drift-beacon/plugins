// HTTP to the hub on a task of its own, so a slow or absent hub never stalls the reader or the setup page. The loop
// and the task exchange fixed-size copies through two queues; they share no memory and no Strings.
//
// The task is not on the task watchdog. A request has no single deadline the task could promise to meet: a name
// lookup alone can take 21 s when the network's DNS servers stay silent. The loop watches the request instead and
// restarts the player, with a line on the console, when one has been out far longer than any request can take.
#pragma once

#include <cstdint>

#include "../core/protocol.h"
#include "../core/settings.h"

namespace cp::hub {

struct Request {
  bool post;
  char host[HOST_SIZE];
  uint16_t port;
  char path[BASE_SIZE + 16];
  char key[KEY_SIZE];
  uint16_t length;
  char body[REPORT_MAX];
};

struct Response {
  /** The HTTP status, or -1 when no answer came (refused, timed out, no route, name not found). */
  int status;
  uint16_t length;
  char body[ANSWER_MAX + 1];
};

/** Starts the task. */
bool begin();
/** Hands a request over; false if one is still queued (the loop only ever has one in flight). */
bool send(const Request& request);
/** The answer to the request in flight, once it has one. */
bool receive(Response& response);

}  // namespace cp::hub
