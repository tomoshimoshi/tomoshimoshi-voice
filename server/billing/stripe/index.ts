import Stripe from "stripe";
import type { Payment, PaymentProvider } from "../provider";
import { stripeConfig } from "./config";
import { packageDefinition } from "../packages";
export function stripeClient() {
  return new Stripe(stripeConfig().secret, {
    maxNetworkRetries: 2,
    timeout: 12000,
  });
}
export function verifiedStripeEvent(raw: string, signature: string) {
  const config = stripeConfig();
  return new Stripe(config.secret).webhooks.constructEvent(
    raw,
    signature,
    config.webhookSecret,
  );
}
export function stripeAdapter(stripe: Stripe): PaymentProvider {
  return {
    async createCheckout(payment: Payment) {
      const config = stripeConfig();
      const price = await stripe.prices.retrieve(payment.provider_price_id);
      if (
        price.livemode !== config.livemode ||
        !price.active ||
        price.type !== "one_time" ||
        price.currency !== "jpy" ||
        price.unit_amount === null ||
        BigInt(price.unit_amount) !==
          packageDefinition(payment.package_code).amount
      )
        throw new Error("INVALID_STRIPE_PRICE");
      const metadata = {
        user_id: payment.user_id,
        payment_id: payment.id,
        package_code: payment.package_code,
      };
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          adaptive_pricing: { enabled: false },
          custom_text: {
            submit: { message: `Prepaid JPY credit. No expiry or subscription. No voluntary refunds; billing errors and statutory rights excepted. Terms: ${config.origin}/terms · Sales: ${config.origin}/commerce` },
          },
          integration_identifier: "tomoshimoshi_credits_qmzpavhk",
          line_items: [{ price: payment.provider_price_id, quantity: 1 }],
          client_reference_id: payment.id,
          metadata,
          payment_intent_data: { metadata },
          success_url: `${config.origin}/credits?payment=${payment.id}`,
          cancel_url: `${config.origin}/credits?cancelled=1`,
          expires_at:
            Math.floor(new Date(payment.created_at).getTime() / 1000) + 3600,
        },
        { idempotencyKey: `checkout:${payment.id}` },
      );
      if (!session.url || session.livemode !== config.livemode)
        throw new Error("CHECKOUT_UNAVAILABLE");
      const url = new URL(session.url);
      if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com")
        throw new Error("CHECKOUT_UNAVAILABLE");
      return { id: session.id, url: session.url };
    },
    async confirmation(sessionId) {
      const { livemode } = stripeConfig();
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["payment_intent", "line_items.data.price"],
      });
      const lines = session.line_items;
      const intent = session.payment_intent as Stripe.PaymentIntent | null;
      const line = lines?.data[0],
        price = line?.price;
      if (
        session.livemode !== livemode ||
        session.mode !== "payment" ||
        !lines ||
        lines.has_more ||
        lines.data.length !== 1 ||
        !price ||
        price.livemode !== livemode ||
        price.currency !== "jpy" ||
        price.type !== "one_time" ||
        !intent ||
        typeof intent === "string" ||
        intent.livemode !== livemode
      )
        throw new Error("PAYMENT_MISMATCH");
      const definition = packageDefinition(
        session.metadata?.package_code || "",
      );
      const metadata = session.metadata || {};
      if (
        session.client_reference_id !== metadata.payment_id ||
        ["payment_id", "user_id", "package_code"].some(
          (key) => intent.metadata[key] !== metadata[key],
        ) ||
        session.amount_total === null ||
        BigInt(session.amount_total) !== definition.amount ||
        BigInt(intent.amount_received) !== definition.amount ||
        intent.currency !== "jpy" ||
        line.amount_total !== session.amount_total ||
        price.unit_amount !== session.amount_total
      )
        throw new Error("PAYMENT_MISMATCH");
      return {
        sessionId: session.id,
        paymentId: intent.id,
        amount: BigInt(session.amount_total),
        currency: session.currency || "",
        priceId: price.id,
        quantity: line.quantity || 0,
        paid:
          session.payment_status === "paid" && intent.status === "succeeded",
        metadata,
      };
    },
  };
}
export const stripeProvider: PaymentProvider = {
  createCheckout: (payment) =>
    stripeAdapter(stripeClient()).createCheckout(payment),
  confirmation: (id) => stripeAdapter(stripeClient()).confirmation(id),
};
