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
  const mode = process.env.STRIPE_MODE?.trim() ||
    (process.env.NODE_ENV === "production" ? "live" : "test");
  if (mode !== "live" && mode !== "test")
    throw new BillingConfigurationError("STRIPE_MODE must be live or test");
  const secret = required("STRIPE_SECRET_KEY");
  if (!new RegExp(`^(sk|rk)_${mode}_.+`).test(secret))
    throw new BillingConfigurationError(`STRIPE_SECRET_KEY must be a ${mode} secret or restricted key`);
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
        mode === "test" &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new BillingConfigurationError(
      "APP_BASE_URL must be an HTTPS origin (HTTP loopback allowed locally)",
    );
  return { secret, webhookSecret, prices, origin: url.origin, livemode: mode === "live" };
}
