-- Applied once by scripts/migrate.ts, inside a transaction.
CREATE TABLE users (
  id uuid PRIMARY KEY,
  auth0_sub text UNIQUE CHECK (length(auth0_sub) BETWEEN 1 AND 255),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  email_verified boolean NOT NULL DEFAULT false,
  legacy_owner boolean NOT NULL DEFAULT false,
  last_call_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (auth0_sub IS NOT NULL OR legacy_owner)
);
-- Email is an attribute, never the identity key. Only one reserved legacy owner.
CREATE UNIQUE INDEX users_legacy_owner_idx ON users (legacy_owner) WHERE legacy_owner;
CREATE INDEX users_email_idx ON users (lower(email));
CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE calls (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('dialing','connected','waiting','completed','cancelled','failed')),
  created_at timestamptz NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND data->>'id' = id::text AND data->>'status' = status),
  UNIQUE(user_id, id)
);
CREATE INDEX calls_user_created_idx ON calls(user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX calls_one_active_per_user_idx ON calls(user_id) WHERE status IN ('dialing','connected','waiting');
CREATE INDEX calls_active_idx ON calls(created_at) WHERE status IN ('dialing','connected','waiting');
CREATE TABLE requests (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key uuid NOT NULL,
  call_id uuid NOT NULL,
  PRIMARY KEY(user_id, key),
  FOREIGN KEY(user_id, call_id) REFERENCES calls(user_id, id) ON DELETE CASCADE
);
CREATE INDEX requests_call_idx ON requests(call_id);
CREATE TABLE provider_calls (
  id uuid PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  control_id text NOT NULL,
  hangup_id uuid
);
CREATE TABLE webhooks (
  id text PRIMARY KEY,
  received timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_received_idx ON webhooks(received);
CREATE TABLE contacts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  place_id text NOT NULL CHECK (length(place_id) BETWEEN 1 AND 255),
  country text NOT NULL CHECK (country = 'JP'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, place_id)
);
CREATE INDEX contacts_user_created_idx ON contacts(user_id, created_at DESC);
-- Timestamped consent is immutable and separate from mutable call state.
CREATE TABLE call_consents (
  call_id uuid PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  share_profile boolean NOT NULL,
  policy_version text NOT NULL DEFAULT '2026-09-22',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(user_id, call_id) REFERENCES calls(user_id, id) ON DELETE CASCADE
);
CREATE INDEX call_consents_user_idx ON call_consents(user_id);
CREATE TABLE data_imports (
  name text PRIMARY KEY,
  imported_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
