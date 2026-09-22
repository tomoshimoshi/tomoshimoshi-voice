// Requires a dedicated disposable native PostgreSQL database. Never loads .env.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import type Stripe from "stripe";
import { database, closeDatabase } from "../../server/database";
import { transaction } from "../../server/transaction";
import {
  ensureUser,
  saveProfile,
  defaultProfile,
  reserveCall,
} from "../../server/store";
import { credit, reserve } from "../../server/wallet";
import {
  processStripeEvent,
  checkout,
  walletSummary,
} from "../../server/billing/payments";
import { observeCallEvent } from "../../server/calls/billing";
import type {
  PaymentConfirmation,
  PaymentProvider,
} from "../../server/billing/provider";
import type { Call } from "../../lib/types";
const configured = process.env.BILLING_TEST_DATABASE_URL;
if (!configured)
  throw new Error(
    "BILLING_TEST_DATABASE_URL must point to a disposable local database named tomoshimoshi_billing_test",
  );
const url = new URL(configured);
if (
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  url.pathname !== "/tomoshimoshi_billing_test"
)
  throw new Error(
    "Use the dedicated local tomoshimoshi_billing_test database only",
  );
const admin = new pg.Client({ connectionString: configured });
await admin.connect();
const schema = `billing_test_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE SCHEMA ${schema}`);
await admin.query(`SET search_path TO ${schema}`);
const directory = new URL("../../db/migrations/", import.meta.url);
for (const name of (await readdir(directory)).sort())
  await admin.query(await readFile(new URL(name, directory), "utf8"));
url.searchParams.set("options", `-csearch_path=${schema}`);
process.env.DATABASE_URL = url.toString();
process.env.DATABASE_URL_POOLED = "";
Object.assign(process.env, {
  STRIPE_SECRET_KEY: "sk_test_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_fixture",
  STRIPE_PRICE_CREDIT_1000: "price_1000",
  STRIPE_PRICE_CREDIT_2000: "price_2000",
  STRIPE_PRICE_CREDIT_5000: "price_5000",
  APP_BASE_URL: "http://localhost:3000",
});
after(async () => {
  await closeDatabase();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
const id = await ensureUser({
  sub: "concurrent|fixture",
  email: "concurrent@example.test",
  emailVerified: true,
});
await saveProfile(
  { ...defaultProfile, firstName: "Concurrent", lastName: "Fixture" },
  id,
);
test("20 native PostgreSQL connections contend for one wallet without overdrawing", async () => {
  const wallet = await transaction((tx) =>
    credit(tx, id, 1000n, {
      type: "fixture",
      id: randomUUID(),
      key: randomUUID(),
    }),
  );
  const attempts = await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      transaction((tx) =>
        reserve(
          tx,
          wallet,
          800n,
          { type: "test", id: randomUUID(), key: randomUUID() },
          new Date(),
        ),
      ),
    ),
  );
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
  for (const x of attempts)
    if (x.status === "rejected")
      assert.match(String(x.reason), /INSUFFICIENT_CREDIT/);
  assert.equal((await walletSummary(id)).available, "200");
  assert.equal((await walletSummary(id)).reserved, "800");
});
test("simultaneous distinct Stripe events share a payment lock and credit once", async () => {
  let confirmation: PaymentConfirmation;
  const provider: PaymentProvider = {
    async createCheckout(p) {
      confirmation = {
        sessionId: `cs_${p.id}`,
        paymentId: `pi_${p.id}`,
        amount: 1000n,
        currency: "jpy",
        priceId: p.provider_price_id,
        quantity: 1,
        paid: true,
        metadata: {
          payment_id: p.id,
          user_id: id,
          package_code: p.package_code,
        },
      };
      return {
        id: confirmation.sessionId,
        url: "https://checkout.stripe.com/c/pay/test",
      };
    },
    async confirmation() {
      return confirmation;
    },
  };
  const payment = await checkout(id, "credit_1000", randomUUID(), provider);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      processStripeEvent(
        {
          id: `evt_${i}`,
          type: "checkout.session.completed",
          livemode: false,
          data: {
            object: {
              id: confirmation.sessionId,
              client_reference_id: payment.paymentId,
              payment_status: "paid",
              metadata: confirmation.metadata,
            },
          },
        } as unknown as Stripe.Event,
        provider,
      ),
    ),
  );
  assert.equal((await walletSummary(id)).available, "1200");
  assert.equal(
    (
      await database().query(
        "SELECT count(*)::int AS n FROM wallet_ledger WHERE reference_id=$1 AND entry_type='PURCHASE'",
        [payment.paymentId],
      )
    ).rows[0].n,
    1,
  );
});
test("simultaneous native call completions create a single charge and reconcile", async () => {
  const c: Call = {
    id: randomUUID(),
    phone: "+817012345678",
    objective: "Test",
    context: "",
    constraints: "",
    language: "ja",
    mode: "live",
    shareProfile: false,
    scenario: "inquiry",
    status: "dialing",
    createdAt: new Date(Date.now() - 120000).toISOString(),
    transcript: [],
    uiLanguage: "en",
  };
  await reserveCall(c, id, randomUUID());
  const end = new Date().toISOString();
  await observeCallEvent({
    callId: c.id,
    eventId: "answer",
    type: "call.answered",
    at: new Date(Date.parse(end) - 60000).toISOString(),
    controlId: "fixture",
  });
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      observeCallEvent({
        callId: c.id,
        eventId: `end_${i}`,
        type: "call.hangup",
        at: end,
        controlId: "fixture",
      }),
    ),
  );
  assert.equal((await walletSummary(id)).available, "1075");
  const result = await database().query(
    "SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id=$1 AND event_type='call.charged'",
    [c.id],
  );
  assert.equal(result.rows[0].n, 1);
});
