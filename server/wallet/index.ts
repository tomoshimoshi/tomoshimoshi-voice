import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { outbox } from "../billing/events";
export type Wallet = {
  id: string;
  currency: string;
  available_balance: string;
  reserved_balance: string;
};
type Reference = { type: string; id: string; key: string };
export async function lockWallet(
  tx: PoolClient,
  userId: string,
  currency = "JPY",
): Promise<Wallet> {
  await tx.query(
    "INSERT INTO wallets(id,user_id,currency) VALUES($1,$2,$3) ON CONFLICT(user_id,currency) DO NOTHING",
    [randomUUID(), userId, currency],
  );
  return (
    await tx.query(
      "SELECT id,currency,available_balance::text,reserved_balance::text FROM wallets WHERE user_id=$1 AND currency=$2 FOR UPDATE",
      [userId, currency],
    )
  ).rows[0];
}
async function walletById(tx: PoolClient, id: string): Promise<Wallet> {
  const row = (
    await tx.query(
      "SELECT id,currency,available_balance::text,reserved_balance::text FROM wallets WHERE id=$1 FOR UPDATE",
      [id],
    )
  ).rows[0];
  if (!row) throw new Error("WALLET_NOT_FOUND");
  return row;
}
function positive(amount: bigint) {
  if (amount <= 0n) throw new Error("INVALID_AMOUNT");
}
async function entry(
  tx: PoolClient,
  wallet: Wallet,
  type: string,
  amount: bigint,
  available: bigint,
  reserved: bigint,
  ref: Reference,
  metadata = {},
) {
  positive(amount);
  const prior = (
    await tx.query("SELECT * FROM wallet_ledger WHERE idempotency_key=$1", [
      ref.key,
    ])
  ).rows[0];
  if (prior) {
    if (
      prior.wallet_id !== wallet.id ||
      prior.entry_type !== type ||
      BigInt(prior.amount) !== amount ||
      prior.reference_type !== ref.type ||
      prior.reference_id !== ref.id
    )
      throw new Error("IDEMPOTENCY_CONFLICT");
    return false;
  }
  if (
    BigInt(wallet.available_balance) + available < 0n ||
    BigInt(wallet.reserved_balance) + reserved < 0n
  )
    throw new Error("INSUFFICIENT_CREDIT");
  // The trigger changes the projection; the deferred constraint verifies reconciliation.
  await tx.query(
    `INSERT INTO wallet_ledger(id,wallet_id,currency,entry_type,amount,available_delta,reserved_delta,reference_type,reference_id,idempotency_key,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      randomUUID(),
      wallet.id,
      wallet.currency,
      type,
      amount.toString(),
      available.toString(),
      reserved.toString(),
      ref.type,
      ref.id,
      ref.key,
      JSON.stringify(metadata),
    ],
  );
  const event =
    {
      PURCHASE: "wallet.credited",
      REFUND: "wallet.refunded",
      RESERVATION: "wallet.reserved",
      CAPTURE: "wallet.captured",
      RELEASE: "wallet.released",
    }[type] || "wallet.adjusted";
  await outbox(tx, event, wallet.id, `ledger:${ref.key}`, {
    walletId: wallet.id,
    amount: amount.toString(),
    currency: wallet.currency,
    referenceType: ref.type,
    referenceId: ref.id,
  });
  return true;
}
// All operations require a caller-owned transaction so payments/calls and events commit together.
export async function credit(
  tx: PoolClient,
  userId: string,
  amount: bigint,
  ref: Reference,
  currency = "JPY",
) {
  const wallet = await lockWallet(tx, userId, currency);
  await entry(tx, wallet, "PURCHASE", amount, amount, 0n, ref);
  return wallet.id;
}
export async function adjustPayment(
  tx: PoolClient, wallet: Wallet, delta: bigint, paymentId: string, revision: string,
) {
  if (delta === 0n) return;
  await entry(tx, wallet, "ADJUSTMENT", delta < 0n ? -delta : delta, delta, 0n, {
    type: "payment_reversal", id: paymentId, key: `reversal:${paymentId}:${revision}`,
  });
}
export async function reserve(
  tx: PoolClient,
  walletId: string,
  amount: bigint,
  ref: Reference,
  reviewAfter: Date,
) {
  positive(amount);
  const wallet = await walletById(tx, walletId);
  const prior = (
    await tx.query(
      "SELECT * FROM wallet_reservations WHERE reference_type=$1 AND reference_id=$2",
      [ref.type, ref.id],
    )
  ).rows[0];
  if (prior) {
    if (prior.wallet_id !== walletId || BigInt(prior.amount) !== amount)
      throw new Error("IDEMPOTENCY_CONFLICT");
    return prior.id as string;
  }
  const id = randomUUID();
  await tx.query(
    "INSERT INTO wallet_reservations(id,wallet_id,reference_type,reference_id,amount,review_after) VALUES($1,$2,$3,$4,$5,$6)",
    [id, wallet.id, ref.type, ref.id, amount.toString(), reviewAfter],
  );
  if (!(await entry(tx, wallet, "RESERVATION", amount, -amount, amount, ref)))
    throw new Error("IDEMPOTENCY_CONFLICT");
  return id;
}
async function moveReservation(
  tx: PoolClient,
  id: string,
  amount: bigint,
  key: string,
  type: "CAPTURE" | "RELEASE",
) {
  positive(amount);
  const row = (
    await tx.query("SELECT wallet_id FROM wallet_reservations WHERE id=$1", [
      id,
    ])
  ).rows[0];
  if (!row) throw new Error("RESERVATION_NOT_FOUND");
  const wallet = await walletById(tx, row.wallet_id);
  const reservation = (
    await tx.query("SELECT * FROM wallet_reservations WHERE id=$1 FOR UPDATE", [
      id,
    ])
  ).rows[0];
  const ref = { type: "reservation", id, key };
  const prior = (
    await tx.query("SELECT * FROM wallet_ledger WHERE idempotency_key=$1", [
      key,
    ])
  ).rows[0];
  if (prior) {
    await entry(
      tx,
      wallet,
      type,
      amount,
      type === "RELEASE" ? amount : 0n,
      -amount,
      ref,
    );
    return;
  }
  if (
    amount >
    BigInt(reservation.amount) -
      BigInt(reservation.captured) -
      BigInt(reservation.released)
  )
    throw new Error("RESERVATION_EXCEEDED");
  await entry(
    tx,
    wallet,
    type,
    amount,
    type === "RELEASE" ? amount : 0n,
    -amount,
    ref,
  );
  const column = type === "CAPTURE" ? "captured" : "released";
  await tx.query(
    `UPDATE wallet_reservations SET ${column}=${column}+$2,updated_at=now() WHERE id=$1`,
    [id, amount.toString()],
  );
}
export const capture = (
  tx: PoolClient,
  id: string,
  amount: bigint,
  key: string,
) => moveReservation(tx, id, amount, key, "CAPTURE");
export const release = (
  tx: PoolClient,
  id: string,
  amount: bigint,
  key: string,
) => moveReservation(tx, id, amount, key, "RELEASE");
// Refund restores captured usage credit; this is not a cash withdrawal or Stripe refund.
export async function refund(
  tx: PoolClient,
  captureEntryId: string,
  amount: bigint,
  key: string,
) {
  positive(amount);
  const original = (
    await tx.query(
      "SELECT * FROM wallet_ledger WHERE id=$1 AND entry_type='CAPTURE'",
      [captureEntryId],
    )
  ).rows[0];
  if (!original) throw new Error("CAPTURE_NOT_FOUND");
  const wallet = await walletById(tx, original.wallet_id);
  const prior = (
    await tx.query("SELECT 1 FROM wallet_ledger WHERE idempotency_key=$1", [
      key,
    ])
  ).rows[0];
  if (!prior) {
    const returned = (
      await tx.query(
        "SELECT coalesce(sum(amount),0)::text AS amount FROM wallet_ledger WHERE entry_type='REFUND' AND reference_type='ledger' AND reference_id=$1",
        [captureEntryId],
      )
    ).rows[0];
    if (BigInt(returned.amount) + amount > BigInt(original.amount))
      throw new Error("REFUND_EXCEEDED");
  }
  await entry(tx, wallet, "REFUND", amount, amount, 0n, {
    type: "ledger",
    id: captureEntryId,
    key,
  });
}
