-- JPY amounts are whole yen. bigint values cross the API as decimal strings.
CREATE TABLE pricing_versions (
  id text PRIMARY KEY,
  destination text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rate_per_minute bigint NOT NULL CHECK (rate_per_minute > 0),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, currency, rate_per_minute)
);
CREATE UNIQUE INDEX pricing_active_destination ON pricing_versions(destination,currency) WHERE active;
INSERT INTO pricing_versions(id,destination,currency,rate_per_minute,active)
VALUES('japan-domestic-v1','JP','JPY',125,true);
CREATE TABLE wallets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  available_balance bigint NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
  reserved_balance bigint NOT NULL DEFAULT 0 CHECK (reserved_balance >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,currency), UNIQUE(id,currency)
);
CREATE TABLE wallet_ledger (
  id uuid PRIMARY KEY,
  wallet_id uuid NOT NULL,
  currency text NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('PURCHASE','RESERVATION','CAPTURE','RELEASE','REFUND','ADJUSTMENT')),
  amount bigint NOT NULL CHECK (amount > 0),
  available_delta bigint NOT NULL,
  reserved_delta bigint NOT NULL,
  reference_type text NOT NULL,
  reference_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(wallet_id,currency) REFERENCES wallets(id,currency) ON DELETE RESTRICT,
  CHECK (
    (entry_type IN ('PURCHASE','REFUND') AND available_delta=amount AND reserved_delta=0) OR
    (entry_type='RESERVATION' AND available_delta=-amount AND reserved_delta=amount) OR
    (entry_type='CAPTURE' AND available_delta=0 AND reserved_delta=-amount) OR
    (entry_type='RELEASE' AND available_delta=amount AND reserved_delta=-amount) OR
    (entry_type='ADJUSTMENT' AND abs(available_delta)=amount AND reserved_delta=0)
  )
);
CREATE INDEX ledger_wallet_created ON wallet_ledger(wallet_id,created_at,id);
CREATE INDEX ledger_reference ON wallet_ledger(reference_type,reference_id);
CREATE UNIQUE INDEX ledger_one_purchase ON wallet_ledger(reference_type,reference_id) WHERE entry_type='PURCHASE';
CREATE TABLE wallet_reservations (
  id uuid PRIMARY KEY,
  wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  reference_type text NOT NULL,
  reference_id text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  captured bigint NOT NULL DEFAULT 0 CHECK (captured >= 0),
  released bigint NOT NULL DEFAULT 0 CHECK (released >= 0),
  review_after timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(reference_type,reference_id),
  CHECK (captured+released <= amount)
);
CREATE INDEX reservation_review ON wallet_reservations(review_after) WHERE captured+released < amount;
CREATE TABLE payments (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_payment_id text,
  provider_session_id text,
  provider_price_id text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency='JPY'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','expired')),
  package_code text NOT NULL CHECK (package_code IN ('credit_1000','credit_2000','credit_5000')),
  request_key uuid NOT NULL,
  checkout_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_payment_id),
  UNIQUE(provider,provider_session_id),
  UNIQUE(user_id,request_key),
  CHECK ((package_code='credit_1000' AND amount=1000) OR (package_code='credit_2000' AND amount=2000) OR (package_code='credit_5000' AND amount=5000))
);
CREATE INDEX payments_user_created ON payments(user_id,created_at DESC);
CREATE TABLE billing_provider_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payment_id uuid REFERENCES payments(id) ON DELETE RESTRICT,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,event_id)
);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  aggregate_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
CREATE INDEX outbox_pending ON outbox_events(created_at,id) WHERE processed_at IS NULL;
-- Financial state is separate from mutable call transcript snapshots and provider costs.
CREATE TABLE call_billing (
  call_id uuid PRIMARY KEY REFERENCES calls(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL UNIQUE REFERENCES wallet_reservations(id) ON DELETE RESTRICT,
  pricing_version_id text NOT NULL,
  currency text NOT NULL CHECK (currency='JPY'),
  rate_per_minute bigint NOT NULL CHECK (rate_per_minute > 0),
  max_duration_seconds integer NOT NULL CHECK (max_duration_seconds >= 30),
  connected_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer CHECK (duration_seconds >= 0),
  customer_charge_jpy bigint CHECK (customer_charge_jpy >= 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','pending','settled')),
  provider_control_id text,
  termination_confirmed boolean NOT NULL DEFAULT false,
  settlement_evidence text,
  settled_at timestamptz,
  telnyx_cost numeric(20,8) CHECK (telnyx_cost >= 0),
  openai_cost numeric(20,8) CHECK (openai_cost >= 0),
  provider_cost_currency text CHECK (provider_cost_currency ~ '^[A-Z]{3}$'),
  FOREIGN KEY(pricing_version_id,currency,rate_per_minute) REFERENCES pricing_versions(id,currency,rate_per_minute),
  CHECK (ended_at IS NULL OR connected_at IS NULL OR ended_at >= connected_at),
  CHECK (status <> 'settled' OR (termination_confirmed AND duration_seconds IS NOT NULL AND customer_charge_jpy IS NOT NULL AND settled_at IS NOT NULL AND settlement_evidence IS NOT NULL))
);
CREATE INDEX call_billing_pending ON call_billing(status) WHERE status <> 'settled';
CREATE TABLE call_billing_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  call_id uuid NOT NULL REFERENCES call_billing(call_id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,event_id)
);
CREATE FUNCTION reject_financial_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Financial history is immutable'; END $$;
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION reject_financial_rewrite();
CREATE TRIGGER immutable_billing_events BEFORE UPDATE OR DELETE ON billing_provider_events FOR EACH ROW EXECUTE FUNCTION reject_financial_rewrite();
CREATE TRIGGER immutable_call_events BEFORE UPDATE OR DELETE ON call_billing_events FOR EACH ROW EXECUTE FUNCTION reject_financial_rewrite();
CREATE FUNCTION protect_pricing_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.id,NEW.destination,NEW.currency,NEW.rate_per_minute,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.destination,OLD.currency,OLD.rate_per_minute,OLD.created_at) THEN
    RAISE EXCEPTION 'Pricing history is immutable; create a new version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_pricing BEFORE UPDATE OR DELETE ON pricing_versions FOR EACH ROW EXECUTE FUNCTION protect_pricing_version();
CREATE FUNCTION protect_call_billing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.call_id,NEW.reservation_id,NEW.pricing_version_id,NEW.currency,NEW.rate_per_minute,NEW.max_duration_seconds) IS DISTINCT FROM (OLD.call_id,OLD.reservation_id,OLD.pricing_version_id,OLD.currency,OLD.rate_per_minute,OLD.max_duration_seconds)
    OR (OLD.status='settled' AND (NEW.connected_at,NEW.ended_at,NEW.duration_seconds,NEW.customer_charge_jpy,NEW.status,NEW.termination_confirmed,NEW.settlement_evidence,NEW.settled_at) IS DISTINCT FROM (OLD.connected_at,OLD.ended_at,OLD.duration_seconds,OLD.customer_charge_jpy,OLD.status,OLD.termination_confirmed,OLD.settlement_evidence,OLD.settled_at)) THEN
    RAISE EXCEPTION 'Call pricing and settled charges are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_call_finance BEFORE UPDATE OR DELETE ON call_billing FOR EACH ROW EXECUTE FUNCTION protect_call_billing();
-- Applying a ledger entry changes both projections inside the same transaction.
CREATE FUNCTION apply_wallet_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wallets SET available_balance=available_balance+NEW.available_delta,
    reserved_balance=reserved_balance+NEW.reserved_delta,updated_at=now() WHERE id=NEW.wallet_id;
  RETURN NEW;
END $$;
CREATE TRIGGER apply_ledger AFTER INSERT ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION apply_wallet_entry();
-- Catch accidental projection-only writes or a reservation/ledger mismatch at commit.
CREATE FUNCTION verify_wallet_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a numeric; r numeric; held numeric; w wallets%ROWTYPE;
BEGIN
  SELECT * INTO w FROM wallets WHERE id=NEW.id;
  SELECT coalesce(sum(available_delta),0),coalesce(sum(reserved_delta),0) INTO a,r FROM wallet_ledger WHERE wallet_id=NEW.id;
  SELECT coalesce(sum(amount-captured-released),0) INTO held FROM wallet_reservations WHERE wallet_id=NEW.id;
  IF w.available_balance<>a OR w.reserved_balance<>r OR r<>held THEN RAISE EXCEPTION 'Wallet does not reconcile'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wallet_reconciles AFTER INSERT OR UPDATE ON wallets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_wallet_projection();
REVOKE ALL ON pricing_versions,wallets,wallet_ledger,wallet_reservations,payments,billing_provider_events,outbox_events,call_billing,call_billing_events FROM PUBLIC;
CREATE VIEW calls_with_billing AS
SELECT c.id,c.user_id,c.status,c.created_at,
  c.data || CASE WHEN b.call_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('billing',jsonb_build_object(
    'pricingVersionId',b.pricing_version_id,'ratePerMinute',b.rate_per_minute::text,
    'maxDurationSeconds',b.max_duration_seconds,'connectedAt',b.connected_at,'endedAt',b.ended_at,
    'durationSeconds',b.duration_seconds,'customerChargeJpy',b.customer_charge_jpy::text,'status',b.status
  )) END AS data
FROM calls c LEFT JOIN call_billing b ON b.call_id=c.id;
REVOKE ALL ON calls_with_billing FROM PUBLIC;
CREATE FUNCTION protect_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.id,NEW.wallet_id,NEW.reference_type,NEW.reference_id,NEW.amount,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.wallet_id,OLD.reference_type,OLD.reference_id,OLD.amount,OLD.created_at) OR NEW.captured<OLD.captured OR NEW.released<OLD.released THEN
    RAISE EXCEPTION 'Reservation history cannot be rewritten';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reservation_history BEFORE UPDATE OR DELETE ON wallet_reservations FOR EACH ROW EXECUTE FUNCTION protect_reservation();
CREATE FUNCTION verify_reservation_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE held numeric; r bigint;
BEGIN
  SELECT reserved_balance INTO r FROM wallets WHERE id=NEW.wallet_id;
  SELECT coalesce(sum(amount-captured-released),0) INTO held FROM wallet_reservations WHERE wallet_id=NEW.wallet_id;
  IF r<>held THEN RAISE EXCEPTION 'Reservation does not reconcile'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reservation_reconciles AFTER INSERT OR UPDATE ON wallet_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_reservation_projection();
CREATE FUNCTION protect_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.id,NEW.user_id,NEW.provider,NEW.provider_price_id,NEW.amount,NEW.currency,NEW.package_code,NEW.request_key,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.provider,OLD.provider_price_id,OLD.amount,OLD.currency,OLD.package_code,OLD.request_key,OLD.created_at)
    OR (OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id)
    OR (OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id)
    OR (OLD.status='succeeded' AND NEW.status<>'succeeded') THEN
    RAISE EXCEPTION 'Payment history cannot be rewritten';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_history BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION protect_payment();
-- Existing and newly created accounts each start with one empty JPY wallet.
INSERT INTO wallets(id,user_id,currency) SELECT gen_random_uuid(),id,'JPY' FROM users;
CREATE FUNCTION initialize_user_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wallets(id,user_id,currency) VALUES(gen_random_uuid(),NEW.id,'JPY');
  RETURN NEW;
END $$;
CREATE TRIGGER user_jpy_wallet AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION initialize_user_wallet();
CREATE FUNCTION protect_wallet_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.user_id,NEW.currency,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.currency,OLD.created_at) THEN
    RAISE EXCEPTION 'Wallets cannot be transferred or converted';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_identity BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION protect_wallet_identity();
CREATE FUNCTION verify_call_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM wallet_reservations r JOIN wallets w ON w.id=r.wallet_id JOIN calls c ON c.id=NEW.call_id
    WHERE r.id=NEW.reservation_id AND r.reference_type='call' AND r.reference_id=NEW.call_id::text AND w.user_id=c.user_id AND w.currency=NEW.currency) THEN
    RAISE EXCEPTION 'Call reservation must belong to the calling user';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER call_reservation_owner BEFORE INSERT ON call_billing FOR EACH ROW EXECUTE FUNCTION verify_call_reservation();
