import type Stripe from "stripe";
import { database } from "../database";
import { stripeClient, stripeAdapter } from "./stripe";
import { stripeConfig } from "./stripe/config";
import { processStripeEvent } from "./payments";
import { reconcileReversal } from "./reversals";
import { billingLog } from "./events";

export async function reconcilePayment(id: string, userId?: string, client?: Stripe) {
  const payment = (await database().query(
    "SELECT * FROM payments WHERE id=$1 AND ($2::uuid IS NULL OR user_id=$2)", [id, userId || null],
  )).rows[0];
  if (!payment || payment.status !== "pending" || !payment.provider_session_id || payment.livemode !== stripeConfig().livemode) return;
  const stripe = client || stripeClient();
  const session = await stripe.checkout.sessions.retrieve(payment.provider_session_id);
  if (session.livemode !== payment.livemode) throw new Error("PAYMENT_MISMATCH");
  if (session.payment_status !== "paid" && session.status !== "expired") return;
  // Same fulfillment transaction and independent Stripe verification as a signed webhook.
  await processStripeEvent({
    id: `reconcile:${session.id}:${session.payment_status}:${session.status}`,
    type: session.payment_status === "paid" ? "checkout.session.completed" : "checkout.session.expired",
    livemode: session.livemode, data: { object: session },
  } as unknown as Stripe.Event, stripeAdapter(stripe));
}

export async function reconcilePayments() {
  const { livemode } = stripeConfig();
  const pending = await database().query(`SELECT id FROM payments WHERE livemode=$1
    AND status='pending' AND provider_session_id IS NOT NULL ORDER BY updated_at LIMIT 50`, [livemode]);
  for (const row of pending.rows) {
    try { await reconcilePayment(row.id); }
    catch { billingLog("payment.reconciliation_failed", { paymentId: row.id }); }
    // Rotate the batch, including long-running asynchronous payments.
    await database().query("UPDATE payments SET updated_at=now() WHERE id=$1", [row.id]);
  }
  // Include settled purchases with no reversal event: recover missed refund/dispute webhooks too.
  const reversals = await database().query(`SELECT p.id AS payment_id FROM payments p
    LEFT JOIN payment_reversals r ON r.payment_id=p.id
    WHERE p.livemode=$1 AND p.status='succeeded'
    ORDER BY r.updated_at NULLS FIRST,p.created_at LIMIT 20`, [livemode]);
  for (const row of reversals.rows) {
    try { await reconcileReversal(row.payment_id); }
    catch { billingLog("payment.reversal_reconciliation_failed", { paymentId: row.payment_id }); }
  }
}
