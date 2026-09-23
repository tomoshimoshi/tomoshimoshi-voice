import { randomUUID } from "node:crypto";
import { z } from "zod";
import type Stripe from "stripe";
import { database } from "../database";
import { transaction } from "../transaction";
import { credit } from "../wallet";
import { activePricing, affordableSeconds, chargeForSeconds } from "../pricing";
import { packages, packageDefinition, type PackageCode } from "./packages";
import { stripeConfig } from "./stripe/config";
import { stripeProvider } from "./stripe";
import type { Payment, PaymentProvider } from "./provider";
import { billingLog, outbox } from "./events";
export const checkoutInput = z
  .object({
    packageCode: z.enum(["credit_1000", "credit_2000", "credit_5000"]),
  })
  .strict();
export async function checkout(
  userId: string,
  code: PackageCode,
  key: string,
  provider: PaymentProvider = stripeProvider,
) {
  const config = stripeConfig();
  z.uuid().parse(key);
  const pack = packageDefinition(code);
  const payment = await transaction(async (tx) => {
    // Serialize duplicate checkout requests for the same account/key.
    await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
    const prior = await tx.query(
      "SELECT 1 FROM payments WHERE user_id=$1 AND request_key=$2", [userId, key],
    );
    if (!prior.rows.length) {
      const recent = await tx.query(
        "SELECT count(*)::int AS count FROM payments WHERE user_id=$1 AND created_at > now()-interval '30 minutes'",
        [userId],
      );
      if (recent.rows[0].count >= 10) throw new Error("CHECKOUT_RATE_LIMIT");
    }
    if ((await tx.query(`SELECT 1 FROM payment_reversals r JOIN payments p ON p.id=r.payment_id
      WHERE p.user_id=$1 AND r.required_amount>r.debited_amount LIMIT 1`, [userId])).rows.length)
      throw new Error("PAYMENT_REVIEW_REQUIRED");
    await tx.query(
      `INSERT INTO payments(id,user_id,provider,provider_price_id,amount,currency,package_code,request_key,livemode) VALUES($1,$2,'stripe',$3,$4,'JPY',$5,$6,$7) ON CONFLICT(user_id,request_key) DO NOTHING`,
      [
        randomUUID(),
        userId,
        config.prices[code],
        pack.amount.toString(),
        code,
        key,
        config.livemode,
      ],
    );
    const row = (
      await tx.query(
        "SELECT * FROM payments WHERE user_id=$1 AND request_key=$2",
        [userId, key],
      )
    ).rows[0] as Payment;
    if (row.package_code !== code) throw new Error("IDEMPOTENCY_CONFLICT");
    if (row.livemode !== config.livemode) throw new Error("PAYMENT_MISMATCH");
    if (
      row.status !== "pending" ||
      Date.now() - new Date(row.created_at).getTime() >= 30 * 60 * 1000
    )
      throw new Error("CHECKOUT_EXPIRED");
    return row;
  });
  if (payment.checkout_url)
    return { url: payment.checkout_url, paymentId: payment.id };
  let session;
  try {
    session = await provider.createCheckout(payment);
  } catch {
    billingLog("payment.checkout_failed", { paymentId: payment.id });
    throw new Error("CHECKOUT_UNAVAILABLE");
  }
  await database().query(
    "UPDATE payments SET provider_session_id=$2,checkout_url=$3,updated_at=now() WHERE id=$1 AND (provider_session_id IS NULL OR provider_session_id=$2)",
    [payment.id, session.id, session.url],
  );
  billingLog("payment.checkout_created", { paymentId: payment.id, userId });
  return { url: session.url, paymentId: payment.id };
}
const supported = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);
export async function processStripeEvent(
  event: Stripe.Event,
  provider: PaymentProvider = stripeProvider,
) {
  if (event.livemode !== stripeConfig().livemode) throw new Error("PAYMENT_MISMATCH");
  if (
    (
      await database().query(
        "SELECT 1 FROM billing_provider_events WHERE provider='stripe' AND event_id=$1",
        [event.id],
      )
    ).rowCount
  ) {
    billingLog("payment.duplicate_event", { eventId: event.id });
    return;
  }
  const session = event.data.object as Stripe.Checkout.Session;
  const success =
    event.type === "checkout.session.async_payment_succeeded" ||
    (event.type === "checkout.session.completed" &&
      session.payment_status === "paid");
  // Remote I/O stays outside the database transaction. Nothing is credited yet.
  const confirmation =
    supported.has(event.type) && success
      ? await provider.confirmation(session.id)
      : undefined;
  const result = await transaction(async (tx) => {
    const paymentId = supported.has(event.type)
      ? z.uuid().parse(session.metadata?.payment_id)
      : undefined;
    // Lock the payment before inserting its FK event to avoid concurrent lock upgrades.
    const payment = paymentId
      ? ((
          await tx.query("SELECT * FROM payments WHERE id=$1 FOR UPDATE", [
            paymentId,
          ])
        ).rows[0] as Payment | undefined)
      : undefined;
    const inserted = await tx.query(
      "INSERT INTO billing_provider_events(provider,event_id,event_type,payment_id) VALUES('stripe',$1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id",
      [event.id, event.type, paymentId || null],
    );
    if (!inserted.rowCount) return "duplicate";
    if (!supported.has(event.type)) return "ignored";
    if (
      !payment ||
      payment.livemode !== event.livemode ||
      payment.provider !== "stripe" ||
      (payment.provider_session_id &&
        payment.provider_session_id !== session.id) ||
      payment.user_id !== session.metadata?.user_id ||
      payment.package_code !== session.metadata?.package_code ||
      session.client_reference_id !== payment.id
    )
      throw new Error("PAYMENT_MISMATCH");
    // Event correlation is retained from the insert (events are immutable).
    if (confirmation) {
      const pack = packageDefinition(payment.package_code);
      if (
        !confirmation.paid ||
        confirmation.sessionId !== session.id ||
        confirmation.currency !== "jpy" ||
        confirmation.amount !== pack.amount ||
        BigInt(payment.amount) !== pack.amount ||
        payment.currency !== "JPY" ||
        confirmation.quantity !== 1 ||
        confirmation.priceId !== payment.provider_price_id ||
        confirmation.metadata.payment_id !== payment.id ||
        confirmation.metadata.user_id !== payment.user_id ||
        confirmation.metadata.package_code !== payment.package_code ||
        (payment.provider_payment_id &&
          payment.provider_payment_id !== confirmation.paymentId)
      )
        throw new Error("PAYMENT_MISMATCH");
      if (payment.status === "succeeded") return "duplicate";
      await tx.query(
        "UPDATE payments SET status='succeeded',provider_payment_id=$2,provider_session_id=$3,updated_at=now() WHERE id=$1",
        [payment.id, confirmation.paymentId, confirmation.sessionId],
      );
      await credit(tx, payment.user_id, pack.amount, {
        type: "payment",
        id: payment.id,
        key: `payment:${payment.id}:purchase`,
      });
      await outbox(
        tx,
        "payment.succeeded",
        payment.id,
        `payment:${payment.id}:succeeded`,
        {
          paymentId: payment.id,
          userId: payment.user_id,
          amount: pack.amount.toString(),
          currency: "JPY",
        },
      );
      return "succeeded";
    }
    if (payment.status !== "succeeded") {
      const status = event.type.endsWith("expired")
        ? "expired"
        : event.type.endsWith("failed")
          ? "failed"
          : "pending";
      // A delayed completed/unpaid event never rewinds failure/expiration.
      await tx.query(
        "UPDATE payments SET status=CASE WHEN $2='pending' THEN status ELSE $2 END,provider_session_id=$3,updated_at=now() WHERE id=$1",
        [payment.id, status, session.id],
      );
    }
    return "pending";
  });
  billingLog(
    result === "duplicate" ? "payment.duplicate_event" : `payment.${result}`,
    {
      eventId: event.id,
      ...(session.metadata?.payment_id
        ? { paymentId: session.metadata.payment_id }
        : {}),
    },
  );
  if (result === "succeeded")
    billingLog("wallet.credited", { paymentId: session.metadata!.payment_id });
}
export async function walletSummary(userId: string) {
  const [result, pricing, review] = await Promise.all([
    database().query(
      "SELECT available_balance::text,reserved_balance::text FROM wallets WHERE user_id=$1 AND currency='JPY'",
      [userId],
    ),
    activePricing(),
    database().query(`SELECT 1 FROM payment_reversals r JOIN payments p ON p.id=r.payment_id
      WHERE p.user_id=$1 AND r.required_amount>r.debited_amount LIMIT 1`, [userId]),
  ]);
  const available = result.rows[0]?.available_balance || "0",
    reserved = result.rows[0]?.reserved_balance || "0";
  const rate = BigInt(pricing.rate_per_minute);
  return {
    currency: "JPY",
    paymentReviewRequired: review.rows.length > 0,
    available,
    reserved,
    pricing: { id: pricing.id, ratePerMinute: pricing.rate_per_minute },
    approximateMinutes: (
      affordableSeconds(BigInt(available), rate) / 60n
    ).toString(),
    minimumCallCredit: chargeForSeconds(30, rate).toString(),
    packages: Object.entries(packages).map(([code, p]) => ({
      code,
      amount: p.amount.toString(),
      approximateMinutes: (affordableSeconds(p.amount, rate) / 60n).toString(),
    })),
  };
}
export async function paymentStatus(userId: string, id: string) {
  const result = await database().query(
    "SELECT id,status,amount::text,currency FROM payments WHERE id=$1 AND user_id=$2",
    [z.uuid().parse(id), userId],
  );
  return result.rows[0];
}
