import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupportService, supportSchema } from "../server/support";
import type { Call } from "../lib/types";

const callId = "10000000-0000-4000-8000-000000000001";
const input = { kind: "bug", message: "La llamada terminó sin respuesta.", locale: "es", callId };
const env = { SENDGRID_API_KEY: "test-only-key", SENDGRID_FROM_EMAIL: "contact@example.test" };
const call = {
  id: callId, status: "failed", mode: "demo", createdAt: "2026-09-24T00:00:00Z",
  phone: "+819012345678", transcript: [{ original: "private transcript" }],
} as Call;

test("support validates content and rejects recipient/identity overrides", () => {
  for (const bad of [
    { ...input, message: "   " }, { ...input, message: "a".repeat(5001) },
    { ...input, callId: "invalid" }, { ...input, locale: "fr" },
    { ...input, kind: "anything" }, { ...input, to: "attacker@example.test" },
    { ...input, email: "victim@example.test" },
  ]) assert.equal(supportSchema.safeParse(bad).success, false);
  assert.equal(supportSchema.parse({ ...input, message: "  Enough detail here  " }).message, "Enough detail here");
});

test("support sends only to the fixed inbox with trusted reply-to and owned call metadata", async () => {
  const logs: unknown[] = [];
  let requests = 0;
  const submit = createSupportService({
    env,
    getCall: async (id, userId) => { assert.equal(id, callId); assert.equal(userId, "alice"); return call; },
    fetch: async (url, options) => {
      requests++;
      assert.equal(url, "https://api.sendgrid.com/v3/mail/send");
      assert.equal(options?.redirect, "error");
      const payload = JSON.parse(String(options?.body));
      assert.deepEqual(payload.personalizations, [{ to: [{ email: "leodcastaneda@gmail.com" }] }]);
      assert.equal(payload.from.email, env.SENDGRID_FROM_EMAIL);
      assert.equal(payload.reply_to.email, "alice@example.test");
      assert.equal(payload.content[0].type, "text/plain");
      assert.match(payload.content[0].value, /Call status: failed/);
      assert.match(payload.content[0].value, /La llamada terminó/);
      assert.doesNotMatch(payload.content[0].value, /private transcript|819012345678/);
      return new Response(null, { status: 202 });
    },
    log: (event, data) => logs.push({ event, data }),
  });
  const result = await submit("alice", "alice@example.test", input);
  assert.equal(result.status, 202);
  assert.equal(result.data.queued, true);
  assert.ok(result.data.reportId);
  assert.equal(requests, 1);
  assert.doesNotMatch(JSON.stringify(logs), /test-only-key|La llamada|alice@example.test/);
});

test("support rejects unknown or unowned calls without sending", async () => {
  const submit = createSupportService({ env, getCall: async () => undefined,
    fetch: async () => { throw new Error("must not send"); } });
  assert.equal((await submit("bob", "bob@example.test", input)).status, 404);
});

test("support permits general contact and limits each account independently", async () => {
  let requests = 0;
  const submit = createSupportService({ env, getCall: async () => { throw new Error("no call lookup expected"); },
    fetch: async () => { requests++; return new Response(null, { status: 202 }); }, log: () => {} });
  const contact = { kind: "contact", message: "Tengo una pregunta sobre el servicio.", locale: "es" };
  for (let i = 0; i < 5; i++) assert.equal((await submit("alice", "a@example.test", contact)).status, 202);
  assert.equal((await submit("alice", "a@example.test", contact)).status, 429);
  assert.equal(requests, 5);
  assert.equal((await submit("bob", "b@example.test", contact)).status, 202);
});

test("support fails safely when configuration or SendGrid is unavailable; never retries", async () => {
  for (const config of [{}, { SENDGRID_API_KEY: "key" }, { ...env, SENDGRID_FROM_EMAIL: "invalid" }]) {
    const submit = createSupportService({ env: config, getCall: async () => undefined,
      fetch: async () => { assert.fail("must not send without configuration"); } });
    assert.equal((await submit("alice", "a@example.test", input)).data.error, "SUPPORT_NOT_CONFIGURED");
  }
  for (const status of [200, 400, 401, 403, 429, 500, 0]) {
    let requests = 0;
    const submit = createSupportService({ env, getCall: async () => call, log: () => {},
      fetch: async () => {
        requests++;
        if (!status) throw new Error("network timeout with sensitive details");
        return new Response("sensitive provider error", { status });
      } });
    assert.deepEqual(await submit("alice", "a@example.test", input), {
      status: 503, data: { error: "SUPPORT_UNAVAILABLE" },
    });
    assert.equal(requests, 1);
  }
});
