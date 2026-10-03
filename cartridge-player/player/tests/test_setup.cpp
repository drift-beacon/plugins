// The setup page's Connect (DESIGN.md "Setup page API"): how a posted form is read, which forms are accepted, when a
// saved secret may be reused, what the user is told when a step fails, and what /api/state says about it all.
#include "../src/core/setup.h"

#include <initializer_list>
#include <string>
#include <utility>

#include "check.h"

using namespace cp;

namespace {

Settings saved() {
  StoredValues stored;
  stored.ssid = "Home";
  stored.password = "hunter22";
  stored.host = "192.168.1.12";
  stored.port = 9001;
  stored.base = "/api/plugins/x/api";
  stored.key = "db_savedkey123";
  return settingsFrom(stored);
}

ConnectForm manual() {
  ConnectForm form;
  form.ssid = "Home";
  form.password = "hunter22";
  form.host = "192.168.1.12";
  form.port = "9001";
  form.base = "/api/plugins/x/api";
  form.key = "db_typedkey456";
  return form;
}

// CP1- + base64url({"h":"10.0.0.2","p":9001,"b":"/api/plugins/x/api"}) and the same with "k":"db_incode789".
const char* const CODE = "CP1-eyJoIjoiMTAuMC4wLjIiLCJwIjo5MDAxLCJiIjoiL2FwaS9wbHVnaW5zL3gvYXBpIn0";
const char* const CODE_WITH_KEY =
    "CP1-eyJoIjoiMTAuMC4wLjIiLCJwIjo5MDAxLCJiIjoiL2FwaS9wbHVnaW5zL3gvYXBpIiwiayI6ImRiX2luY29kZTc4OSJ9";

Answer answer(const char* body) {
  Answer out;
  readAnswer(body, std::strlen(body), out);
  return out;
}

const char* const PROBE_OK = R"({"ok":true,"player":"cartridge-player","protocol":2,"heartbeat_s":30})";

Attempt probing(const ConnectPlan& plan) {
  Attempt attempt;
  attempt.start(plan, 0);
  attempt.joined("192.168.1.57", 1000);
  attempt.probeStarted();
  return attempt;
}

/** The body of /api/state for a player with these settings and this Connect. */
std::string state(const Settings& settings, const Attempt& attempt, bool readerWorking = true) {
  const uint8_t mac[6] = {0x24, 0x58, 0x7C, 0xA1, 0xB2, 0xC3};
  static char out[4096];
  CHECK(writeSetupState(identityFrom(mac), readerWorking, "8f3a", settings, attempt, out, sizeof out) > 0);
  return out;
}

bool has(const std::string& body, const char* part) { return body.find(part) != std::string::npos; }

}  // namespace

int main() {
  check::run("a complete manual form is accepted", [] {
    const ConnectForm form = manual();
    ConnectPlan plan;
    Problem problem;
    CHECK(planConnect(form, Settings(), plan, problem));
    CHECK_TEXT(plan.hub.base, "/api/plugins/x/api");
    CHECK_TEXT(plan.hub.key, "db_typedkey456");
    CHECK(!plan.fromCode);
  });

  check::run("the saved password is kept only for the saved network", [] {
    ConnectForm form = manual();
    form.password = "";
    form.keepPassword = true;
    ConnectPlan plan;
    Problem problem;
    CHECK(planConnect(form, saved(), plan, problem));
    CHECK_TEXT(plan.password, "hunter22");
    form.ssid = "Neighbour";
    CHECK(!planConnect(form, saved(), plan, problem));
    CHECK(problem.field == Field::Password);
  });

  check::run("the saved key is kept only for the same host, port and base: it can't be sent elsewhere", [] {
    const auto keeping = [] {
      ConnectForm form = manual();
      form.password = "";
      form.keepPassword = true;
      form.key = "";
      form.keepKey = true;
      return form;
    };
    ConnectForm form = keeping();
    ConnectPlan plan;
    Problem problem;
    CHECK(planConnect(form, saved(), plan, problem));
    CHECK_TEXT(plan.hub.key, "db_savedkey123");
    const char* const otherHosts[] = {"10.0.0.66", "attacker.local"};
    for (const char* host : otherHosts) {
      form.host = host;
      CHECK(!planConnect(form, saved(), plan, problem));
      CHECK(problem.field == Field::Key);
      CHECK(std::strstr(problem.message, "same hub address") != nullptr);
    }
    form = keeping();
    form.port = "9002";
    CHECK(!planConnect(form, saved(), plan, problem));
    form.port = "9001";
    form.base = "/api/plugins/y/api";
    CHECK(!planConnect(form, saved(), plan, problem));
    CHECK(!planConnect(form, Settings(), plan, problem));
  });

  check::run("the saved key is kept only on the saved Wi-Fi: another network can't carry it off", [] {
    // On someone else's network the hub's address is someone else's machine.
    const auto keeping = [] {
      ConnectForm form = manual();
      form.key = "";
      form.keepKey = true;
      return form;
    };
    ConnectPlan plan;
    Problem problem;
    ConnectForm form = keeping();
    form.password = "";
    form.keepPassword = true;
    CHECK(planConnect(form, saved(), plan, problem));
    CHECK_TEXT(plan.hub.key, "db_savedkey123");

    const struct {
      const char* ssid;
      const char* password;
    } others[] = {{"EvilAP", "attacker-psk"}, {"EvilAP", ""}, {"Home", "another-password"}, {"Home", ""}};
    for (const auto& other : others) {
      form = keeping();
      form.ssid = other.ssid;
      form.password = other.password;
      CHECK(!planConnect(form, saved(), plan, problem));
      CHECK(problem.field == Field::Key);
      CHECK(std::strstr(problem.message, "saved Wi-Fi") != nullptr);
      CHECK_TEXT(plan.hub.key, "");
    }

    // The saved password typed out is refused like a wrong one, in the same words: were it accepted, the open page
    // would say at once whether a guess at the Wi-Fi password was right, as often as anyone cared to ask.
    form = keeping();
    form.password = "hunter22";
    CHECK(!planConnect(form, saved(), plan, problem));
    const std::string typedRight = problem.message;
    form.password = "another-password";
    CHECK(!planConnect(form, saved(), plan, problem));
    CHECK(problem.field == Field::Key);
    CHECK_TEXT(problem.message, typedRight.c_str());
    CHECK_TEXT(plan.hub.key, "");

    // A saved open network has no password to keep or to guess: blank is the same network.
    Settings open = saved();
    open.password[0] = '\0';
    form = keeping();
    form.password = "";
    CHECK(planConnect(form, open, plan, problem));
    CHECK_TEXT(plan.hub.key, "db_savedkey123");
    form.password = "hunter22";
    CHECK(!planConnect(form, open, plan, problem));

    // Typed again, the key goes wherever the person at the page sends it: that is theirs to decide.
    form = manual();
    form.ssid = "EvilAP";
    CHECK(planConnect(form, saved(), plan, problem));
    CHECK_TEXT(plan.hub.key, "db_typedkey456");

    // Nothing to keep: a hub saved without a usable key doesn't load, and there is then no key to send.
    StoredValues stored;
    stored.ssid = "Home";
    stored.password = "hunter22";
    stored.host = "192.168.1.12";
    stored.port = 9001;
    stored.base = "/api/plugins/x/api";
    CHECK(!planConnect(keeping(), settingsFrom(stored), plan, problem));
    CHECK(problem.field == Field::Key);
  });

  check::run("a network is saved on joining only while no key is saved; after that, only once the hub has answered", [] {
    Settings fresh;
    CHECK(savesWifiOnJoin(fresh));
    copyText(fresh.ssid, sizeof fresh.ssid, "Home");
    CHECK(savesWifiOnJoin(fresh));
    CHECK(!savesWifiOnJoin(saved()));

    ConnectPlan plan;
    Problem problem;
    planConnect(manual(), saved(), plan, problem);
    CHECK(onSavedNetwork(plan, saved()));
    CHECK(!onSavedNetwork(plan, Settings()));
    ConnectForm form = manual();
    form.password = "another-password";
    planConnect(form, saved(), plan, problem);
    CHECK(!onSavedNetwork(plan, saved()));
    form = manual();
    form.ssid = "Other";
    planConnect(form, saved(), plan, problem);
    CHECK(!onSavedNetwork(plan, saved()));
  });

  check::run("a setup code with a key needs nothing else; without one it needs a key", [] {
    ConnectForm form;
    form.ssid = "Home";
    form.password = "hunter22";
    form.code = CODE_WITH_KEY;
    ConnectPlan plan;
    Problem problem;
    CHECK(planConnect(form, Settings(), plan, problem));
    CHECK(plan.fromCode && plan.keyInCode);
    CHECK_TEXT(plan.hub.host, "10.0.0.2");
    CHECK_TEXT(plan.hub.key, "db_incode789");
    form.code = CODE;
    CHECK(!planConnect(form, Settings(), plan, problem));
    CHECK(problem.field == Field::Key);
    form.key = "db_typedkey456";
    CHECK(planConnect(form, Settings(), plan, problem));
    CHECK(plan.fromCode && !plan.keyInCode);
  });

  check::run("each refused field is named, Wi-Fi first", [] {
    struct Case {
      void (*edit)(ConnectForm&);
      Field field;
    };
    const Case cases[] = {
        {[](ConnectForm& f) { f.ssid = ""; }, Field::Ssid},
        {[](ConnectForm& f) { f.password = "short"; }, Field::Password},
        {[](ConnectForm& f) { f.host = "http://hub"; }, Field::Host},
        {[](ConnectForm& f) { f.port = "90a1"; }, Field::Port},
        {[](ConnectForm& f) { f.port = "70000"; }, Field::Port},
        {[](ConnectForm& f) { f.base = "/api/plugins/x/api/player"; }, Field::Base},
        {[](ConnectForm& f) { f.key = "db_ key"; }, Field::Key},
        {[](ConnectForm& f) { f.code = "CP1-garbage!"; }, Field::Code},
        {[](ConnectForm& f) {
           f.ssid = "";
           f.key = "";
         },
         Field::Ssid},
    };
    for (const Case& c : cases) {
      ConnectForm form = manual();
      c.edit(form);
      ConnectPlan plan;
      Problem problem;
      CHECK(!planConnect(form, Settings(), plan, problem));
      CHECK(problem.field == c.field);
      CHECK(problem.message[0] != '\0');
    }
  });

  check::run("a network gets two tries; the second failure lands on the right field: name or password", [] {
    ConnectPlan plan;
    Problem problem;
    planConnect(manual(), Settings(), plan, problem);
    const struct {
      uint16_t reason;
      Field field;
    } cases[] = {{201, Field::Ssid}, {202, Field::Password}, {15, Field::Password}, {204, Field::Password},
                 {211, Field::Password}, {205, Field::Ssid}};
    for (const auto& c : cases) {
      Attempt attempt;
      attempt.start(plan, 0);
      CHECK(attempt.joinDue(0));
      attempt.joinStarted();
      CHECK(!attempt.joinDue(60000));
      // The first failure is often a passing one (and the Wi-Fi core retries behind it): nothing is said yet.
      CHECK(!attempt.joinFailed(201, 1000));
      CHECK(attempt.phase() == Phase::Joining);
      CHECK_TEXT(attempt.message(), "");
      CHECK(!attempt.joinDue(1000 + Attempt::JOIN_RETRY_MS - 1));
      CHECK(attempt.joinDue(1000 + Attempt::JOIN_RETRY_MS));
      attempt.joinStarted();
      CHECK(attempt.joinFailed(c.reason, 3000));
      CHECK(attempt.phase() == Phase::Failed);
      CHECK(attempt.field() == c.field);
      CHECK(std::strstr(attempt.message(), "Home") != nullptr);
    }
  });

  check::run("one failed try and then an address: the Connect goes on to the hub", [] {
    ConnectPlan plan;
    Problem problem;
    planConnect(manual(), Settings(), plan, problem);
    Attempt attempt;
    attempt.start(plan, 0);
    attempt.joinStarted();
    CHECK(!attempt.joinFailed(2, 800));
    // The Wi-Fi core's own retry got there before ours was due.
    attempt.joined("192.168.1.57", 1000);
    CHECK(attempt.phase() == Phase::Probing);
    CHECK(!attempt.joinDue(5000));
    CHECK(attempt.probeDue(1000));
  });

  check::run("a radio that won't take the join is asked again every second, inside the 20 s", [] {
    ConnectPlan plan;
    Problem problem;
    planConnect(manual(), Settings(), plan, problem);
    Attempt attempt;
    attempt.start(plan, 0);
    CHECK(attempt.joinDue(0));
    attempt.joinRefused(0);
    CHECK(!attempt.joinDue(Attempt::JOIN_BUSY_MS - 1));
    CHECK(attempt.joinDue(Attempt::JOIN_BUSY_MS));
    attempt.joinRefused(Attempt::JOIN_BUSY_MS);
    CHECK(attempt.joinTimedOut(20000));
    CHECK(attempt.phase() == Phase::Failed && attempt.field() == Field::Ssid);
    // It never joined anything, so it doesn't claim the network gave no address.
    CHECK(std::strstr(attempt.message(), "address") == nullptr);
  });

  check::run("joining that never finishes fails after 20 s with a sentence: the last refusal, or no address", [] {
    ConnectPlan plan;
    Problem problem;
    planConnect(manual(), Settings(), plan, problem);
    Attempt attempt;
    attempt.start(plan, 0);
    attempt.joinStarted();
    CHECK(!attempt.joinTimedOut(19999));
    CHECK(attempt.joinTimedOut(20000));
    CHECK(attempt.phase() == Phase::Failed && attempt.field() == Field::Ssid);
    CHECK(std::strstr(attempt.message(), "no address") != nullptr);
    CHECK(!attempt.joinTimedOut(20001));

    Attempt refused;
    refused.start(plan, 0);
    refused.joinStarted();
    CHECK(!refused.joinFailed(202, 1000));
    refused.joinStarted();
    CHECK(refused.joinTimedOut(20000));
    CHECK(refused.field() == Field::Password);
  });

  check::run("the hub is saved only when the probe answers as this plugin", [] {
    ConnectPlan plan;
    Problem problem;
    planConnect(manual(), Settings(), plan, problem);
    Attempt attempt = probing(plan);
    CHECK(attempt.probeFinished(200, answer(PROBE_OK), 1100) == ProbeVerdict::Save);
    attempt.done(1100);
    CHECK(attempt.phase() == Phase::Done);
    CHECK_TEXT(attempt.ip(), "192.168.1.57");
    Attempt notOurs = probing(plan);
    CHECK(notOurs.probeFinished(200, answer(R"({"success":true})"), 1100) == ProbeVerdict::Failed);
    CHECK(notOurs.field() == Field::Base);
  });

  check::run("probe refusals name the field: key for 401/403, path for 404, host for no answer", [] {
    ConnectPlan plan;
    Problem problem;
    planConnect(manual(), Settings(), plan, problem);
    const struct {
      int status;
      Field field;
    } cases[] = {{401, Field::Key}, {403, Field::Key}, {404, Field::Base}, {500, Field::Host}};
    for (const auto& c : cases) {
      Attempt attempt = probing(plan);
      CHECK(attempt.probeFinished(c.status, Answer(), 1100) == ProbeVerdict::Failed);
      CHECK(attempt.field() == c.field);
    }
    Attempt attempt = probing(plan);
    for (int i = 0; i < Attempt::PROBE_TRIES - 1; ++i) {
      CHECK(attempt.probeFinished(-1, Answer(), 1100) == ProbeVerdict::Retry);
      CHECK(!attempt.probeDue(1100 + Attempt::PROBE_RETRY_MS - 1));
      CHECK(attempt.probeDue(1100 + Attempt::PROBE_RETRY_MS));
      attempt.probeStarted();
    }
    CHECK(attempt.probeFinished(-1, Answer(), 5000) == ProbeVerdict::Failed);
    CHECK(attempt.field() == Field::Host);
    CHECK(std::strstr(attempt.message(), "192.168.1.12:9001") != nullptr);
  });

  check::run("a restarting hub (503 with retry_ms) is waited for, up to 5 s a time", [] {
    ConnectPlan plan;
    Problem problem;
    planConnect(manual(), Settings(), plan, problem);
    Attempt attempt = probing(plan);
    const Answer busy = answer(R"({"ok":false,"v":2,"code":"retry","error":"Busy","retry_ms":9000})");
    CHECK(attempt.probeFinished(503, busy, 1000) == ProbeVerdict::Retry);
    CHECK(!attempt.probeDue(5999));
    CHECK(attempt.probeDue(6000));
  });

  check::run("hub problems from a setup code are shown on the code, unless the key was typed separately", [] {
    ConnectForm form;
    form.ssid = "Home";
    form.code = CODE;
    form.key = "db_typedkey456";
    ConnectPlan plan;
    Problem problem;
    CHECK(planConnect(form, Settings(), plan, problem));
    Attempt a = probing(plan);
    a.probeFinished(404, Answer(), 1100);
    CHECK(a.field() == Field::Code);
    Attempt b = probing(plan);
    b.probeFinished(401, Answer(), 1100);
    CHECK(b.field() == Field::Key);
    form.code = CODE_WITH_KEY;
    form.key = "";
    planConnect(form, Settings(), plan, problem);
    Attempt c = probing(plan);
    c.probeFinished(401, Answer(), 1100);
    CHECK(c.field() == Field::Code);
  });

  check::run("a network lost while the hub is being asked ends the Connect at once: no probe goes without it", [] {
    ConnectPlan plan;
    Problem problem;
    planConnect(manual(), Settings(), plan, problem);
    // Between probes, and with one out.
    for (bool out : {false, true}) {
      Attempt attempt;
      attempt.start(plan, 0);
      attempt.joined("192.168.1.57", 1000);
      if (out) attempt.probeStarted();
      CHECK(attempt.probeOut() == out);
      CHECK(attempt.linkLost());
      CHECK(attempt.phase() == Phase::Failed);
      CHECK(attempt.field() == Field::Ssid);
      CHECK_TEXT(attempt.message(), "Lost Home before the hub answered. Try again");
      CHECK(!attempt.active());
      // The tries it had left are gone with it, and the answer to a probe that was out is nobody's.
      CHECK(!attempt.probeOut());
      for (Millis later : {1000u, 2500u, 60000u}) CHECK(!attempt.probeDue(later));
      CHECK(!attempt.linkLost());
    }
    // A probe that failed is retried only while the attempt lives: the retry it was owed is not sent after the loss.
    Attempt retrying = probing(plan);
    CHECK(retrying.probeFinished(-1, Answer(), 1100) == ProbeVerdict::Retry);
    CHECK(retrying.probeDue(1100 + Attempt::PROBE_RETRY_MS));
    CHECK(retrying.linkLost());
    CHECK(!retrying.probeDue(1100 + Attempt::PROBE_RETRY_MS));
  });

  check::run("losing the network changes nothing while joining (that has its own tries), idle, done or failed", [] {
    ConnectPlan plan;
    Problem problem;
    planConnect(manual(), Settings(), plan, problem);
    Attempt idle;
    CHECK(!idle.linkLost() && idle.phase() == Phase::Idle);
    Attempt joining;
    joining.start(plan, 0);
    CHECK(!joining.linkLost() && joining.phase() == Phase::Joining && joining.joinDue(0));
    Attempt done = probing(plan);
    done.probeFinished(200, answer(PROBE_OK), 1100);
    done.done(1100);
    CHECK(!done.linkLost() && done.phase() == Phase::Done);
    Attempt failed = probing(plan);
    failed.probeFinished(401, Answer(), 1100);
    CHECK(!failed.linkLost());
    CHECK_TEXT(failed.message(), "The hub didn't accept this API key");
  });

  check::run("a new Connect doesn't take the answer to the last one's probe for its own", [] {
    ConnectPlan plan;
    Problem problem;
    planConnect(manual(), Settings(), plan, problem);
    Attempt attempt = probing(plan);
    CHECK(attempt.linkLost());
    // Started again and straight on to the hub (the player was back on its saved network) before that answer came.
    attempt.start(plan, 5000);
    attempt.joined("192.168.1.57", 5000);
    CHECK(!attempt.probeOut());
    CHECK(attempt.probeDue(5000));
    attempt.probeStarted();
    CHECK(attempt.probeOut());
  });

  check::run("each Connect gets a new id, and starting one clears the last result", [] {
    ConnectPlan plan;
    Problem problem;
    planConnect(manual(), Settings(), plan, problem);
    Attempt attempt;
    attempt.start(plan, 0);
    attempt.joinFailed(201, 0);
    attempt.joinFailed(201, 1000);
    CHECK(attempt.phase() == Phase::Failed);
    const uint32_t first = attempt.id();
    attempt.start(plan, 2000);
    CHECK(attempt.id() == first + 1);
    CHECK(attempt.phase() == Phase::Joining);
    CHECK(attempt.field() == Field::None);
    CHECK_TEXT(attempt.message(), "");
    // The new Connect's two tries are its own.
    CHECK(!attempt.joinFailed(201, 3000));
  });

  check::run("entering setup mode again forgets the last result, done or failed, but not the id", [] {
    ConnectPlan plan;
    Problem problem;
    planConnect(manual(), Settings(), plan, problem);
    Attempt done = probing(plan);
    done.probeFinished(200, answer(PROBE_OK), 1100);
    done.done(1100);
    const uint32_t id = done.id();
    done.reset();
    CHECK(done.phase() == Phase::Idle);
    CHECK_TEXT(done.ip(), "");
    CHECK(done.id() == id);
    CHECK_TEXT(done.plan().hub.key, "");

    Attempt failed = probing(plan);
    failed.probeFinished(401, Answer(), 1100);
    failed.reset();
    CHECK(failed.phase() == Phase::Idle);
    CHECK(failed.field() == Field::None);
    CHECK_TEXT(failed.message(), "");
    CHECK(!failed.active() && !failed.joinDue(5000) && !failed.probeDue(5000));
  });

  check::run("a posted form is read under the page's field names, each to its own field", [] {
    ConnectFields fields;
    const char* const values[] = {"Home", "hunter22", "1", CODE, "192.168.1.12", "9001", "/api/plugins/x/api",
                                  "db_typedkey456", "1"};
    size_t count = 0;
    for (const char* name : CONNECT_FIELD_NAMES) CHECK(setConnectField(fields, name, values[count++]));
    CHECK(count == sizeof values / sizeof values[0]);
    const ConnectForm form = fields.form();
    CHECK_TEXT(form.ssid, "Home");
    CHECK_TEXT(form.password, "hunter22");
    CHECK(form.keepPassword);
    CHECK_TEXT(form.code, CODE);
    CHECK_TEXT(form.host, "192.168.1.12");
    CHECK_TEXT(form.port, "9001");
    CHECK_TEXT(form.base, "/api/plugins/x/api");
    CHECK_TEXT(form.key, "db_typedkey456");
    CHECK(form.keepKey);
    // Names are exact, and one the form doesn't have changes nothing.
    CHECK(!setConnectField(fields, "SSID", "Other"));
    CHECK(!setConnectField(fields, "keepkey", "0"));
    CHECK(!setConnectField(fields, "", "x"));
    CHECK_TEXT(fields.form().ssid, "Home");
    CHECK(fields.form().keepKey);
  });

  check::run("a field the page leaves out is empty, and a keep flag is set by exactly \"1\"", [] {
    ConnectFields fields;
    const ConnectForm untouched = fields.form();
    CHECK_TEXT(untouched.ssid, "");
    CHECK_TEXT(untouched.code, "");
    CHECK_TEXT(untouched.key, "");
    CHECK(!untouched.keepPassword && !untouched.keepKey);
    for (const char* value : {"true", "on", "yes", "01", "1 ", "", "0"}) {
      setConnectField(fields, "keepPassword", value);
      setConnectField(fields, "keepKey", value);
      CHECK(!fields.keepPassword && !fields.keepKey);
    }
    setConnectField(fields, "keepPassword", "1");
    setConnectField(fields, "keepKey", "1");
    CHECK(fields.keepPassword && fields.keepKey);
    setConnectField(fields, "keepKey", "");
    setConnectField(fields, "ssid", "Home");
    setConnectField(fields, "ssid", "");
    CHECK(!fields.keepKey);
    CHECK_TEXT(fields.ssid, "");
  });

  check::run("a form is read from its own request alone: nothing of the form before it stays", [] {
    using Pair = std::pair<const char*, const char*>;
    const auto request = [](std::initializer_list<Pair> pairs) {
      return [pairs](auto&& take) {
        for (const Pair& pair : pairs) take(pair.first, pair.second);
      };
    };
    ConnectFields fields;
    readConnectFields(fields, request({{"ssid", "EvilAP"}, {"password", "attacker-psk"}, {"host", "10.0.0.66"},
                                       {"port", "80"}, {"base", "/api/plugins/y/api"}, {"key", "db_theirkey000"},
                                       {"code", CODE_WITH_KEY}, {"keepKey", "1"}, {"keepPassword", "1"}}));
    CHECK_TEXT(fields.ssid, "EvilAP");
    CHECK(fields.keepKey && fields.keepPassword);
    // The next request carries less: what it leaves out is empty, not what the last one said.
    readConnectFields(fields, request({{"ssid", "Home"}, {"unheard-of", "x"}, {"confirm", "erase"}}));
    const ConnectForm form = fields.form();
    CHECK_TEXT(form.ssid, "Home");
    CHECK_TEXT(form.password, "");
    CHECK_TEXT(form.code, "");
    CHECK_TEXT(form.host, "");
    CHECK_TEXT(form.port, "");
    CHECK_TEXT(form.base, "");
    CHECK_TEXT(form.key, "");
    CHECK(!form.keepKey && !form.keepPassword);
    // A request with no fields at all is an empty form, and of a name sent twice the last counts.
    readConnectFields(fields, request({}));
    CHECK_TEXT(fields.ssid, "");
    readConnectFields(fields, request({{"ssid", "First"}, {"keepKey", "1"}, {"ssid", "Second"}, {"keepKey", "0"}}));
    CHECK_TEXT(fields.ssid, "Second");
    CHECK(!fields.keepKey);

    CHECK(confirmsErase(request({{"confirm", "erase"}})));
    CHECK(confirmsErase(request({{"ssid", "Home"}, {"confirm", "erase"}})));
    for (const char* value : {"", "Erase", "erase ", "1", "yes"}) CHECK(!confirmsErase(request({{"confirm", value}})));
    CHECK(!confirmsErase(request({})));
    CHECK(!confirmsErase(request({{"Confirm", "erase"}, {"erase", "confirm"}})));
    CHECK(!confirmsErase(request({{"confirm", "erase"}, {"confirm", "no"}})));
  });

  check::run("only a urlencoded body is a form; a multipart one is never read", [] {
    CHECK(isFormBody("application/x-www-form-urlencoded"));
    CHECK(isFormBody("application/x-www-form-urlencoded; charset=UTF-8"));
    for (const char* type : {"multipart/form-data; boundary=x", "multipart/mixed", "text/plain", "application/json", "",
                             " application/x-www-form-urlencoded", "Application/X-WWW-Form-Urlencoded",
                             "application/x-www-form", "multipart/form-data; boundary=application/x-www-form-urlencoded"}) {
      CHECK(!isFormBody(type));
    }
  });

  check::run("an overlong field is cut where its rule still refuses it, never to something that fits", [] {
    const std::string longText(3000, 'a');
    ConnectFields fields;
    for (const char* name : CONNECT_FIELD_NAMES) setConnectField(fields, name, longText.c_str());
    CHECK(ssidError(fields.ssid) != nullptr);
    CHECK(passwordError(fields.password) != nullptr);
    CHECK(hostError(fields.host) != nullptr);
    uint16_t port = 0;
    setConnectField(fields, "port", "00090019");
    CHECK(portTextError(fields.port, port) != nullptr);
    CHECK(keyError(fields.key) != nullptr);
    const std::string longBase = "/api/plugins/" + longText + "/api";
    setConnectField(fields, "base", longBase.c_str());
    CHECK(baseError(fields.base) != nullptr);
    // A code is cut past the longest one there can be, so what is left of a longer one isn't a whole code either.
    CHECK(std::strlen(fields.code) > SETUP_CODE_MAX);
    // The longest values the rules allow still fit whole.
    const std::string ssid(32, 's');
    const std::string password(64, 'f');
    const std::string key(256, 'k');
    setConnectField(fields, "ssid", ssid.c_str());
    setConnectField(fields, "password", password.c_str());
    setConnectField(fields, "key", key.c_str());
    CHECK(!ssidError(fields.ssid) && !passwordError(fields.password) && !keyError(fields.key));
  });

  check::run("/api/state: the player, what is saved (secrets only as \"there is one\") and an idle Connect", [] {
    const std::string body = state(saved(), Attempt());
    const std::string expected =
        std::string(R"({"device":{"id":"cp-a1b2c3","name":"Cartridge-A1B2","fw":")") + FIRMWARE_VERSION +
        R"(","reader":"ok"},"token":"8f3a","configured":true,)"
        R"("saved":{"ssid":"Home","hasPassword":true,"host":"192.168.1.12","port":9001,)"
        R"("base":"/api/plugins/x/api","hasKey":true},)"
        R"("attempt":{"id":0,"phase":"idle","message":"","field":null,"ip":null,"ssid":null}})";
    CHECK_TEXT(body.c_str(), expected.c_str());
    CHECK(!has(body, "hunter22") && !has(body, "db_savedkey123"));
    CHECK(has(state(saved(), Attempt(), false), R"("reader":"fault")"));
  });

  check::run("/api/state: nothing saved is null, and Wi-Fi saved by a first setup shows without a hub", [] {
    CHECK(has(state(Settings(), Attempt()), R"("configured":false,"saved":null,)"));
    Settings wifiOnly;
    copyText(wifiOnly.ssid, sizeof wifiOnly.ssid, "Home");
    CHECK(has(state(wifiOnly, Attempt()),
              R"("configured":false,"saved":{"ssid":"Home","hasPassword":false,"host":null,"port":null,"base":null,"hasKey":false},)"));
  });

  check::run("/api/state: the attempt names its own network while it runs and after, and none once setup reopens", [] {
    ConnectForm form = manual();
    form.ssid = "Office";
    ConnectPlan plan;
    Problem problem;
    CHECK(planConnect(form, saved(), plan, problem));
    Attempt attempt;
    attempt.start(plan, 0);
    // Not the saved network (Home), and never the password or the key that came with it.
    std::string body = state(saved(), attempt);
    CHECK(has(body, R"("attempt":{"id":1,"phase":"joining","message":"","field":null,"ip":null,"ssid":"Office"}})"));
    CHECK(!has(body, "db_typedkey456"));
    attempt.joined("192.168.1.57", 1000);
    CHECK(has(state(saved(), attempt), R"("phase":"probing","message":"","field":null,"ip":"192.168.1.57","ssid":"Office"}})"));
    attempt.probeStarted();
    attempt.probeFinished(401, Answer(), 1100);
    body = state(saved(), attempt);
    CHECK(has(body, R"("phase":"failed","message":"The hub didn't accept this API key","field":"key",)"));
    CHECK(has(body, R"("ssid":"Office"}})"));
    attempt.reset();
    CHECK(has(state(saved(), attempt), R"("attempt":{"id":1,"phase":"idle","message":"","field":null,"ip":null,"ssid":null}})"));
  });

  return check::result();
}
