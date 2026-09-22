export type Payment = {
  id: string;
  provider: string;
  user_id: string;
  package_code: string;
  provider_price_id: string;
  amount: string;
  currency: string;
  provider_session_id: string | null;
  provider_payment_id: string | null;
  status: string;
  checkout_url: string | null;
  created_at: Date;
};
export type PaymentConfirmation = {
  sessionId: string;
  paymentId: string;
  amount: bigint;
  currency: string;
  priceId: string;
  quantity: number;
  paid: boolean;
  metadata: Record<string, string>;
};
export interface PaymentProvider {
  createCheckout(payment: Payment): Promise<{ id: string; url: string }>;
  confirmation(sessionId: string): Promise<PaymentConfirmation>;
}
