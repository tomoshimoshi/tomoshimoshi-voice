# Prepaid credit and billing

ToMoshiMoshi sells ¥1,000, ¥2,000 and ¥5,000 of JPY credit. One purchased yen is one wallet yen. **Credits never expire**, cannot be transferred, and cannot be withdrawn as cash. There are no subscriptions. The current domestic Japan rate is **¥125/minute**. Package estimates are 8, 16 and 40 minutes; the asset purchased is yen credit.

## Architecture and financial boundaries

The existing modular monolith is retained: Auth0 → Next.js authenticated/origin-checked API proxy → Node voice/application server → PostgreSQL. There are no new application services, queues or caches. Only server modules import the Stripe SDK. Hosted Checkout needs no client-side Stripe key or SDK.

- `server/billing/`: internal payments, package definitions, Checkout and verified webhook processing; `PaymentProvider` isolates the Stripe adapter.
- `server/wallet/`: provider-independent `credit`, `reserve`, `capture`, `release`, and usage-credit `refund`. These require a caller-owned transaction, enabling one atomic payment/call operation. No public endpoint exposes these primitives.
- `server/pricing/`: destination-specific, versioned rates and integer arithmetic.
- `server/calls/billing.ts`: call authorization, trusted connected-duration evidence, settlement and reconciliation.
- Migration `003_billing.sql`: wallets, immutable ledger, reservations, payments, permanent provider event IDs, pricing versions, call financial records, and transactional outbox.

`wallets` are projections; `wallet_ledger` is the immutable audit history. Monetary calculations use `bigint`, PostgreSQL `bigint`, and decimal strings at JSON boundaries. The ledger stores separate available/reserved deltas, with sign checks. An insert trigger updates the projection in the same transaction. Deferred constraints reconcile projections with ledger sums and remaining reservations before commit. Row locks serialize spending; nonnegative CHECK constraints add a final guard. There is exactly one wallet per user/currency. These financial records restrict deletion of their users/calls.

Each payment is unique by provider payment ID and provider Checkout Session ID. Requests are unique by user/idempotency key. Stripe event IDs are retained permanently; they do not use the telephony webhook table's one-day retention. A paid event locks the payment and commits its success, one PURCHASE ledger entry, wallet update, and domain events together. Duplicates are successful no-ops. Failures roll back even the event receipt so Stripe can retry. Different successful events for the same payment cannot credit twice. Delayed failures/expiration cannot downgrade a successful payment.

The adapter verifies signatures over the raw body, retrieves the Session with its PaymentIntent and line items, and validates the configured live/test mode, paid/succeeded state, JPY, exact received amount, quantity one, one-time Price ID, and internal user/payment/package correlation. It compares with the immutable internal payment and package definitions. No products are created or found by name. Each Checkout request has a stable internal idempotency key; retries after an uncertain response reuse it. An old request is rejected after 30 minutes rather than risking a second Session after Stripe's idempotency retention ends.

The outbox persists `wallet.credited/reserved/captured/released/refunded`, `payment.succeeded`, and `call.charged` in the state-changing transaction. There is currently no consumer; rows deliberately remain unprocessed for future workers. Do not mark them delivered or delete them as a substitute for an actual durable consumer. Safe correlation logs accompany checkout, payment and call settlement. Never log secrets, provider response bodies, payment details or transcripts.

## Pricing and call accounting

The initial active pricing row is `japan-domestic-v1`, destination `JP`, currency `JPY`, rate 125. Destination is a pricing dimension, so future landline/mobile/country versions do not change wallets. An unsupported pricing destination must fail closed. Currently the existing phone validation permits Japan only.

New calls snapshot the version ID, currency, and rate in `call_billing`; a composite FK ensures the snapshot matches its immutable version. Rates/identities cannot be rewritten, even before settlement. To change prices, create a **new version in a new migration**, deactivate the old version and activate the new one in one transaction. Only the active flag can change on an existing rate. Historical calls are never repriced. Imported pre-billing calls have no financial record and are not retroactively charged.

Authorization atomically creates the call, consent, request-id mapping and reservation. It reserves all currently available JPY, computes `floor(budget * 60 / rate)`, and applies the existing configured call-length cap (default 600 seconds, allowed 30–1200). Telnyx enforces that limit even if the application disconnects. Its minimum is 30 seconds, so starting a call at the current rate needs at least **¥63**. This is an authorization minimum, not a minimum usage charge. Top-ups during a call remain available for later use and do not extend its authorization.

A signed `call.answered` occurrence timestamp starts chargeable time; a signed `call.hangup` occurrence timestamp ends it. Delivery time, dialing time, browser timers, media start/stop, and mutable transcript snapshots are not financial evidence. Complete connected seconds are the integer timestamp difference divided by 1,000 (subsecond remainder is discarded in the customer's favor). The JPY charge is `(seconds * rate + 59) / 60` using integer division. Thus 1/60/120/348 seconds cost ¥3/¥125/¥250/¥725.

A call's capture, unused-fund release, charge, duration, and events commit atomically. Repeated completion is a no-op. A carrier overrun never draws extra wallet funds: the charge is capped at the reservation and the full rated amount plus waived overrun are recorded in `call.charged` for investigation. Provider costs are separate nullable `NUMERIC(20,8)` fields (`telnyx_cost`, `openai_cost`, `provider_cost_currency`); null means unknown, not zero. This feature does not invent provider COGS or calculate them from the customer rate.

## Delayed events and recovery

Application terminal status and financial settlement are independent. The UI shows a pending charge until confirmed. Existing restart recovery still terminates carrier legs; it never releases funds solely because a timer elapsed or a process restarted. Carrier IDs are retained in financial records even after media-control cleanup.

A hangup arriving before an answer keeps the reservation pending. The later answer settles it using the original timestamps. Explicit unanswered causes (`no_answer`, `timeout`, `user_busy`, `call_rejected`, `unallocated_number`, `invalid_number_format`, `no_route_to_destination`) release all funds with a zero charge. A signed Telnyx hangup with `sip_hangup_cause=487` also confirms pre-answer cancellation, even when `hangup_cause=normal_clearing`; if an answer is already recorded, its connected time is still charged. Normal clearing without this SIP evidence remains pending. See [Telnyx SIP responses](https://support.telnyx.com/en/articles/4304898-sip-trunking-methods-requests-responses). Missing/ambiguous events, a lost dial response, or failed hangup remain held for reconciliation. `review_after` marks a reservation for review; **it is not a credit expiry**.

Run the read-only report regularly with your current scheduler/operating procedure:

```sh
npm run billing:reconcile
```

It reports ledger/projection/reservation mismatches, overdue calls, old pending payments and retained outbox count. It returns nonzero when action is needed. Never repair history by editing/deleting ledger rows or resetting wallet balances. Usage refunds are new REFUND entries tied to the original CAPTURE, limited to its unrefunded amount. Cash refunds are issued by an authorized operator in Stripe after review. There is no voluntary refund policy; billing errors and mandatory legal rights are excepted. The application exposes no public refund/withdrawal endpoint. See refund/dispute reconciliation below.

Prefer replaying the original signed provider events. If events are unavailable, an authorized operator must obtain actual answer/end timestamps from carrier records, confirm the leg is inactive, and record a support/CDR reference (no transcript or payment-method data):

```sh
npm run billing:reconcile -- --call CALL_UUID \
  --connected 2026-09-22T01:00:00Z --ended 2026-09-22T01:05:48Z \
  --evidence carrier-record-reference-123
```

For a confirmed unanswered call use `--unconnected` instead of `--connected`. The command requires the app call to be terminal and verifies known carrier legs are inactive through Telnyx. If a dial response was lost and no leg ID was recorded, first confirm in the carrier account that **no leg exists**, wait past the call limit plus five minutes, and explicitly add `--verified-no-leg --unconnected` with the evidence reference. This is a privileged operator assertion, never an automatic expiry or browser operation. Reconciliation uses the same idempotent settlement transaction; completed charges cannot be rewritten. If a correction is needed, issue a documented compensating ledger operation.

## Stripe environment configuration

Set `STRIPE_MODE=live` in production and `test` only with a separate sandbox database. If omitted, NODE_ENV=production defaults to live; other environments default to test. The secret/restricted key, Price, Session, PaymentIntent, line-item Price, webhook event and immutable internal payment must agree on mode. Existing pre-migration payments remain test records. The service does not create products or prices. Configure these in the **voice server's** environment:

| Variable | Value |
| --- | --- |
| `STRIPE_MODE` | `live` or `test` |
| `STRIPE_SECRET_KEY` | Restricted key (`rk_live_…` / `rk_test_…`), or matching secret key |

| `STRIPE_WEBHOOK_SECRET` | Endpoint-specific `whsec_…` signing secret |
| `STRIPE_PRICE_CREDIT_1000` | Existing active one-time JPY ¥1,000 `price_…` ID |
| `STRIPE_PRICE_CREDIT_2000` | Existing active one-time JPY ¥2,000 `price_…` ID |
| `STRIPE_PRICE_CREDIT_5000` | Existing active one-time JPY ¥5,000 `price_…` ID |
| `APP_BASE_URL` | Exact web origin, e.g. `http://localhost:3000` locally; HTTPS when hosted |

In the matching Stripe live or sandbox Dashboard, open each existing product, open its one-time price, and copy the **Price ID**, not the product ID. Check currency JPY and amount. Do not add duplicate products. All three Price IDs must differ. The server checks the price before creating a Session. Missing/invalid required configuration produces a useful server-side configuration error naming the variable, and a safe localized availability message to the user. Publishable key is optional because redirect Checkout does not use it; neither secret key nor webhook secret is exposed to Next.js client components.

Apply the new migration through the existing tool to your development/staging database; review it and use your normal backup/deployment procedure for production:

```sh
npm run db:migrate
```

The application startup and tests do not apply migrations to the production database automatically. Restart the voice server after applying it. A running server without migration 003 cannot serve the new wallet endpoints.

The public signed Stripe endpoint is **`POST /webhooks/stripe` on the voice server**, normally port 3001, parallel to `/webhooks/telnyx`. Do not send Stripe webhooks to the authenticated Next.js `/api` proxy. In the deployed reverse proxy, expose this exact POST endpoint alongside the existing signed telephony/media paths, preserving the raw request body. All other application API paths still require the internal token and signed Auth0 identity.

## Exact local test procedure

1. Use only your Stripe **test/sandbox** account. Configure the five required Stripe values above, `APP_BASE_URL`, database/internal-token settings in voice and Auth0 in the web repository, and migrate your development database. No call credentials are needed just to test purchases.
2. Install/login to the [Stripe CLI](https://docs.stripe.com/stripe-cli), then run:

   ```sh
   stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired --forward-to http://127.0.0.1:3001/webhooks/stripe
   ```

   Copy the printed `whsec_…` value into `STRIPE_WEBHOOK_SECRET`. This CLI secret differs from a Dashboard webhook endpoint secret. Start/restart `npm run dev` after setting it.
3. Sign in using the existing app login. Open `http://localhost:3000/credits`. Note your current balance. Check ¥1,000/¥2,000/¥5,000, estimates 8/16/40, ¥125/min, and “Credits never expire.”
4. Select ¥1,000. Hosted Stripe Checkout must show a **one-time ¥1,000 JPY** payment. Use test card **4242 4242 4242 4242**, any future expiry, and any three-digit CVC. Enter only test details. Complete Checkout.
5. On return, the app reads the owner-scoped payment record and wallet. It may briefly show pending. Confirm the CLI received HTTP 200 and the wallet rose by exactly ¥1,000. Repeat for ¥2,000 and ¥5,000; total increase must be exactly ¥8,000. No subscriptions should appear.
6. To observe delayed confirmation, stop the CLI listener before completing another test payment. Return must remain pending with the old balance and eventually show the delayed message. Resume/replay the event using Stripe's delivery tooling for your test endpoint, then confirm one increment. Visiting the return URL alone never credits anything. For a registered test endpoint, `stripe events resend evt_TEST_ID --webhook-endpoint we_TEST_ID` can replay a delivery. Do not use generic `stripe trigger checkout.session.completed` as proof of a top-up: its fixture lacks your internal payment correlation and will correctly be rejected.
7. Replay the same valid event, then replay a different successful event for the same Session if available. Balance must remain unchanged after the first successful credit. The automated fixtures cover both cases and out-of-order success/failure.
8. Cancel Checkout and return: the UI shows cancellation and the balance remains unchanged. Use decline test card **4000 0000 0000 0002** to verify Stripe's failure UI. See [Stripe testing](https://docs.stripe.com/testing) for authentication-required cards. Never use real card details for test payments.
9. Check `GET /api/wallet` while signed in (or the displayed balance) and run `npm run billing:reconcile`. Expect no wallet mismatches. `payment.succeeded`, `wallet.credited`, and the corresponding outbox rows provide the audit trail. Pending outbox count is expected; there is deliberately no consumer yet.
10. For a separately authorized real telephone acceptance test, place a call with test-purchased credit to an allowed Japan number. Confirm the reservation before dialing, connected-only duration, final charge, unused-credit return, and retained pricing version. A 348-second connected duration is ¥725. An unanswered call is ¥0. Local automated tests mock providers and never dial a real number.

## Automated verification

```sh
npm run lint
npm run typecheck
npm test
npm run test:integration
```

The repository's isolated PGlite tests apply every real migration, use the actual domain SQL, inject rollback failures, and mock only providers. They cover all three packages, signature validation, wrong amounts/prices/users/currencies, duplicate/out-of-order events, reservations/capture/release/refund, immutable pricing, exact charges, no expiry, ledger reconciliation, and HTTP authorization. They do not read `.env` or contact live Stripe. The standalone voice repository uses the TypeScript compiler configured in `package.json`; Next.js builds run only in the web repository.

PGlite serializes its transactions, so **native PostgreSQL concurrency is tested separately**, using a dedicated local database named `tomoshimoshi_billing_test`. CI starts a disposable PostgreSQL 17 service. To run locally:

```sh
BILLING_TEST_DATABASE_URL=postgresql://postgres:TEST_PASSWORD@127.0.0.1:5432/tomoshimoshi_billing_test npm run test:billing:postgres
```

This creates/drops a random test schema only in that explicitly named loopback database. Twenty competing operations exercise wallet locks, distinct Stripe events for one payment, and simultaneous call completions. Never point it at an application database.

## Moving to live mode later

Live mode is supported after migration 004. Do not simply replace a key: select the explicit billing mode, use matching live keys, three existing/approved live one-time Prices, and the live endpoint's signing secret. The backend validates retrieved objects against that mode. Keep test and live databases separate so test-purchased credit cannot become spendable real-money credit. Review refund/dispute operations, billing support, taxes/receipts, database backup/restore, reconciliation ownership and alerting. Exercise real carrier duration/recovery acceptance before launch. Preserve old payment Price IDs for historical validation. No live resources or live payments were created by this change.

References: [Stripe webhook signatures/retries](https://docs.stripe.com/webhooks), [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment), [Telnyx carrier-enforced call limits](https://developers.telnyx.com/api-reference/call-commands/dial).

### Historical verification before repository separation (2026-09-22)

Before the repository split, the automated suite and web production build were run locally. Native PostgreSQL tests used a disposable loopback instance, not the application's database. Browser checks used the real Next.js → authenticated application API → migrated disposable PostgreSQL-compatible database flow, with a fake Stripe provider and test signing secret. Desktop and 390×844 Spanish layouts had no horizontal overflow or framework errors. A pending return kept ¥0 available; a synthetic signed paid webhook changed it to ¥1,000; replay returned HTTP 200 and left the balance at ¥1,000. The checkout-failure state was also verified. No real telephone call, live Stripe API request, hosted test-card payment, or production migration was performed. A real hosted Stripe test Checkout remains an operator acceptance step after configuring the endpoint signing secret.


## Live readiness and restricted-key permissions

The application key needs Checkout Sessions **write/read**, Prices **read**, PaymentIntents **read**, Charges **read** (refund event correlation fallback), Refunds **read**, and Disputes **read**. It does not need permission to create cash refunds. Keep keys only in the voice service secret environment; the web never needs a Stripe private or publishable key. Never put keys in logs or Git.

After applying migration 004, run `npm run check:billing` against the intended environment. This read-only preflight validates exact prices, read permissions, schema and wallets with credit from the other mode. It does not prove Checkout write permission, webhook secret matching or an actual card payment. Review any historical test-funded wallets before enabling live purchases; never delete or rewrite ledger history.

Production webhook: `https://voice-production-53b8.up.railway.app/webhooks/stripe`. Subscribe to:

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`.
- `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`.
- `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`.

Use the endpoint-specific signing secret. Update the live endpoint only when the new worker/configuration are ready. No redirects or authentication proxy may sit in front of this route. Hosted Checkout stays in JPY (adaptive pricing is disabled) so settlement and purchased credit use the same exact amount. No automatic tax is enabled: displayed package amounts remain the total charged. Confirm fiscal treatment separately before changing tax behavior.

## Refunds, disputes and missing webhooks

The user-approved policy is no voluntary refunds, with exceptions for billing errors and statutory rights. Operators review requests at contact@tomoshimoshi.com and issue approved refunds in Stripe to the original payment method. Do not issue a second refund for a disputed charge without reviewing its state in Stripe.

The worker retrieves current Stripe refunds/disputes under a per-payment lock. Pending/succeeded refunds and open/lost disputes remove the corresponding available credit through immutable ADJUSTMENT entries, capped at the original purchase. Failed/cancelled refunds and won/closed-warning disputes restore only previously removed credit. Duplicate and out-of-order events converge to current Stripe state. Reserved funds are never seized and balances never become negative. If credit was already spent or reserved, the outstanding shortfall blocks new calls and checkouts and shows a support message. This does not automatically charge the customer or forgive debt; support must resolve actual spent-credit cases individually. A reserved amount released after an unanswered call is reconciled in the next cycle.

Every minute the single worker reconciles up to 50 pending sessions and 20 succeeded purchases, including purchases with no refund/dispute webhook. Each batch rotates by last-check time. The owner-scoped payment return endpoint also recovers confirmed pending payments; it never trusts the redirect as payment evidence. Startup/shutdown preserves the existing single-worker lock. Run `npm run billing:reconcile -- --payments` for an explicit recovery pass plus the read-only report. The report includes reversal shortfalls; plain `billing:reconcile` remains read-only. Watch `payment.reconciliation_failed`, `payment.reversal_reconciliation_failed`, `payment.reconciliation_unavailable` and `payment.reversal_shortfall` logs and investigate Stripe deliveries promptly. An exhausted batch or failed permission check is not proof that all payments have been reconciled.

## Abuse limits · assessment 2026-09-23

Checkout creation is limited to 10 new request keys per user in 30 minutes, inside the user-lock transaction. Existing keys retain their retry/idempotency semantics at the limit. Rejection is `429 CHECKOUT_RATE_LIMIT`. The HTTP API also limits authenticated traffic and payment reconciliation reads; see [API](API.md). Quotas never grant funds or change the ledger.
