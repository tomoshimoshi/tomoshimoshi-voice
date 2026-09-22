import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
export function billingLog(event: string, ids: Record<string, string> = {}) {
  console.info(JSON.stringify({ event, ...ids }));
}
// Persisted for future consumers; do not mark processed without a durable consumer.
export async function outbox(
  tx: PoolClient,
  event: string,
  aggregateId: string,
  key: string,
  payload: Record<string, unknown>,
) {
  await tx.query(
    `INSERT INTO outbox_events(id,event_type,aggregate_id,idempotency_key,payload) VALUES($1,$2,$3,$4,$5)`,
    [randomUUID(), event, aggregateId, key, JSON.stringify(payload)],
  );
}
