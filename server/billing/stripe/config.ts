import { packages, type PackageCode } from "../packages";
export class BillingConfigurationError extends Error {
  constructor(name: string) {
    super(`Billing configuration: ${name}`);
  }
}
function required(name: string, prefix?: string) {
  const value = process.env[name]?.trim();
  if (!value || (prefix && !value.startsWith(prefix)))
    throw new BillingConfigurationError(
      `${name} is required${prefix ? ` and must start with ${prefix}` : ""}`,
    );
  return value;
}
export function stripeConfig() {
  // Explicit test-only guard for this release. No fallback credentials.
  const secret = required("STRIPE_SECRET_KEY", "sk_test_");
  const webhookSecret = required("STRIPE_WEBHOOK_SECRET", "whsec_");
  const prices = Object.fromEntries(
    Object.entries(packages).map(([code, p]) => [
      code,
      required(p.env, "price_"),
    ]),
  ) as Record<PackageCode, string>;
  if (new Set(Object.values(prices)).size !== 3)
    throw new BillingConfigurationError(
      "the three Stripe Price IDs must be distinct",
    );
  const base = required("APP_BASE_URL");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new BillingConfigurationError(
      "APP_BASE_URL must be an absolute origin",
    );
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new BillingConfigurationError(
      "APP_BASE_URL must be an HTTPS origin (HTTP loopback allowed locally)",
    );
  return { secret, webhookSecret, prices, origin: url.origin };
}
