import { test } from "node:test";
import assert from "node:assert/strict";
import { hangupReason } from "../server/calls/end-reason";

test("recipient rejection requires evidence beyond a carrier rejection", () => {
  assert.equal(hangupReason({ cause: "call_rejected", source: "callee", sipCause: "603" }, false), "RECIPIENT_REJECTED");
  assert.equal(hangupReason({ cause: "call_rejected", source: "unknown", sipCause: "403" }, false), "CALL_REJECTED");
  assert.equal(hangupReason({ sipCause: "603" }, false), "RECIPIENT_REJECTED");
  assert.equal(hangupReason({ cause: "user_busy", sipCause: "486" }, false), "RECIPIENT_BUSY");
});
test("hangup attribution requires a connected call and a callee source", () => {
  assert.equal(hangupReason({ cause: "normal_clearing", source: "callee" }, true), "RECIPIENT_HUNG_UP");
  assert.equal(hangupReason({ cause: "normal_clearing", source: "caller" }, true), "CALL_ENDED_UNKNOWN");
  assert.equal(hangupReason({ cause: "normal_clearing", source: "callee" }, false), "CALL_ENDED_UNKNOWN");
  assert.equal(hangupReason({ cause: "unspecified" }, true), "CALL_ENDED_UNKNOWN");
});
test("unanswered, unreachable and time-limited calls have distinct reasons", () => {
  assert.equal(hangupReason({ cause: "no_answer" }, false), "NO_ANSWER");
  assert.equal(hangupReason({ cause: "timeout" }, false), "NO_ANSWER");
  assert.equal(hangupReason({ cause: "timeout" }, true), "CALL_ENDED_UNKNOWN");
  assert.equal(hangupReason({ sipCause: "404" }, false), "NUMBER_UNREACHABLE");
  assert.equal(hangupReason({ cause: "time_limit" }, true), "TIME_LIMIT");
});
