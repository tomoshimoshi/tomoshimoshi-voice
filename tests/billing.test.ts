import { testDatabase } from "./helpers/postgres";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import {
  ensureUser,
  reserveCall,
  saveProfile,
  defaultProfile,
  getCall,
} from "../server/store";
import { transaction } from "../server/transaction";
import { credit, reserve, capture, release, refund } from "../server/wallet";
import { chargeForSeconds, affordableSeconds } from "../server/pricing";
import {
  checkout,
  processStripeEvent,
  walletSummary,
  paymentStatus,
  checkoutInput,
} from "../server/billing/payments";
import { observeCallEvent, reconcileCall } from "../server/calls/billing";
import { verifiedStripeEvent, stripeAdapter } from "../server/billing/stripe";
import { stripeConfig } from "../server/billing/stripe/config";
import type {
  PaymentProvider,
  PaymentConfirmation,
} from "../server/billing/provider";
import type { Call } from "../lib/types";
Object.assign(process.env, {
  STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: "sk_test_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_fixture",
  STRIPE_PRICE_CREDIT_1000: "price_1000",
  STRIPE_PRICE_CREDIT_2000: "price_2000",
  STRIPE_PRICE_CREDIT_5000: "price_5000",
  APP_BASE_URL: "http://localhost:3000",
});
const confirmations = new Map<string, PaymentConfirmation>();
const provider: PaymentProvider = {
  async createCheckout(p) {
    const id = `cs_test_${p.id}`;
    confirmations.set(id, {
      sessionId: id,
      paymentId: `pi_${p.id}`,
      amount: BigInt(p.amount),
      currency: "jpy",
      priceId: p.provider_price_id,
      quantity: 1,
      paid: true,
      metadata: {
        payment_id: p.id,
        user_id: p.user_id,
        package_code: p.package_code,
      },
    });
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  },
  async confirmation(id) {
    const c = confirmations.get(id);
    if (!c) throw new Error("NOT_FOUND");
    return c;
  },
};

test("checkout quota is durable, account-scoped and preserves retries at the limit", async () => {
  const id = await user();
  const key = randomUUID();
  const original = await checkout(id, "credit_1000", key, provider);
  await Promise.all(Array.from({ length: 9 }, () => checkout(id, "credit_1000", randomUUID(), provider)));
  await assert.rejects(checkout(id, "credit_1000", randomUUID(), provider), /CHECKOUT_RATE_LIMIT/);
  assert.deepEqual(await checkout(id, "credit_1000", key, provider), original);
  await assert.rejects(checkout(id, "credit_2000", key, provider), /IDEMPOTENCY_CONFLICT/);
  await checkout(await user(), "credit_1000", randomUUID(), provider);
  const oldUser = await user();
  await testDatabase.query(`INSERT INTO payments(id,user_id,provider,provider_price_id,amount,currency,package_code,request_key,livemode,created_at)
    SELECT gen_random_uuid(),$1,'stripe','price_1000',1000,'JPY','credit_1000',gen_random_uuid(),false,now()-interval '31 minutes'
    FROM generate_series(1,10)`, [oldUser]);
  await checkout(oldUser, "credit_1000", randomUUID(), provider);
});
async function user() {
  const id = await ensureUser({
    sub: `test|${randomUUID()}`,
    email: "billing@example.test",
    emailVerified: true,
  });
  await saveProfile(
    { ...defaultProfile, firstName: "Billing", lastName: "Fixture" },
    id,
  );
  return id;
}
async function fund(id: string, amount = 1000n) {
  return transaction((tx) =>
    credit(tx, id, amount, {
      type: "fixture",
      id: randomUUID(),
      key: randomUUID(),
    }),
  );
}
async function balance(id: string) {
  return walletSummary(id);
}
function event(
  paymentId: string,
  type = "checkout.session.completed",
  id = `evt_${randomUUID()}`,
): Stripe.Event {
  const sessionId = `cs_test_${paymentId}`,
    confirmation = confirmations.get(sessionId)!;
  return {
    id,
    type,
    livemode: false,
    data: {
      object: {
        id: sessionId,
        metadata: confirmation.metadata,
        client_reference_id: paymentId,
        payment_status: "paid",
      },
    },
  } as unknown as Stripe.Event;
}
function call(): Call {
  return {
    id: randomUUID(),
    phone: "+817012345678",
    objective: "Ask opening hours",
    context: "",
    constraints: "",
    language: "ja",
    mode: "live",
    shareProfile: false,
    scenario: "inquiry",
    status: "dialing",
    createdAt: new Date(Date.now() - 1000000).toISOString(),
    transcript: [],
    uiLanguage: "en",
  };
}
async function authorized(amount = 1000n) {
  const id = await user();
  await fund(id, amount);
  const c = call();
  await reserveCall(c, id, randomUUID());
  return { userId: id, call: c };
}
for (const amount of [1000, 2000, 5000] as const)
  test(`¥${amount} purchase credits exactly ¥${amount} with transactional outbox`, async () => {
    const id = await user(),
      p = await checkout(id, `credit_${amount}`, randomUUID(), provider);
    assert.equal((await balance(id)).available, "0");
    await processStripeEvent(event(p.paymentId), provider);
    assert.equal((await balance(id)).available, String(amount));
    assert.equal((await paymentStatus(id, p.paymentId)).status, "succeeded");
    const out = await testDatabase.query(
      "SELECT * FROM outbox_events WHERE aggregate_id=$1",
      [p.paymentId],
    );
    assert.equal(out.rows.length, 1);
  });
test("duplicate events, distinct success events and concurrent deliveries credit only once", async () => {
  const id = await user(),
    p = await checkout(id, "credit_1000", randomUUID(), provider),
    e = event(p.paymentId);
  await Promise.all([
    processStripeEvent(e, provider),
    processStripeEvent(e, provider),
    processStripeEvent(
      event(p.paymentId, "checkout.session.async_payment_succeeded"),
      provider,
    ),
  ]);
  assert.equal((await balance(id)).available, "1000");
  assert.equal(
    (
      await testDatabase.query(
        "SELECT * FROM wallet_ledger WHERE reference_id=$1",
        [p.paymentId],
      )
    ).rows.length,
    1,
  );
  await processStripeEvent(
    event(p.paymentId, "checkout.session.expired"),
    provider,
  );
  assert.equal((await paymentStatus(id, p.paymentId)).status, "succeeded");
});
for (const mutation of [
  "amount",
  "price",
  "currency",
  "user",
  "quantity",
  "unpaid",
  "provider-id",
] as const)
  test(`rejects invalid Stripe ${mutation} without financial side effects`, async () => {
    const id = await user(),
      p = await checkout(id, "credit_2000", randomUUID(), provider),
      e = event(p.paymentId);
    const c = confirmations.get(`cs_test_${p.paymentId}`)!;
    if (mutation === "amount") c.amount = 1999n;
    if (mutation === "price") c.priceId = "price_unsupported";
    if (mutation === "currency") c.currency = "usd";
    if (mutation === "user")
      c.metadata = { ...c.metadata, user_id: randomUUID() };
    if (mutation === "quantity") c.quantity = 2;
    if (mutation === "unpaid") c.paid = false;
    if (mutation === "provider-id") {
      await testDatabase.query(
        "UPDATE payments SET provider_payment_id='pi_original' WHERE id=$1",
        [p.paymentId],
      );
    }
    await assert.rejects(processStripeEvent(e, provider));
    assert.equal((await balance(id)).available, "0");
    assert.equal(
      (
        await testDatabase.query(
          "SELECT * FROM billing_provider_events WHERE event_id=$1",
          [e.id],
        )
      ).rows.length,
      0,
    );
  });
test("unpaid completed event stays pending; delayed success after failure still credits", async () => {
  const id = await user(),
    p = await checkout(id, "credit_1000", randomUUID(), provider),
    e = event(p.paymentId);
  (e.data.object as Stripe.Checkout.Session).payment_status = "unpaid";
  await processStripeEvent(e, provider);
  assert.equal((await balance(id)).available, "0");
  await processStripeEvent(
    event(p.paymentId, "checkout.session.async_payment_failed"),
    provider,
  );
  await processStripeEvent(
    event(p.paymentId, "checkout.session.async_payment_succeeded"),
    provider,
  );
  assert.equal((await balance(id)).available, "1000");
});
test("invalid/stale signatures are rejected and valid raw-body signature is accepted", () => {
  const raw = JSON.stringify({
    id: "evt_signed",
    object: "event",
    livemode: false,
    type: "ignored",
    data: { object: {} },
  });
  assert.throws(() => verifiedStripeEvent(raw, "t=1,v1=invalid"));
  const stripe = new Stripe("sk_test_fixture");
  const header = stripe.webhooks.generateTestHeaderString({
    payload: raw,
    secret: "whsec_fixture",
  });
  assert.equal(verifiedStripeEvent(raw, header).id, "evt_signed");
  assert.throws(() => verifiedStripeEvent(raw + " ", header));
  assert.throws(() =>
    verifiedStripeEvent(
      raw,
      stripe.webhooks.generateTestHeaderString({
        payload: raw,
        secret: "whsec_fixture",
        timestamp: 1,
      }),
    ),
  );
});
test("missing configuration and live keys fail clearly; browser cannot choose financial fields", () => {
  const prior = process.env.STRIPE_PRICE_CREDIT_1000;
  delete process.env.STRIPE_PRICE_CREDIT_1000;
  try {
    assert.throws(stripeConfig, /STRIPE_PRICE_CREDIT_1000/);
  } finally {
    process.env.STRIPE_PRICE_CREDIT_1000 = prior;
  }
  const secret = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_live_prohibited";
  try {
    assert.throws(stripeConfig, /test secret or restricted key/);
  } finally {
    process.env.STRIPE_SECRET_KEY = secret;
  }
  for (const field of [
    "user_id",
    "amount",
    "currency",
    "priceId",
    "rate",
    "balance",
  ])
    assert.equal(
      checkoutInput.safeParse({ packageCode: "credit_1000", [field]: "forged" })
        .success,
      false,
    );
});
test("Checkout retry reuses internal payment and package; payment status is owner-scoped", async () => {
  const id = await user(),
    key = randomUUID();
  const [a, b] = await Promise.all([
    checkout(id, "credit_1000", key, provider),
    checkout(id, "credit_1000", key, provider),
  ]);
  assert.equal(a.paymentId, b.paymentId);
  await assert.rejects(
    checkout(id, "credit_2000", key, provider),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.equal(await paymentStatus(await user(), a.paymentId), undefined);
});
test("database failure rolls back payment, event, ledger, balance and outbox; retry succeeds", async () => {
  const id = await user(),
    p = await checkout(id, "credit_1000", randomUUID(), provider),
    e = event(p.paymentId);
  await testDatabase.exec(
    "CREATE FUNCTION reject_outbox_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER outbox_failure_test BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION reject_outbox_test();",
  );
  try {
    await assert.rejects(processStripeEvent(e, provider), /injected failure/);
  } finally {
    await testDatabase.exec(
      "DROP TRIGGER outbox_failure_test ON outbox_events; DROP FUNCTION reject_outbox_test();",
    );
  }
  assert.equal((await balance(id)).available, "0");
  assert.equal((await paymentStatus(id, p.paymentId)).status, "pending");
  await processStripeEvent(e, provider);
  assert.equal((await balance(id)).available, "1000");
});
test("concurrent reservations cannot spend the same available credit twice", async () => {
  const id = await user(),
    wallet = await fund(id);
  const take = () =>
    transaction((tx) =>
      reserve(
        tx,
        wallet,
        800n,
        { type: "test", id: randomUUID(), key: randomUUID() },
        new Date(),
      ),
    );
  const attempts = await Promise.allSettled([take(), take()]);
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
  const w = await balance(id);
  assert.equal(w.available, "200");
  assert.equal(w.reserved, "800");
});
test("reservation, capture, partial release, refund and retries reconcile exactly", async () => {
  const id = await user(),
    wallet = await fund(id);
  const reservation = await transaction((tx) =>
    reserve(
      tx,
      wallet,
      800n,
      { type: "test", id: randomUUID(), key: randomUUID() },
      new Date(),
    ),
  );
  assert.equal((await balance(id)).reserved, "800");
  await transaction((tx) => capture(tx, reservation, 125n, "capture-fixture"));
  await transaction((tx) => capture(tx, reservation, 125n, "capture-fixture"));
  await transaction((tx) => release(tx, reservation, 675n, "release-fixture"));
  await transaction((tx) => release(tx, reservation, 675n, "release-fixture"));
  assert.equal((await balance(id)).available, "875");
  assert.equal((await balance(id)).reserved, "0");
  const entry = (
    await testDatabase.query<{ id: string }>(
      "SELECT id FROM wallet_ledger WHERE idempotency_key='capture-fixture'",
    )
  ).rows[0];
  await transaction((tx) => refund(tx, entry.id, 125n, "refund-fixture"));
  await transaction((tx) => refund(tx, entry.id, 125n, "refund-fixture"));
  await assert.rejects(
    transaction((tx) => refund(tx, entry.id, 1n, "excess-refund")),
    /REFUND_EXCEEDED/,
  );
  assert.equal((await balance(id)).available, "1000");
  const ledger = await testDatabase.query<{ a: string; r: string }>(
    "SELECT sum(available_delta)::text AS a,sum(reserved_delta)::text AS r FROM wallet_ledger WHERE wallet_id=$1",
    [wallet],
  );
  assert.deepEqual(ledger.rows[0], { a: "1000", r: "0" });
  await assert.rejects(
    transaction(async (tx) => {
      await tx.query("UPDATE wallets SET available_balance=42 WHERE id=$1", [
        wallet,
      ]);
    }),
    /does not reconcile/,
  );
  await assert.rejects(
    testDatabase.query("DELETE FROM wallet_ledger WHERE wallet_id=$1", [
      wallet,
    ]),
    /immutable/,
  );
  await assert.rejects(
    testDatabase.query("UPDATE wallet_ledger SET amount=1 WHERE wallet_id=$1", [
      wallet,
    ]),
    /immutable/,
  );
});
for (const [seconds, expected] of [
  [0, 0],
  [1, 3],
  [60, 125],
  [120, 250],
  [348, 725],
])
  test(`${seconds} connected seconds costs ¥${expected}`, () =>
    assert.equal(chargeForSeconds(seconds, 125n), BigInt(expected)));
test("integer budget duration never authorizes more than available credit", () => {
  for (let yen = 0n; yen < 6000n; yen++)
    assert.ok(
      chargeForSeconds(Number(affordableSeconds(yen, 125n)), 125n) <= yen,
    );
});
test("duplicate and out-of-order call completion captures once using persisted pricing", async () => {
  const { userId, call: c } = await authorized();
  assert.equal(c.billing?.pricingVersionId, "japan-domestic-v1");
  assert.equal(c.billing?.maxDurationSeconds, 480);
  const endedAt = new Date(Date.now() - 1000).toISOString(),
    connectedAt = new Date(Date.parse(endedAt) - 348000).toISOString();
  const ended = {
    callId: c.id,
    eventId: randomUUID(),
    type: "call.hangup",
    at: endedAt,
    controlId: "control",
  };
  await observeCallEvent(ended);
  assert.equal((await balance(userId)).reserved, "1000");
  await observeCallEvent({
    callId: c.id,
    eventId: randomUUID(),
    type: "call.answered",
    at: connectedAt,
    controlId: "control",
  });
  await Promise.all([
    observeCallEvent(ended),
    observeCallEvent({ ...ended, eventId: randomUUID() }),
  ]);
  const saved = await getCall(c.id);
  assert.equal(saved?.billing?.customerChargeJpy, "725");
  assert.equal(saved?.billing?.durationSeconds, 348);
  assert.equal((await balance(userId)).available, "275");
  assert.equal((await balance(userId)).reserved, "0");
  assert.equal(
    (
      await testDatabase.query(
        "SELECT * FROM outbox_events WHERE event_type='call.charged' AND aggregate_id=$1",
        [c.id],
      )
    ).rows.length,
    1,
  );
  await assert.rejects(
    testDatabase.query(
      "UPDATE call_billing SET customer_charge_jpy=0 WHERE call_id=$1",
      [c.id],
    ),
    /immutable/,
  );
});
test("old calls retain their rate when active pricing changes", async () => {
  const { userId, call: c } = await authorized();
  await testDatabase.exec(
    "UPDATE pricing_versions SET active=false WHERE id='japan-domestic-v1'; INSERT INTO pricing_versions(id,destination,currency,rate_per_minute,active) VALUES('japan-domestic-v2','JP','JPY',200,true);",
  );
  try {
    assert.equal((await walletSummary(userId)).pricing.ratePerMinute, "200");
    const end = new Date().toISOString(),
      start = new Date(Date.parse(end) - 60000).toISOString();
    await reconcileCall({
      callId: c.id,
      connectedAt: start,
      endedAt: end,
      evidence: "fixture-provider-record-v1",
    });
    assert.equal((await getCall(c.id))?.billing?.customerChargeJpy, "125");
    await assert.rejects(
      testDatabase.query(
        "UPDATE pricing_versions SET rate_per_minute=300 WHERE id='japan-domestic-v1'",
      ),
      /immutable/,
    );
  } finally {
    await testDatabase.exec(
      "UPDATE pricing_versions SET active=false WHERE id='japan-domestic-v2'; UPDATE pricing_versions SET active=true WHERE id='japan-domestic-v1';",
    );
  }
});
test("confirmed unanswered call releases all credit without a usage charge", async () => {
  const { userId, call: c } = await authorized();
  await observeCallEvent({
    callId: c.id,
    eventId: randomUUID(),
    type: "call.hangup",
    at: new Date().toISOString(),
    controlId: "control",
    cause: "no_answer",
  });
  assert.equal((await getCall(c.id))?.billing?.customerChargeJpy, "0");
  assert.equal((await balance(userId)).available, "1000");
});
test("carrier overrun never overdraws; explicit waiver remains in financial audit", async () => {
  const { userId, call: c } = await authorized();
  const end = new Date().toISOString();
  await reconcileCall({
    callId: c.id,
    connectedAt: new Date(Date.parse(end) - 600000).toISOString(),
    endedAt: end,
    evidence: "fixture-carrier-overrun",
  });
  assert.equal((await balance(userId)).available, "0");
  assert.equal((await getCall(c.id))?.billing?.customerChargeJpy, "1000");
  const row = (
    await testDatabase.query<{ payload: { waivedOverrun: string } }>(
      "SELECT payload FROM outbox_events WHERE aggregate_id=$1 AND event_type='call.charged'",
      [c.id],
    )
  ).rows[0];
  assert.equal(row.payload.waivedOverrun, "250");
});
test("low balance is rejected before a call or reservation is committed; credit has no expiry", async () => {
  const id = await user();
  await fund(id, 62n);
  await assert.rejects(
    reserveCall(call(), id, randomUUID()),
    /INSUFFICIENT_CREDIT/,
  );
  assert.equal(
    (await testDatabase.query("SELECT * FROM calls WHERE user_id=$1", [id]))
      .rows.length,
    0,
  );
  const columns = await testDatabase.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name IN ('wallets','wallet_ledger')",
  );
  assert.equal(
    columns.rows.some((c) => c.column_name.includes("expir")),
    false,
  );
  assert.equal((await balance(id)).available, "62");
});
test("Stripe adapter sends only configured price and trusted metadata, without creating products", async () => {
  const id = await user(),
    requests: { path: string; body: URLSearchParams }[] = [];
  const stripe = new Stripe("sk_test_fixture", {
    httpClient: Stripe.createFetchHttpClient(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = new URLSearchParams(String(init?.body || ""));
      requests.push({ path, body });
      if (path === "/v1/prices/price_1000")
        return Response.json({
          id: "price_1000",
          livemode: false,
          active: true,
          type: "one_time",
          currency: "jpy",
          unit_amount: 1000,
        });
      if (path === "/v1/checkout/sessions")
        return Response.json({
          id: "cs_test_sdk",
          livemode: false,
          url: "https://checkout.stripe.com/c/pay/cs_test_sdk",
        });
      throw new Error("Unexpected SDK request");
    }),
  });
  const result = await checkout(
    id,
    "credit_1000",
    randomUUID(),
    stripeAdapter(stripe),
  );
  assert.equal(requests.length, 2);
  const body = requests[1].body;
  assert.equal(body.get("mode"), "payment");
  assert.equal(body.get("line_items[0][price]"), "price_1000");
  assert.equal(body.get("metadata[user_id]"), id);
  assert.equal(body.get("metadata[payment_id]"), result.paymentId);
  assert.equal(
    body.get("payment_intent_data[metadata][payment_id]"),
    result.paymentId,
  );
  assert.equal(body.get("line_items[0][quantity]"), "1");
  assert.equal(body.has("line_items[0][price_data]"), false);
  assert.equal(body.has("payment_method_types[0]"), false);
  assert.match(body.get("integration_identifier")!, /^tomoshimoshi_credits_[a-z]{8}$/);
});

test("Stripe adapter validates actual received money and expanded one-time line items", async () => {
  const metadata = {
    payment_id: randomUUID(),
    user_id: randomUUID(),
    package_code: "credit_1000",
  };
  const fixture = {
    id: "cs_test_confirm",
    livemode: false,
    mode: "payment",
    payment_status: "paid",
    amount_total: 1000,
    currency: "jpy",
    client_reference_id: metadata.payment_id,
    metadata,
    payment_intent: {
      id: "pi_confirm",
      livemode: false,
      status: "succeeded",
      amount_received: 1000,
      currency: "jpy",
      metadata,
    },
    line_items: {
      has_more: false,
      data: [
        {
          quantity: 1,
          amount_total: 1000,
          price: { id: "price_1000", type: "one_time", unit_amount: 1000, livemode: false, currency: "jpy" },
        },
      ],
    },
  };
  const stripe = new Stripe("sk_test_fixture", {
    httpClient: Stripe.createFetchHttpClient(async () =>
      Response.json(fixture),
    ),
  });
  assert.equal(
    (await stripeAdapter(stripe).confirmation("cs_test_confirm")).amount,
    1000n,
  );
  fixture.payment_intent.amount_received = 999;
  await assert.rejects(
    stripeAdapter(stripe).confirmation("cs_test_confirm"),
    /PAYMENT_MISMATCH/,
  );
  fixture.payment_intent.amount_received = 1000;
  fixture.line_items.data[0].price.type = "recurring";
  await assert.rejects(
    stripeAdapter(stripe).confirmation("cs_test_confirm"),
    /PAYMENT_MISMATCH/,
  );
  fixture.line_items.data[0].price.type = "one_time";
  fixture.line_items.has_more = true;
  await assert.rejects(
    stripeAdapter(stripe).confirmation("cs_test_confirm"),
    /PAYMENT_MISMATCH/,
  );
});
test("one provider payment cannot fund two internal payments", async () => {
  const id = await user(),
    a = await checkout(id, "credit_1000", randomUUID(), provider),
    b = await checkout(id, "credit_1000", randomUUID(), provider);
  confirmations.get(`cs_test_${b.paymentId}`)!.paymentId = confirmations.get(
    `cs_test_${a.paymentId}`,
  )!.paymentId;
  await processStripeEvent(event(a.paymentId), provider);
  await assert.rejects(processStripeEvent(event(b.paymentId), provider));
  assert.equal((await balance(id)).available, "1000");
  assert.equal((await paymentStatus(id, b.paymentId)).status, "pending");
});
test("unsupported packages and live-mode events never create wallet credit", async () => {
  const id = await user(),
    p = await checkout(id, "credit_1000", randomUUID(), provider);
  const e = event(p.paymentId);
  e.livemode = true;
  await assert.rejects(processStripeEvent(e, provider), /PAYMENT_MISMATCH/);
  e.livemode = false;
  (e.data.object as Stripe.Checkout.Session).metadata!.package_code =
    "unsupported";
  await assert.rejects(processStripeEvent(e, provider), /PAYMENT_MISMATCH/);
  assert.equal((await balance(id)).available, "0");
});
test("call settlement failure preserves the complete reservation and retries once", async () => {
  const { userId, call: c } = await authorized();
  const end = new Date().toISOString();
  await observeCallEvent({
    callId: c.id,
    eventId: randomUUID(),
    type: "call.answered",
    at: new Date(Date.parse(end) - 60000).toISOString(),
    controlId: "fixture",
  });
  const e = {
    callId: c.id,
    eventId: randomUUID(),
    type: "call.hangup",
    at: end,
    controlId: "fixture",
  };
  await testDatabase.exec(
    "CREATE FUNCTION fail_charge_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='call.charged' THEN RAISE EXCEPTION 'settlement failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_charge_test BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_charge_test();",
  );
  try {
    await assert.rejects(observeCallEvent(e), /settlement failure/);
  } finally {
    await testDatabase.exec(
      "DROP TRIGGER fail_charge_test ON outbox_events; DROP FUNCTION fail_charge_test();",
    );
  }
  assert.equal((await balance(userId)).reserved, "1000");
  assert.equal((await balance(userId)).available, "0");
  assert.equal((await getCall(c.id))?.billing?.customerChargeJpy, null);
  await observeCallEvent(e);
  assert.equal((await balance(userId)).available, "875");
  assert.equal((await balance(userId)).reserved, "0");
});

test("live restricted keys accept only live objects and credit each package once", async () => {
  const saved = { mode: process.env.STRIPE_MODE, key: process.env.STRIPE_SECRET_KEY, origin: process.env.APP_BASE_URL };
  Object.assign(process.env, { STRIPE_MODE: "live", STRIPE_SECRET_KEY: "rk_live_fixture", APP_BASE_URL: "https://www.example.test" });
  try {
    assert.equal(stripeConfig().livemode, true);
    for (const amount of [1000, 2000, 5000] as const) {
      const id = await user();
      const purchase = await checkout(id, `credit_${amount}`, randomUUID(), provider);
      const paid = event(purchase.paymentId);
      await assert.rejects(processStripeEvent(paid, provider), /PAYMENT_MISMATCH/);
      paid.livemode = true;
      await processStripeEvent(paid, provider);
      await processStripeEvent(paid, provider);
      assert.equal((await balance(id)).available, String(amount));
      assert.equal((await testDatabase.query<{ livemode: boolean }>("SELECT livemode FROM payments WHERE id=$1", [purchase.paymentId])).rows[0].livemode, true);
      await assert.rejects(testDatabase.query("UPDATE payments SET livemode=false WHERE id=$1", [purchase.paymentId]), /immutable/);
    }
    process.env.STRIPE_SECRET_KEY = "rk_test_fixture";
    assert.throws(stripeConfig, /live secret or restricted/);
    process.env.STRIPE_SECRET_KEY = "rk_live_fixture";
    process.env.APP_BASE_URL = "http://localhost:3000";
    assert.throws(stripeConfig, /HTTPS/);
  } finally {
    Object.assign(process.env, { STRIPE_MODE: saved.mode, STRIPE_SECRET_KEY: saved.key, APP_BASE_URL: saved.origin });
  }
});

test("production defaults to live and nonproduction can explicitly use restricted test keys", () => {
  const oldNode = process.env.NODE_ENV;
  const oldKey = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_MODE;
  process.env.NODE_ENV = "production";
  try { assert.throws(stripeConfig, /live secret or restricted/); }
  finally {
    if (oldNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNode;
    process.env.STRIPE_MODE = "test";
  }
  process.env.STRIPE_SECRET_KEY = "rk_test_fixture";
  try { assert.equal(stripeConfig().livemode, false); }
  finally { process.env.STRIPE_SECRET_KEY = oldKey; }
});

test("live SDK adapter rejects test prices, sessions, intents and line-item prices", async () => {
  const saved = { key: process.env.STRIPE_SECRET_KEY, origin: process.env.APP_BASE_URL };
  Object.assign(process.env, { STRIPE_MODE: "live", STRIPE_SECRET_KEY: "rk_live_fixture", APP_BASE_URL: "https://www.example.test" });
  try {
    const id = await user();
    let priceMode = false, sessionMode = true;
    const sdk = new Stripe("rk_live_fixture", { httpClient: Stripe.createFetchHttpClient(async url => {
      if (String(url).includes("/prices/")) return Response.json({ livemode: priceMode, active: true, type: "one_time", currency: "jpy", unit_amount: 1000 });
      return Response.json({ id: "cs_live_fixture", livemode: sessionMode, url: "https://checkout.stripe.com/c/pay/fixture" });
    }) });
    await assert.rejects(checkout(id, "credit_1000", randomUUID(), stripeAdapter(sdk)), /CHECKOUT_UNAVAILABLE/);
    priceMode = true; sessionMode = false;
    await assert.rejects(checkout(id, "credit_1000", randomUUID(), stripeAdapter(sdk)), /CHECKOUT_UNAVAILABLE/);
    sessionMode = true;
    assert.match((await checkout(id, "credit_1000", randomUUID(), stripeAdapter(sdk))).url, /^https:\/\/checkout.stripe.com/);
  } finally { Object.assign(process.env, { STRIPE_MODE: "test", STRIPE_SECRET_KEY: saved.key, APP_BASE_URL: saved.origin }); }
});

test("partial/full refunds, duplicate delivery and a won dispute reconcile without changing purchase history", async () => {
  const { reconcileReversal } = await import("../server/billing/reversals");
  const id = await user();
  const p = await checkout(id, "credit_1000", randomUUID(), provider);
  await processStripeEvent(event(p.paymentId), provider);
  let amount = 400n;
  const snapshot = async () => ({ amount, currency: "jpy", livemode: false });
  await Promise.all([reconcileReversal(p.paymentId, snapshot), reconcileReversal(p.paymentId, snapshot)]);
  assert.equal((await balance(id)).available, "600");
  amount = 1000n; // Full dispute/refund holds the rest.
  await reconcileReversal(p.paymentId, snapshot);
  assert.equal((await balance(id)).available, "0");
  amount = 400n; // Dispute won; retain the actual refund only.
  await reconcileReversal(p.paymentId, snapshot);
  await reconcileReversal(p.paymentId, snapshot);
  assert.equal((await balance(id)).available, "600");
  await processStripeEvent(event(p.paymentId), provider);
  assert.equal((await balance(id)).available, "600");
  assert.equal((await paymentStatus(id, p.paymentId)).status, "succeeded");
  const entries = await testDatabase.query("SELECT * FROM wallet_ledger WHERE reference_type='payment_reversal' AND reference_id=$1", [p.paymentId]);
  assert.equal(entries.rows.length, 3);
});

test("a refund during a call preserves reserved money and blocks new calls until reconciliation", async () => {
  const { reconcileReversal } = await import("../server/billing/reversals");
  const id = await user();
  const p = await checkout(id, "credit_1000", randomUUID(), provider);
  await processStripeEvent(event(p.paymentId), provider);
  const c = call();
  await reserveCall(c, id, randomUUID());
  const snapshot = async () => ({ amount: 1000n, currency: "jpy", livemode: false });
  await reconcileReversal(p.paymentId, snapshot);
  assert.equal((await balance(id)).reserved, "1000");
  assert.equal((await balance(id)).paymentReviewRequired, true);
  await assert.rejects(checkout(id, "credit_1000", randomUUID(), provider), /PAYMENT_REVIEW_REQUIRED/);
  const { authorizeCall } = await import("../server/calls/billing");
  await assert.rejects(transaction(tx => authorizeCall(tx, randomUUID(), id)), /PAYMENT_REVIEW_REQUIRED/);
  await observeCallEvent({ callId: c.id, eventId: randomUUID(), type: "call.hangup", at: new Date().toISOString(), cause: "no_answer", controlId: "fixture" });
  await reconcileReversal(p.paymentId, snapshot);
  assert.equal((await balance(id)).reserved, "0");
  assert.equal((await balance(id)).available, "0");
  assert.equal((await balance(id)).paymentReviewRequired, false);
});

test("reversal rejects wrong mode, currency and excessive amounts without altering credit", async () => {
  const { reconcileReversal } = await import("../server/billing/reversals");
  const id = await user();
  const p = await checkout(id, "credit_1000", randomUUID(), provider);
  await processStripeEvent(event(p.paymentId), provider);
  for (const snapshot of [
    { amount: 1001n, currency: "jpy", livemode: false },
    { amount: 1000n, currency: "usd", livemode: false },
    { amount: 1000n, currency: "jpy", livemode: true },
  ]) await assert.rejects(reconcileReversal(p.paymentId, async () => snapshot), /PAYMENT_MISMATCH/);
  assert.equal((await balance(id)).available, "1000");
});

test("refund failure rolls back the ledger and reversal projection together", async () => {
  const { reconcileReversal } = await import("../server/billing/reversals");
  const id = await user();
  const p = await checkout(id, "credit_1000", randomUUID(), provider);
  await processStripeEvent(event(p.paymentId), provider);
  await testDatabase.exec("CREATE FUNCTION fail_reversal_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected reversal failure'; END $$; CREATE TRIGGER fail_reversal_test BEFORE INSERT ON payment_reversals FOR EACH ROW EXECUTE FUNCTION fail_reversal_test();");
  const snapshot = async () => ({ amount: 1000n, currency: "jpy", livemode: false });
  try { await assert.rejects(reconcileReversal(p.paymentId, snapshot), /injected reversal failure/); }
  finally { await testDatabase.exec("DROP TRIGGER fail_reversal_test ON payment_reversals; DROP FUNCTION fail_reversal_test();"); }
  assert.equal((await balance(id)).available, "1000");
  await reconcileReversal(p.paymentId, snapshot);
  assert.equal((await balance(id)).available, "0");
});

test("return-page reconciliation verifies Stripe and recovers a missing webhook exactly once", async () => {
  const { reconcilePayment } = await import("../server/billing/reconcile");
  const id = await user();
  const p = await checkout(id, "credit_1000", randomUUID(), provider);
  const confirmation = confirmations.get(`cs_test_${p.paymentId}`)!;
  const metadata = confirmation.metadata;
  let requests = 0;
  const session = {
    id: confirmation.sessionId, livemode: false, status: "complete", mode: "payment", payment_status: "paid",
    amount_total: 1000, currency: "jpy", metadata, client_reference_id: p.paymentId,
    payment_intent: { id: confirmation.paymentId, livemode: false, status: "succeeded", amount_received: 1000, currency: "jpy", metadata },
    line_items: { has_more: false, data: [{ quantity: 1, amount_total: 1000, price: { id: "price_1000", type: "one_time", unit_amount: 1000, currency: "jpy", livemode: false } }] },
  };
  const sdk = new Stripe("sk_test_fixture", { httpClient: Stripe.createFetchHttpClient(async () => { requests++; return Response.json(session); }) });
  await reconcilePayment(p.paymentId, await user(), sdk);
  assert.equal(requests, 0); // Owner scoping precedes Stripe access.
  session.payment_status = "unpaid";
  await reconcilePayment(p.paymentId, id, sdk);
  assert.equal((await balance(id)).available, "0");
  session.payment_status = "paid";
  await reconcilePayment(p.paymentId, id, sdk);
  assert.equal((await balance(id)).available, "1000");
  await processStripeEvent(event(p.paymentId), provider);
  await reconcilePayment(p.paymentId, id, sdk);
  assert.equal((await balance(id)).available, "1000");
});

test("Stripe reversal snapshot ignores failed refunds and won disputes and caps overlapping reversals", async () => {
  const { reversalSnapshot } = await import("../server/billing/reversals");
  const id = await user();
  const p = await checkout(id, "credit_1000", randomUUID(), provider);
  await processStripeEvent(event(p.paymentId), provider);
  const payment = (await testDatabase.query("SELECT * FROM payments WHERE id=$1", [p.paymentId])).rows[0];
  const refunds = [{ id: "re_1", amount: 100, status: "succeeded" }, { id: "re_2", amount: 900, status: "failed" }];
  const disputes = [{ id: "dp_1", amount: 1000, status: "won" }];
  const sdk = new Stripe("sk_test_fixture", { httpClient: Stripe.createFetchHttpClient(async url => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/refunds") return Response.json({ object: "list", data: refunds, has_more: false });
    if (path === "/v1/disputes") return Response.json({ object: "list", data: disputes, has_more: false });
    return Response.json({ metadata: { payment_id: p.paymentId, user_id: id }, amount_received: 1000, currency: "jpy", livemode: false });
  }) });
  assert.equal((await reversalSnapshot(payment as never, sdk)).amount, 100n);
  disputes[0].status = "needs_response";
  assert.equal((await reversalSnapshot(payment as never, sdk)).amount, 1000n);
  disputes[0].status = "won";
  refunds[0].status = "canceled";
  assert.equal((await reversalSnapshot(payment as never, sdk)).amount, 0n);
});
