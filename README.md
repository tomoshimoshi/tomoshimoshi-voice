# ToMoshiMoshi Voice

Standalone Node.js service for calls, Telnyx webhooks/media, OpenAI Realtime,
PostgreSQL persistence and prepaid billing. The Next.js interface and Auth0 live in
[tomoshimoshi](https://github.com/tomoshimoshi/tomoshimoshi).

## Production

- Railway service: `voice`, branch `main` of this repository.
- Voice origin: https://voice-production-53b8.up.railway.app
- Web origin: https://www.tomoshimoshi.com
- Telnyx v2 webhook: `/webhooks/telnyx`; Stripe webhook: `/webhooks/stripe`.

The API requires the shared bearer token and a short-lived signed identity from
the web server. Provider webhooks and media have separate signature/token checks.
No frontend, Auth0 client secret or Next.js runtime is required here.

## Local setup

Use Node 24 (`nvm use`) and a separate development PostgreSQL database.

```sh
npm ci
cp .env.example .env  # first setup only
# Fill the voice variables and the SAME CALLORI_INTERNAL_TOKEN as the web.
npm run db:migrate
npm run dev
```

Run `npm run dev` separately in the web repository, with
`VOICE_SERVER_URL=http://127.0.0.1:3001` and `APP_BASE_URL=http://localhost:3000`.
The voice `.env` uses the same `APP_BASE_URL`. Keep `LIVE_CALLS_ENABLED=false`
until an explicitly controlled phone test. A local callback tunnel is needed only
for local telephone tests, not for production.

An existing production worker owns an exclusive PostgreSQL lock. Never start a
local worker against the production database while Railway is running. Do not
re-run migrations or import SQLite just because the repository moved.

## Commands

- `npm start`: run voice only; Railway runs the same Node entrypoint via Docker.
- `npm run check`: lint, typecheck and isolated tests (no provider calls).
- `npm run test:integration`: isolated HTTP lifecycle/security checks.
- `npm run test:billing:postgres`: dedicated disposable native PostgreSQL test;
  requires `BILLING_TEST_DATABASE_URL` (configured in CI).
- `npm run db:migrate`: apply migrations in `db/migrations`.
- `npm run db:import-sqlite`: explicit one-time legacy import only.
- `npm run backup -- /private/path/tomoshimoshi.dump`: PostgreSQL backup.
- `npm run billing:reconcile -- --help`: billing reconciliation options.

## Deployment and ownership

See [Railway](docs/RAILWAY.md) for variables, Docker setup and the required
stop-before-redeploy procedure. Keep one replica and automatic deployments off.
The existing Railway service, domain, variables and database are reused.

`lib/` contains the small shared protocol/model helpers copied from the web at
extraction. Changes to `types.ts`, validation, phone/call planning, profile or the
signed identity format must be coordinated with the web repository. They are
local source files, not filesystem links or runtime imports from another repo.
The web's public credit catalogue mirrors `server/billing/packages.ts`.

The service was extracted from web revision `5d4ff2a`. Server code and SQL
migrations are unchanged by the split. Stripe remains test-mode-only; repository
separation does not configure the outstanding Stripe credentials or prove audio.
