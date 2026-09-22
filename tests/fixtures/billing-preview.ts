// Isolated local browser fixture: real application API + migrated PGlite, no .env/providers.
import { testDatabase } from "../helpers/postgres";
import { mock } from "node:test";
import pg from "pg";
import { checkout } from "../../server/billing/payments";
import { ensureUser, saveProfile, defaultProfile } from "../../server/store";
import { stripeProvider } from "../../server/billing/stripe";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.CALLORI_INTERNAL_TOKEN =
  "billing-preview-only-internal-token-123456789";
process.env.VOICE_PORT = "3191";
process.env.LIVE_CALLS_ENABLED = "false";
process.env.APP_BASE_URL = "http://localhost:3190";
Object.assign(process.env, {
  STRIPE_SECRET_KEY: "sk_test_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_fixture",
  STRIPE_PRICE_CREDIT_1000: "price_1000",
  STRIPE_PRICE_CREDIT_2000: "price_2000",
  STRIPE_PRICE_CREDIT_5000: "price_5000",
});
for (const key of [
  "OPENAI_API_KEY",
  "TELNYX_API_KEY",
  "TELNYX_CONNECTION_ID",
  "TELNYX_PUBLIC_KEY",
])
  process.env[key] = "";
mock.method(pg.Client.prototype, "connect", async () => {});
mock.method(pg.Client.prototype, "query", async (sql: string) =>
  testDatabase.query(sql),
);
mock.method(pg.Client.prototype, "end", async () => {});
mock.method(stripeProvider, "createCheckout", async () => {
  throw new Error("Preview payments disabled");
});
const user = await ensureUser({
  sub: "development|local-workspace",
  email: "developer@localhost.test",
  emailVerified: false,
});
await saveProfile(
  { ...defaultProfile, firstName: "Alex", lastName: "Rivera" },
  user,
);
const previewPayment = await checkout(
  user,
  "credit_1000",
  "00000000-0000-4000-8000-000000000001",
  {
    async createCheckout(p) {
      return {
        id: `cs_fixture_${p.id}`,
        url: `https://checkout.stripe.com/c/pay/cs_fixture_${p.id}`,
      };
    },
    async confirmation() {
      throw new Error("Use fixture confirmation");
    },
  },
);
mock.method(stripeProvider, "confirmation", async (sessionId: string) => {
  const p = (
    await testDatabase.query<{
      id: string;
      user_id: string;
      amount: string;
      provider_price_id: string;
      package_code: string;
    }>("SELECT * FROM payments WHERE provider_session_id=$1", [sessionId])
  ).rows[0];
  if (!p) throw new Error("Unknown fixture payment");
  return {
    sessionId,
    paymentId: `pi_fixture_${p.id}`,
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
  };
});
console.log(
  JSON.stringify({
    previewPaymentId: previewPayment.paymentId,
    previewUserId: user,
  }),
);
await import("../../server/index");
