import "dotenv/config";
import { parseArgs } from "node:util";
import { z } from "zod";
import { database, closeDatabase } from "../server/database";
import { reconcileCall } from "../server/calls/billing";
const { values } = parseArgs({
  options: {
    call: { type: "string" },
    connected: { type: "string" },
    ended: { type: "string" },
    unconnected: { type: "boolean" },
    evidence: { type: "string" },
    "verified-no-leg": { type: "boolean" },
  },
});
try {
  if (values.call) {
    const id = z.uuid().parse(values.call);
    const end = z.iso.datetime({ offset: true }).parse(values.ended);
    if (!!values.connected === !!values.unconnected)
      throw new Error("Specify exactly one of --connected or --unconnected");
    const connected = values.unconnected
      ? null
      : z.iso.datetime({ offset: true }).parse(values.connected);
    const evidence = z.string().min(10).max(500).parse(values.evidence);
    const record = (
      await database().query(
        "SELECT b.*,c.status AS call_status,c.created_at FROM call_billing b JOIN calls c ON c.id=b.call_id WHERE call_id=$1",
        [id],
      )
    ).rows[0];
    if (!record) throw new Error("Call financial record not found");
    if (!["completed", "cancelled", "failed"].includes(record.call_status))
      throw new Error("End the application call before reconciliation");
    if (
      Date.parse(connected || end) <
      new Date(record.created_at).getTime() - 5000
    )
      throw new Error("Evidence predates this call");
    if (record.provider_control_id) {
      if (!process.env.TELNYX_API_KEY?.trim())
        throw new Error("TELNYX_API_KEY is required to verify termination");
      const response = await fetch(
        `https://api.telnyx.com/v2/calls/${encodeURIComponent(record.provider_control_id)}`,
        {
          headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok || (await response.json()).data?.is_alive !== false)
        throw new Error(
          "Carrier termination cannot be confirmed. Reservation remains held.",
        );
    } else if (!record.termination_confirmed) {
      if (
        !values["verified-no-leg"] ||
        !values.unconnected ||
        Date.now() - new Date(record.created_at).getTime() <
          (record.max_duration_seconds + 300) * 1000
      )
        throw new Error(
          "No provider termination evidence. After confirming no carrier leg exists and the safety window has elapsed, use --unconnected --verified-no-leg with an audit reference. Never guess.",
        );
    }
    const changed = await reconcileCall({
      callId: id,
      connectedAt: connected,
      endedAt: end,
      evidence,
    });
    console.log(
      changed
        ? "Call reconciled; ledger, balance, charge and outbox committed."
        : "Call already settled; no change.",
    );
  } else {
    const mismatch = await database()
      .query(`SELECT w.id,w.user_id,w.currency,w.available_balance::text,w.reserved_balance::text,
      coalesce(l.available,0)::text AS ledger_available,coalesce(l.reserved,0)::text AS ledger_reserved,
      coalesce(r.held,0)::text AS reservation_held FROM wallets w
      LEFT JOIN (SELECT wallet_id,sum(available_delta) AS available,sum(reserved_delta) AS reserved FROM wallet_ledger GROUP BY wallet_id) l ON l.wallet_id=w.id
      LEFT JOIN (SELECT wallet_id,sum(amount-captured-released) AS held FROM wallet_reservations GROUP BY wallet_id) r ON r.wallet_id=w.id
      WHERE w.available_balance<>coalesce(l.available,0) OR w.reserved_balance<>coalesce(l.reserved,0) OR w.reserved_balance<>coalesce(r.held,0)`);
    const pending = await database().query(
      `SELECT b.call_id,b.status,b.connected_at,b.ended_at,b.termination_confirmed,r.review_after,(r.amount-r.captured-r.released)::text AS held FROM call_billing b JOIN wallet_reservations r ON r.id=b.reservation_id WHERE b.status<>'settled' AND r.review_after<now() ORDER BY r.review_after`,
    );
    const payments = await database().query(
      "SELECT id,status,created_at FROM payments WHERE status='pending' AND created_at<now()-interval '1 hour' ORDER BY created_at",
    );
    const outbox = await database().query(
      "SELECT count(*)::text AS unprocessed FROM outbox_events WHERE processed_at IS NULL",
    );
    console.log(
      JSON.stringify(
        {
          walletMismatches: mismatch.rows,
          overdueCalls: pending.rows,
          pendingPayments: payments.rows,
          outbox: outbox.rows[0],
        },
        null,
        2,
      ),
    );
    if (mismatch.rows.length || pending.rows.length || payments.rows.length)
      process.exitCode = 1;
  }
} catch (error) {
  console.error(
    error instanceof z.ZodError
      ? "Invalid arguments. See docs/BILLING.md for reconciliation usage."
      : error instanceof Error && !("code" in error)
        ? error.message
        : "Reconciliation failed; no partial financial changes committed.",
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
