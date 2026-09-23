import { testDatabase } from "./helpers/postgres";
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { signIdentity } from "../lib/internal-identity";
// Provider credentials and dotenv loading are disabled for the whole process.
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.CALLORI_INTERNAL_TOKEN = "http-tests-secret-at-least-32-characters";
process.env.LIVE_CALLS_ENABLED = "false";
Object.assign(process.env, {
  STRIPE_SECRET_KEY: "sk_test_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_fixture",
  STRIPE_PRICE_CREDIT_1000: "price_1000",
  STRIPE_PRICE_CREDIT_2000: "price_2000",
  STRIPE_PRICE_CREDIT_5000: "price_5000",
  APP_BASE_URL: "http://localhost:3000",
});
for (const name of [
  "OPENAI_API_KEY",
  "TELNYX_API_KEY",
  "TELNYX_CONNECTION_ID",
  "TELNYX_FROM_NUMBER",
  "TELNYX_PUBLIC_KEY",
  "PUBLIC_BASE_URL",
  "ALLOWED_PHONE_NUMBERS",
])
  process.env[name] = "";
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = (probe.address() as { port: number }).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
// Exercise the Railway listener configuration with the real HTTP server.
process.env.PORT = String(port);
process.env.VOICE_PORT = "3001";
process.env.VOICE_HOST = "0.0.0.0";
// The worker lease has a dedicated client in production. The test database
// supports the real advisory lock SQL but uses an in-process transport.
mock.method(pg.Client.prototype, "connect", async () => {});
mock.method(pg.Client.prototype, "query", async (sql: string) =>
  testDatabase.query(sql),
);
mock.method(pg.Client.prototype, "end", async () => {});
const service = await import("../server/index");
after(() => service.shutdown());
const base = `http://127.0.0.1:${port}`;
function headers(sub: string, verified = true) {
  return {
    Authorization: `Bearer ${process.env.CALLORI_INTERNAL_TOKEN}`,
    "Content-Type": "application/json",
    "X-Callori-Identity": signIdentity({
      sub,
      email: `${sub}@example.test`,
      email_verified: verified,
    }),
  };
}
test("HTTP API rejects absent, unsigned and forged identities even with an internal token", async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  for (const path of [
    "state",
    "wallet",
    "billing/checkout",
    "billing/payments/00000000-0000-4000-8000-000000000000",
    "profile",
    "contacts",
    "calls",
    "maps-config",
  ]) {
    assert.equal((await fetch(`${base}/${path}`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/${path}`, {
          headers: {
            Authorization: headers("alice").Authorization,
            "X-User-Id": "alice",
          },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/${path}`, {
          headers: { ...headers("alice"), "X-Callori-Identity": "forged" },
        })
      ).status,
      401,
    );
  }
});
test("HTTP onboarding saves only the authenticated profile and enforces completion before dialing", async () => {
  const alice = headers("alice"),
    bob = headers("bob");
  const original = await (
    await fetch(`${base}/state`, { headers: alice })
  ).json();
  assert.equal(original.profile.firstName, "");
  const input = {
    phone: "+817012345678",
    objective: "Ask about opening hours",
    context: "",
    constraints: "",
    language: "ja",
    mode: "live",
    shareProfile: false,
    scenario: "inquiry",
  };
  const call = () =>
    fetch(`${base}/calls`, {
      method: "POST",
      headers: { ...alice, "Idempotency-Key": randomUUID() },
      body: JSON.stringify(input),
    });
  const incomplete = await call();
  assert.equal(incomplete.status, 409);
  assert.equal((await incomplete.json()).error, "PROFILE_REQUIRED");
  const personal = {
    ...original.profile,
    firstName: "Alice",
    lastName: "Example",
    uiLanguage: "ja",
  };
  assert.equal(
    (
      await fetch(`${base}/profile`, {
        method: "PUT",
        headers: alice,
        body: JSON.stringify({ ...personal, userId: "bob" }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${base}/profile`, {
        method: "PUT",
        headers: alice,
        body: JSON.stringify(personal),
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await fetch(`${base}/state`, { headers: alice })).json()).profile
      .uiLanguage,
    "ja",
  );
  assert.equal(
    (await (await fetch(`${base}/state`, { headers: bob })).json()).profile
      .firstName,
    "",
  );
  assert.equal((await (await call()).json()).error, "NOT_CONFIGURED");
  const unverified = await fetch(`${base}/calls`, {
    method: "POST",
    headers: {
      ...headers("unverified", false),
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(input),
  });
  assert.equal(unverified.status, 403);
  assert.equal((await unverified.json()).error, "EMAIL_UNVERIFIED");
  const knownId = randomUUID();
  const user = (
    await testDatabase.query<{ id: string }>(
      "SELECT id FROM users WHERE auth0_sub='alice'",
    )
  ).rows[0];
  const record = {
    ...input,
    id: knownId,
    status: "completed",
    createdAt: new Date().toISOString(),
    transcript: [],
    uiLanguage: "en",
  };
  await testDatabase.query(
    "INSERT INTO calls(id,user_id,status,created_at,data) VALUES($1,$2,'completed',$3,$4)",
    [knownId, user.id, record.createdAt, JSON.stringify(record)],
  );
  for (const suffix of ["", "/answer", "/cancel"]) {
    const response = await fetch(`${base}/calls/${knownId}${suffix}`, {
      method: suffix ? "POST" : "GET",
      headers: bob,
      ...(suffix ? { body: "{}" } : {}),
    });
    assert.equal(response.status, 404);
  }
  assert.equal(
    (await fetch(`${base}/calls/${knownId}`, { headers: alice })).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/profile`, {
        method: "PUT",
        headers: alice,
        body: "x".repeat(33000),
      })
    ).status,
    413,
  );
  assert.equal(
    (await fetch(`${base}/webhooks/telnyx`, { method: "POST", body: "{}" }))
      .status,
    401,
  );
});

test("billing HTTP boundary rejects unsigned webhooks and browser-supplied monetary fields", async () => {
  const bad = await fetch(`${base}/webhooks/stripe`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "INVALID_SIGNATURE");
  for (const extra of [
    { amount: 1 },
    { user_id: randomUUID() },
    { priceId: "price_forged" },
  ]) {
    const response = await fetch(`${base}/billing/checkout`, {
      method: "POST",
      headers: { ...headers("alice"), "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ packageCode: "credit_1000", ...extra }),
    });
    assert.equal(response.status, 400);
  }
  const wallet = await (
    await fetch(`${base}/wallet`, { headers: headers("alice") })
  ).json();
  assert.equal(wallet.available, "0");
  assert.deepEqual(
    wallet.packages.map((p: { amount: string }) => p.amount),
    ["1000", "2000", "5000"],
  );
});

test("malformed resource IDs are client errors rather than database failures", async () => {
  for (const path of ["calls", "billing/payments"]) {
    const response = await fetch(`${base}/${path}/${"-".repeat(36)}`, { headers: headers("alice") });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "INVALID_INPUT");
  }
});

test("exhausting the read quota leaves a separate budget for call controls", async () => {
  const identity = headers("quota-controls");
  for (let i = 0; i < 180; i++) {
    assert.equal((await fetch(`${base}/not-found`, { headers: identity })).status, 404);
  }
  const limited = await fetch(`${base}/state`, { headers: identity });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  for (const action of ["answer", "cancel"]) {
    const response = await fetch(`${base}/calls/${randomUUID()}/${action}`, {
      method: "POST", headers: identity, body: "{}",
    });
    // Owner lookup still executes: an absent call is 404, never a read-quota 429.
    assert.equal(response.status, 404);
  }
});
