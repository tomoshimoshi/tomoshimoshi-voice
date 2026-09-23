import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../server/rate-limit";

test("API quotas isolate accounts, expire and bound memory without resetting active quotas", () => {
  const allow = createRateLimiter(2, 1000, 2);
  assert.equal(allow("alice", 0), true);
  assert.equal(allow("alice", 1), true);
  assert.equal(allow("alice", 2), false);
  assert.equal(allow("bob", 3), true);
  assert.equal(allow("carol", 4), false);
  assert.equal(allow("alice", 5), false);
  assert.equal(allow("carol", 1000), true);
  assert.equal(allow("bob", 1001), true);
  assert.equal(allow("bob", 1002), false);
  assert.equal(allow("bob", 1003), true);
});
