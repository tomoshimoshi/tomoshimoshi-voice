import type { PoolClient } from "pg";
import { activePricing, affordableSeconds, chargeForSeconds } from "../pricing";
import { lockWallet, reserve, capture, release } from "../wallet";
import { transaction } from "../transaction";
import { billingLog, outbox } from "../billing/events";
import { database } from "../database";
export async function authorizeCall(
  tx: PoolClient,
  callId: string,
  userId: string,
) {
  const pricing = await activePricing(tx);
  const wallet = await lockWallet(tx, userId, pricing.currency);
  const review = await tx.query(
    `SELECT 1 FROM payment_reversals r JOIN payments p ON p.id=r.payment_id
     WHERE p.user_id=$1 AND r.required_amount>r.debited_amount LIMIT 1`, [userId],
  );
  if (review.rows.length) throw new Error("PAYMENT_REVIEW_REQUIRED");
  const amount = BigInt(wallet.available_balance);
  const affordable = affordableSeconds(amount, BigInt(pricing.rate_per_minute));
  // Telnyx's carrier-side limit has a 30-second minimum. Never round up the budget.
  if (affordable < 30n) {
    billingLog("wallet.insufficient_funds", { callId, userId });
    throw new Error("INSUFFICIENT_CREDIT");
  }
  const configured = process.env.MAX_CALL_SECONDS;
  if (
    configured &&
    (!/^\d+$/.test(configured) ||
      Number(configured) < 30 ||
      Number(configured) > 1200)
  )
    throw new Error("INVALID_CALL_LIMIT");
  const cap = BigInt(configured || "600");
  const maximum = Number(affordable < cap ? affordable : cap);
  const reservation = await reserve(
    tx,
    wallet.id,
    amount,
    { type: "call", id: callId, key: `call:${callId}:reserve` },
    new Date(Date.now() + (maximum + 300) * 1000),
  );
  await tx.query(
    "INSERT INTO call_billing(call_id,reservation_id,pricing_version_id,currency,rate_per_minute,max_duration_seconds) VALUES($1,$2,$3,$4,$5,$6)",
    [
      callId,
      reservation,
      pricing.id,
      pricing.currency,
      pricing.rate_per_minute,
      maximum,
    ],
  );
  return {
    pricingVersionId: pricing.id,
    ratePerMinute: pricing.rate_per_minute,
    maxDurationSeconds: maximum,
    status: "reserved" as const,
    connectedAt: null,
    endedAt: null,
    durationSeconds: null,
    customerChargeJpy: null,
  };
}
async function settle(
  tx: PoolClient,
  callId: string,
  connectedAt: string | null,
  endedAt: string,
  evidence: string,
) {
  const row = (
    await tx.query("SELECT * FROM call_billing WHERE call_id=$1 FOR UPDATE", [
      callId,
    ])
  ).rows[0];
  if (!row || row.status === "settled") return false;
  const end = Date.parse(endedAt),
    start = connectedAt === null ? end : Date.parse(connectedAt);
  if (
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(start) ||
    start > end ||
    end > Date.now() + 300000
  )
    throw new Error("INVALID_DURATION");
  // Whole connected seconds, dropping only the subsecond remainder, never ringing time.
  const seconds = Number((BigInt(end) - BigInt(start)) / 1000n);
  const rated = chargeForSeconds(seconds, BigInt(row.rate_per_minute));
  const reservation = (
    await tx.query("SELECT * FROM wallet_reservations WHERE id=$1", [
      row.reservation_id,
    ])
  ).rows[0];
  const budget = BigInt(reservation.amount);
  // Carrier overruns are absorbed, never charged beyond the authorized prepaid budget.
  const charge = rated > budget ? budget : rated;
  if (charge > 0n)
    await capture(tx, reservation.id, charge, `call:${callId}:capture`);
  if (budget > charge)
    await release(
      tx,
      reservation.id,
      budget - charge,
      `call:${callId}:release`,
    );
  await tx.query(
    "UPDATE call_billing SET connected_at=$2,ended_at=$3,duration_seconds=$4,customer_charge_jpy=$5,status='settled',termination_confirmed=true,settlement_evidence=$6,settled_at=now() WHERE call_id=$1",
    [callId, connectedAt, endedAt, seconds, charge.toString(), evidence],
  );
  await outbox(tx, "call.charged", callId, `call:${callId}:charged`, {
    callId,
    pricingVersionId: row.pricing_version_id,
    ratePerMinute: String(row.rate_per_minute),
    durationSeconds: seconds,
    charge: charge.toString(),
    ratedCharge: rated.toString(),
    waivedOverrun: (rated - charge).toString(),
    currency: row.currency,
    evidence,
  });
  return { charge: charge.toString(), unused: (budget - charge).toString() };
}
const unconnectedCauses = new Set([
  "no_answer",
  "timeout",
  "user_busy",
  "call_rejected",
  "unallocated_number",
  "invalid_number_format",
  "no_route_to_destination",
]);
export async function observeCallEvent(input: {
  callId: string;
  eventId: string;
  type: string;
  at: string;
  controlId: string;
  cause?: string;
  sipHangupCause?: string;
}) {
  if (!["call.answered", "call.hangup", "call.initiated"].includes(input.type))
    return;
  const result = await transaction(async (tx) => {
    const row = (
      await tx.query("SELECT * FROM call_billing WHERE call_id=$1 FOR UPDATE", [
        input.callId,
      ])
    ).rows[0];
    if (!row) return false; // Imported historical calls are not retroactively billed.
    if (row.provider_control_id && row.provider_control_id !== input.controlId)
      throw new Error("CALL_PROVIDER_MISMATCH");
    const at = Date.parse(input.at);
    const call = (
      await tx.query("SELECT created_at FROM calls WHERE id=$1", [input.callId])
    ).rows[0];
    if (
      !Number.isSafeInteger(at) ||
      at < new Date(call.created_at).getTime() - 5000 ||
      at > Date.now() + 300000
    )
      throw new Error("INVALID_DURATION");
    const inserted = await tx.query(
      "INSERT INTO call_billing_events(provider,event_id,call_id,event_type,occurred_at) VALUES('telnyx',$1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id",
      [input.eventId, input.callId, input.type, input.at],
    );
    if (!inserted.rowCount || row.status === "settled") return false;
    await tx.query(
      "UPDATE call_billing SET provider_control_id=$2 WHERE call_id=$1",
      [input.callId, input.controlId],
    );
    if (input.type === "call.answered") {
      if (row.connected_at && new Date(row.connected_at).getTime() !== at)
        throw new Error("CALL_TIMING_MISMATCH");
      await tx.query(
        "UPDATE call_billing SET connected_at=$2 WHERE call_id=$1",
        [input.callId, input.at],
      );
      if (row.termination_confirmed && row.ended_at)
        return settle(
          tx,
          input.callId,
          input.at,
          new Date(row.ended_at).toISOString(),
          `telnyx:${input.eventId}`,
        );
    }
    if (input.type === "call.hangup") {
      await tx.query(
        "UPDATE call_billing SET ended_at=$2,termination_confirmed=true,status='pending' WHERE call_id=$1",
        [input.callId, input.at],
      );
      // Telnyx can report a pre-answer cancellation as normal_clearing with
      // SIP 487 (the INVITE was terminated). Normal clearing alone is ambiguous.
      // A recorded answer still takes precedence and bills its connected time.
      if (
        row.connected_at ||
        unconnectedCauses.has(input.cause || "") ||
        input.sipHangupCause === "487"
      )
        return settle(
          tx,
          input.callId,
          row.connected_at ? new Date(row.connected_at).toISOString() : null,
          input.at,
          `telnyx:${input.eventId}`,
        );
      // Hangup can precede answer delivery. Keep funds reserved until answer or review.
    }
    return false;
  });
  if (result) logSettlement(input.callId, result);
}
export async function markCallEnded(callId: string) {
  await database().query(
    "UPDATE call_billing SET status='pending' WHERE call_id=$1 AND status='reserved'",
    [callId],
  );
}
// Server/operator-only reconciliation, after independently confirming provider termination.
export async function reconcileCall(input: {
  callId: string;
  connectedAt: string | null;
  endedAt: string;
  evidence: string;
}) {
  if (input.evidence.trim().length < 10) throw new Error("EVIDENCE_REQUIRED");
  const changed = await transaction((tx) =>
    settle(
      tx,
      input.callId,
      input.connectedAt,
      input.endedAt,
      `review:${input.evidence}`,
    ),
  );
  if (changed) logSettlement(input.callId, changed);
  return !!changed;
}

function logSettlement(
  callId: string,
  amounts: { charge: string; unused: string },
) {
  billingLog("call.charged", { callId });
  if (BigInt(amounts.charge) > 0n) billingLog("wallet.captured", { callId });
  if (BigInt(amounts.unused) > 0n) billingLog("wallet.released", { callId });
}
