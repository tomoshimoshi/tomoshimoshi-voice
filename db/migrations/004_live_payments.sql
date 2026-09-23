-- Existing payments were created by the test-only adapter. Preserve their history.
ALTER TABLE payments ADD COLUMN livemode boolean NOT NULL DEFAULT false;
CREATE FUNCTION protect_payment_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.livemode IS DISTINCT FROM OLD.livemode THEN
    RAISE EXCEPTION 'Payment mode is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_mode_history BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION protect_payment_mode();

-- Cumulative reversals are reconciled to immutable ADJUSTMENT ledger entries.
-- A shortfall blocks new calls without making the wallet negative or taking reserved funds.
CREATE TABLE payment_reversals (
  payment_id uuid PRIMARY KEY REFERENCES payments(id) ON DELETE RESTRICT,
  required_amount bigint NOT NULL CHECK (required_amount >= 0),
  debited_amount bigint NOT NULL CHECK (debited_amount >= 0),
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON payment_reversals FROM PUBLIC;
