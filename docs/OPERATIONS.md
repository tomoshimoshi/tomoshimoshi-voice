> Historical setup reference. Use the [current voice README](../README.md) and [Railway runbook](RAILWAY.md) for the separated repositories. Web/Auth0 commands run in `tomoshimoshi`; voice/database commands run here.

# Operations

> Historical SQLite baseline (September 2026). Database, account isolation, signup, API origins and backup instructions below are superseded by [PostgreSQL + Auth0](POSTGRESQL.md). Do not follow the old SQLite runtime/restore instructions for the current release.


## Supported deployment boundary

Run one voice process and one Next.js process on a persistent host with Node 24+. Keep port 3000 private: the application has no user authentication and its API intentionally accepts local Host/origin values only. A public HTTPS tunnel or reverse proxy may forward to port 3001 for signed callbacks and tokenized WebSockets. Protect the host, `.env` and the data directory at the operating-system level. No public deployment is included in this handoff.

`npm ci` installs the complete build/check toolchain. `npm run build` creates the web production bundle. `npm start` starts both processes; runtime tools `tsx` and `concurrently` are runtime dependencies. A prebuilt installation can omit development dependencies when it only needs to run. A supervisor can use `npm run start:voice` and `npm run start:web` separately, with the same working directory and configuration. Use a stop grace period of at least 25 seconds. Never launch multiple voice workers against this database.

The voice process binds its port before recovering persisted calls. A duplicate launch fails before modifying active-call state. `/healthz` returns 503 while startup recovery or shutdown is in progress and 200 after initialization. The settings page reports configuration presence and pending old-call cleanup, not guaranteed provider connectivity.

## Configuration

See `.env.example` and [SETUP](SETUP.md). Restart both processes after changing configuration. Optional operational settings:

- Storage and configuration identifiers retain their legacy names for compatibility after the ToMoshiMoshi rename; existing data, service tokens, language preferences and saved drafts remain usable.
- `CALLORI_DATA_DIR`: persistent private directory; default `.callori`. Both processes must resolve it to the same location.
- `CALLORI_INTERNAL_TOKEN`: optional shared internal secret, at least 32 non-whitespace characters. If omitted, a random token is generated in the data directory. Empty/malformed stored tokens fail closed.
- `VOICE_PORT`: voice listener port, default 3001. Also update `VOICE_SERVER_URL` and the tunnel target when changing it.
- `VOICE_SERVER_URL`: internal voice origin, default `http://127.0.0.1:3001`.
- `MAX_CALL_SECONDS`: clamped to 30–1200; default 600, also sent to Telnyx as a carrier-side cap.
- `OPENAI_REALTIME_MODEL`, `OPENAI_TEXT_MODEL`: model overrides. Validate changes with controlled calls; names/configuration are not proof of account access.

## Calling countries

`lib/phone.ts` contains the controlled country list, initially Japan only. The UI parses local or international input with `libphonenumber-js/max`, formats on blur and previews the international destination. The API accepts only canonical E.164 numbers validated against that same list; an environment wildcard never bypasses the country restriction. Adding a country requires an explicit list entry, localized label/example, normalization and rejection tests, and verified Telnyx destination permissions. Number validation checks numbering-plan plausibility, not ownership or reachability.

References: [library documentation](https://github.com/catamphetamine/libphonenumber-js), [JNTO local/international number example](https://www.japan.travel/en/plan/hotline/).

## Release procedure

1. Stop creating new calls and wait for the active call to end. Confirm no call is pending in the UI.
2. Create an integrity-checked backup outside the deployment directory.
3. Run `npm ci`, `npm run check`, `npm run test:integration`, and `npm audit --omit=dev --audit-level=high`.
4. Stop the old processes gracefully, then start the new build. Never replace the web bundle underneath a running instance during a call.
5. Check `curl -f http://127.0.0.1:3001/healthz`, open the UI, inspect Settings and confirm the tunnel is still pointing to the correct port.
6. Run the controlled real-call acceptance cases in [VERIFICATION](https://github.com/tomoshimoshi/tomoshimoshi/blob/codex/railway-voice/docs/VERIFICATION.md) before considering changed voice behavior accepted.

GitHub Actions implements the automated checks with Node 24 and pinned official action revisions. The workflow is provided but was not executed on GitHub during this local handoff. There is no automatic deployment.

## Backup and restore

```sh
npm run backup -- /private/backup-location/tomoshimoshi-2026-09-15.sqlite
```

The backup uses SQLite's online backup API, includes committed WAL data, validates `PRAGMA integrity_check`, creates mode 0600 files and refuses overwrite. It backs up profile, calls, transcripts and operational recovery records. It does not back up `.env` or the internal token; keep credentials in a separate protected store. Backup destinations should be on encrypted storage with an explicit retention policy. The application does not schedule backups automatically.

To restore:

1. End all calls and stop both processes. Verify the chosen backup is outside the data directory you are about to move.
2. Preserve the whole current data directory under a different name; do not copy only a live `.sqlite` file and discard its WAL.
3. Create a new private data directory, copy the verified backup into it as `callori.sqlite`, and set the file to 0600 and directory to 0700.
4. Retain your existing `.env`. If the internal token is generated locally, allow a new one to be generated for both processes; if configured explicitly, keep the same value in both.
5. Start ToMoshiMoshi and inspect Settings/history. Restored unfinished calls are marked interrupted; they are never redialed or represented as resumed sessions. Persisted carrier calls are reconciled by attempting to end them.

For rollback, stop both services, restore the prior code/build and a compatible database snapshot. The current schema adds `provider_calls.hangup_id` automatically and non-destructively. Do not assume an older build understands new schema changes; test rollback against a copy before a release.

## Failure handling

- **Cancel during dialing:** cancellation waits for the pending carrier response, then hangs up the returned call ID. Media authorization is blocked once stopping begins.
- **Hangup fails:** local audio sockets stop immediately; the carrier hangup is retried using a persisted command ID. A failed command is followed by a carrier-status check; only explicit `is_alive: false` confirms an already-ended call. Unknown states remain pending.
- **Process crash/restart:** active local calls become failed. Persisted hangups are retried at startup and every 30 seconds; new calls are blocked while a previous terminal record still needs carrier cleanup.
- **Late carrier callback:** a known local call ID can recover the carrier control ID even after the local call was marked failed, allowing cleanup. No callback can create a new outbound call.
- **Shutdown deadline:** ToMoshiMoshi attempts cleanup and exits within 20 seconds. Recovery records remain on disk if cleanup does not complete. The Telnyx time cap is the final fallback, not an assertion that immediate hangup succeeded.
- **Missing app answer:** the same call waits up to 90 seconds, then ends. It never treats silence as approval.
- **Audio backpressure/provider failure:** bounded buffers stop the call instead of accumulating unlimited delayed speech.

Do not delete pending carrier records just to unblock the UI. Check the Telnyx portal for active calls, restore connectivity/credentials, and let recovery reconcile the state. If callbacks and the dial response are both lost before the carrier control ID is known, local cleanup cannot address that call; use the Telnyx portal and carrier-side time limit.

## Data and logs

The SQLite database and profile persist indefinitely until managed by the operator. User-facing retention/deletion and history pagination are TODOs. There is no application-level encryption at rest and no audio recording by ToMoshiMoshi. Verify provider-side recording/retention separately.

Console warnings identify translation failures and pending carrier cleanup using an internal call UUID. Credentials, audio payloads, media URLs/tokens and transcript text are not logged by application diagnostics. Store process logs privately; inspect the call error/status in the UI for user-facing detail. Metrics, alerts and distributed tracing are not implemented.

## Prepaid billing

See [Billing architecture, Stripe test setup, manual tests and reconciliation](BILLING.md). Apply migration `003_billing.sql` before running this version. Credits never expire; the current Japan rate is ¥125/minute.
