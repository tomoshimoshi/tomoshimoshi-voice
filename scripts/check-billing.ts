import "dotenv/config";
import { stripeConfig } from "../server/billing/stripe/config";
import { stripeClient } from "../server/billing/stripe";
import { packages, type PackageCode } from "../server/billing/packages";
import { database, closeDatabase } from "../server/database";

// Read-only preflight. Does not create sessions, charge cards or alter balances.
try {
  const config = stripeConfig();
  const stripe = stripeClient();
  for (const [code, definition] of Object.entries(packages)) {
    const price = await stripe.prices.retrieve(config.prices[code as PackageCode]);
    if (price.livemode !== config.livemode || !price.active || price.type !== "one_time" ||
        price.currency !== "jpy" || price.unit_amount !== Number(definition.amount))
      throw new Error(`Invalid price: ${code}`);
    console.log(`${code}: valid ${config.livemode ? "live" : "test"} JPY price`);
  }
  for (const [name, read] of [
    ["Checkout Sessions", () => stripe.checkout.sessions.list({ limit: 1 })],
    ["PaymentIntents", () => stripe.paymentIntents.list({ limit: 1 })],
    ["Refunds", () => stripe.refunds.list({ limit: 1 })],
    ["Disputes", () => stripe.disputes.list({ limit: 1 })],
  ] as const) {
    await read();
    console.log(`${name}: read permission verified`);
  }
  await database().query("SELECT payment_id FROM payment_reversals LIMIT 0");
  const contaminated = await database().query(`SELECT count(*)::text AS count FROM payments p
    JOIN wallets w ON w.user_id=p.user_id AND w.currency='JPY'
    WHERE p.livemode<>$1 AND p.status='succeeded' AND (w.available_balance>0 OR w.reserved_balance>0)`, [config.livemode]);
  if (contaminated.rows[0].count !== "0") throw new Error("Review wallets funded in the other Stripe mode before rollout; do not delete their ledger");
  console.log("Billing schema and payment-mode isolation: checked. Checkout write permission and signed webhook delivery still require deployment verification.");
} catch (error) {
  console.error(error instanceof Error && !("raw" in error) ? error.message : "Stripe preflight failed: check restricted-key permissions and connectivity");
  process.exitCode = 1;
} finally { await closeDatabase(); }
