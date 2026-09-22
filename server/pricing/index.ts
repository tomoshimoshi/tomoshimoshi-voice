import { database } from "../database";
import type { PoolClient } from "pg";
export type Pricing = { id: string; currency: string; rate_per_minute: string };
export function chargeForSeconds(seconds: number, rate: bigint): bigint {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || rate <= 0n)
    throw new Error("INVALID_DURATION");
  return (BigInt(seconds) * rate + 59n) / 60n;
}
export function affordableSeconds(amount: bigint, rate: bigint): bigint {
  if (amount < 0n || rate <= 0n) throw new Error("INVALID_AMOUNT");
  return (amount * 60n) / rate;
}
export async function activePricing(
  tx: Pick<PoolClient, "query"> = database(),
  destination = "JP",
): Promise<Pricing> {
  const { rows } = await tx.query(
    "SELECT id,currency,rate_per_minute::text FROM pricing_versions WHERE destination=$1 AND currency='JPY' AND active",
    [destination],
  );
  if (!rows[0]) throw new Error("PRICING_NOT_CONFIGURED");
  return rows[0];
}
