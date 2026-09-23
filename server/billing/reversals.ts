import type Stripe from "stripe";
import { database } from "../database";
import { transaction } from "../transaction";
import { adjustPayment, lockWallet } from "../wallet";
import { stripeClient } from "./stripe";
import { stripeConfig } from "./stripe/config";
import { billingLog } from "./events";
import type { Payment } from "./provider";

export const reversalEvents = new Set([
  "charge.refunded", "refund.created", "refund.updated", "refund.failed",
  "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed",
  "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated",
]);

export type ReversalSnapshot = { amount: bigint; currency: string; livemode: boolean };
export async function reversalSnapshot(payment: Payment, stripe = stripeClient()): Promise<ReversalSnapshot> {
  const id = payment.provider_payment_id!;
  const [intent, refunds, disputes] = await Promise.all([
    stripe.paymentIntents.retrieve(id),
    stripe.refunds.list({ payment_intent: id, limit: 100 }).autoPagingToArray({ limit: 1000 }),
    stripe.disputes.list({ payment_intent: id, limit: 100 }).autoPagingToArray({ limit: 1000 }),
  ]);
  if (intent.metadata.payment_id !== payment.id || intent.metadata.user_id !== payment.user_id ||
      intent.amount_received !== Number(payment.amount) || intent.livemode !== payment.livemode)
    throw new Error("PAYMENT_MISMATCH");
  // Pending refunds reserve the corresponding credit too; failed/cancelled ones restore it.
  const refunded = refunds.filter(r => !["failed", "canceled"].includes(r.status || ""))
    .reduce((sum, r) => sum + BigInt(r.amount), 0n);
  const disputed = disputes.filter(d => !["won", "warning_closed"].includes(d.status))
    .reduce((sum, d) => sum + BigInt(d.amount), 0n);
  const total = refunded + disputed;
  return { amount: total > BigInt(payment.amount) ? BigInt(payment.amount) : total,
    currency: intent.currency, livemode: intent.livemode };
}

export async function reconcileReversal(
  paymentId: string,
  snapshot: (payment: Payment) => Promise<ReversalSnapshot> = reversalSnapshot,
) {
  return transaction(async tx => {
    const payment = (await tx.query("SELECT * FROM payments WHERE id=$1 FOR UPDATE", [paymentId])).rows[0] as Payment | undefined;
    if (!payment || payment.livemode !== stripeConfig().livemode) throw new Error("PAYMENT_MISMATCH");
    if (payment.status !== "succeeded" || !payment.provider_payment_id) throw new Error("PAYMENT_NOT_SETTLED");
    // Fetch after the row lock: out-of-order events cannot apply an older snapshot last.
    const current = await snapshot(payment);
    if (current.livemode !== payment.livemode || current.currency !== "jpy" ||
        current.amount < 0n || current.amount > BigInt(payment.amount)) throw new Error("PAYMENT_MISMATCH");
    const wallet = await lockWallet(tx, payment.user_id);
    const prior = (await tx.query("SELECT * FROM payment_reversals WHERE payment_id=$1", [paymentId])).rows[0];
    const debited = BigInt(prior?.debited_amount || "0");
    const difference = current.amount - debited;
    const debit = difference > BigInt(wallet.available_balance) ? BigInt(wallet.available_balance) : difference;
    const revision = (BigInt(prior?.revision || "0") + 1n).toString();
    await adjustPayment(tx, wallet, -debit, paymentId, revision);
    await tx.query(`INSERT INTO payment_reversals(payment_id,required_amount,debited_amount,revision)
      VALUES($1,$2,$3,$4) ON CONFLICT(payment_id) DO UPDATE SET
      required_amount=EXCLUDED.required_amount,debited_amount=EXCLUDED.debited_amount,
      revision=EXCLUDED.revision,updated_at=now()`,
      [paymentId, current.amount.toString(), (debited + debit).toString(), revision]);
    if (debit !== 0n || current.amount !== BigInt(prior?.required_amount || "0"))
      billingLog(current.amount > debited + debit ? "payment.reversal_shortfall" : "payment.reversal_reconciled", { paymentId });
  });
}

export async function processReversalEvent(event: Stripe.Event, stripe = stripeClient()) {
  if (event.livemode !== stripeConfig().livemode) throw new Error("PAYMENT_MISMATCH");
  const object = event.data.object as Stripe.Charge | Stripe.Refund | Stripe.Dispute;
  let intentId = typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id;
  if (!intentId && "charge" in object && object.charge) {
    const charge = typeof object.charge === "string" ? await stripe.charges.retrieve(object.charge) : object.charge;
    intentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  }
  if (!intentId) return;
  const intent = await stripe.paymentIntents.retrieve(intentId);
  if (!intent.metadata.payment_id) return; // Another integration on the same Stripe account.
  const payment = (await database().query("SELECT id FROM payments WHERE id=$1 AND user_id=$2", [intent.metadata.payment_id, intent.metadata.user_id])).rows[0];
  if (!payment) throw new Error("PAYMENT_MISMATCH");
  await reconcileReversal(payment.id, p => reversalSnapshot(p, stripe));
}
