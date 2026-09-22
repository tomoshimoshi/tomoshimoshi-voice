> Historical setup reference. Use the [current voice README](../README.md) and [Railway runbook](RAILWAY.md) for the separated repositories. Web/Auth0 commands run in `tomoshimoshi`; voice/database commands run here.

# Run ToMoshiMoshi locally

> Historical SQLite baseline (September 2026). Database, account isolation, signup, API origins and backup instructions below are superseded by [PostgreSQL + Auth0](POSTGRESQL.md). Do not follow the old SQLite runtime/restore instructions for the current release.


ToMoshiMoshi is a single-user local application. No accounts or billing are required. You can prepare a request without provider credentials; practice mode has been removed. Real calling uses your own OpenAI and Telnyx accounts.

## 1. Start the application

Use Node.js 24 LTS (minimum 24.0) and npm:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3000**. This starts Next.js on port 3000 and the voice service on port 3001, both bound to loopback. Keep the terminal running during a call.

For a local production run:

```sh
npm run build
npm start
```

The app stores its SQLite database and an automatically generated internal service token under `.callori/`, which is ignored by Git. Node may print an experimental SQLite warning; it does not prevent the application from running. No audio recordings are created.

## 2. Prepare a call with the guided flow

1. Open **Settings**, enter all given names and surnames, and optionally an informal preferred name. Choose English or Spanish and save.
2. Choose **Book an appointment**, **Reserve a table**, **Ask for information**, or **Follow up** on the overview.
3. For an appointment, choose the service (for example Dentist), the reason, and optionally whether you have visited before.
4. Enter the business's telephone number and the language ToMoshiMoshi should speak. Choose whether to share your profile; the exact full name is shown for review.
5. For appointments and restaurant bookings, optionally add up to three dates and time windows. All dates and times use the destination’s local time automatically (currently Japan). By default ToMoshiMoshi asks before confirming; you can explicitly permit booking one of your options. Fees still require approval.
6. Review the request, recipient, spoken language, shared name, dates and permissions. Only the final authorized action places a real call.
7. Follow the transcript, respond when ToMoshiMoshi asks you, then review the saved result.

New calls are live only. Practice mode and scripted call generation have been removed. Existing practice records remain in local history with their original labels, so past simulated outcomes are not misrepresented as real calls. Provider setup is required to place a call, but you can explore the wizard and review without dialing.

## 3. Configure real phone calls

```sh
cp .env.example .env # First setup only; preserve an existing .env
```

Edit `.env` locally. Never paste credentials into a browser form, commit them, or use `NEXT_PUBLIC_` variables for secrets.

| Variable                | Value                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`        | OpenAI API key with access to the chosen Realtime and text models                           |
| `OPENAI_REALTIME_MODEL` | Defaults to `gpt-realtime`; configurable for your account                                   |
| `OPENAI_TEXT_MODEL`     | Defaults to `gpt-4.1-mini` for transcript translation                                       |
| `TELNYX_API_KEY`        | Telnyx API key                                                                              |
| `TELNYX_CONNECTION_ID`  | ID of a Telnyx **Voice API / Call Control application** configured for outbound calls       |
| `TELNYX_FROM_NUMBER`    | Your Telnyx-enabled outbound number in E.164 form                                           |
| `TELNYX_PUBLIC_KEY`     | Your account's base64 Ed25519 public key for webhook verification                           |
| `PUBLIC_BASE_URL`       | Public HTTPS tunnel origin pointing to port **3001**, without a path                        |
| `ALLOWED_PHONE_NUMBERS` | Comma-separated E.164 destinations, or `*` for all supported destinations (currently Japan) |
| `LIVE_CALLS_ENABLED`    | Set to `true` only after configuration                                                      |
| `MAX_CALL_SECONDS`      | Default 600; clamped to 30–1200 seconds                                                     |

Configure the Telnyx application with the necessary outbound voice profile and permitted destination countries. A funded account and verified/assigned outbound caller number may be needed according to your account's requirements. The application sends the webhook URL with each dial request; configuring the same URL in the Telnyx portal is useful as a fallback.

Telnyx needs an HTTPS/WebSocket tunnel to the voice service. For example, if ngrok is installed:

```sh
ngrok http http://127.0.0.1:3001
```

Set `PUBLIC_BASE_URL` to the resulting HTTPS origin, then restart `npm run dev`. Configure the callback as:

```text
https://YOUR-TUNNEL/webhooks/telnyx
```

Do **not** tunnel the unauthenticated web UI on port 3000. The voice service exposes signed Telnyx webhooks and one-use, per-call token-protected media connections. Its other endpoints require the internal server token.

Open Settings to see each configuration check. “Configured” means the value is present, not that provider account access or an actual call has been verified. Select **Real call**, enter an allowed number, choose the call language (Japanese, English, or Spanish), review the objective/context/constraints, explicitly authorize the call, and press **Place phone call**.

Start with a number you control. Verify audio in both directions, translations, refusal/approval handling, a missing-information question, resuming after a response, recipient hangup, and manual hangup before a stakeholder demonstration of real calling. Real phone calls incur provider charges.

## 4. Privacy and safety behavior

- The web app is local-only and has no user authentication. Both services listen on `127.0.0.1`; public Host headers and cross-origin write requests are rejected.
- OpenAI/Telnyx keys never reach client JavaScript. A random local token authenticates Next.js to the voice service. Calls cannot be placed just by discovering the tunnel URL.
- Real calls require both an enable flag and a destination policy (an explicit list or `*` for all destinations). Only one call can run at once, with a 30-second real-call initiation throttle.
- Webhooks use the raw request body, Ed25519 signature verification, a five-minute replay window, and persistent event deduplication. Webhook bodies are not logged.
- Dial requests are deduplicated using an ID recorded **before** calling Telnyx. Media URLs use unpredictable per-call tokens and permit only one active media socket.
- ToMoshiMoshi is instructed to introduce itself as an AI assistant and respect a refusal. It must ask the user about unknown facts and decisions outside the user's instructions. It receives no payment or transfer tools.
- A pending human question keeps the same phone and AI connections open. No response in 90 seconds ends the call. Telnyx also enforces a provider-side duration cap independently of this application.
- The profile is optional per call. When sharing is enabled, relevant profile details go to OpenAI and can be spoken over the phone. Profile details are not passed to the voice model when sharing is off.
- Live call audio is sent to Telnyx and OpenAI; transcript text is also sent to OpenAI for translation. Provider data handling policies apply. Responses translation requests use `store: false`.
- Original transcript text remains accessible. If translation fails, the original is shown with an explicit notice instead of inventing a translation. Interrupted AI speech is marked as potentially unheard.
- Local profile/transcript storage uses a private directory and restricted file permissions, but is **not application-level encrypted**. Use your operating system's disk encryption. Exported transcripts are plain text.

## Troubleshooting

| Symptom                            | Action                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice service unavailable          | Run `npm run dev` from the repository, not `next dev` alone. Check whether another app occupies port 3001.                                                      |
| Real-call button disabled          | Review every Settings connection check and check the authorization box. Restart after editing `.env`.                                                           |
| Number not allowed                 | Add the exact E.164 destination to `ALLOWED_PHONE_NUMBERS`, or use `*` for enabled countries, and restart. Japan is the only enabled country.                   |
| Call fails to dial                 | Check Telnyx API key, Voice API application, outbound voice profile, balance, caller number, and destination permissions.                                       |
| No incoming audio or no connection | Confirm the tunnel points to 3001 and accepts WebSocket upgrades; ensure `PUBLIC_BASE_URL` uses HTTPS.                                                          |
| Webhook rejected                   | Verify `TELNYX_PUBLIC_KEY`, the machine's clock, and that a proxy does not alter the raw body.                                                                  |
| Provider error                     | Check OpenAI Realtime model access, API balance, and the configured model names.                                                                                |
| Translation unavailable            | The original transcript remains visible; check access to `OPENAI_TEXT_MODEL`.                                                                                   |
| Service restarted mid-call         | The app records an interrupted result and attempts to hang up a persisted provider call. It does not silently redial. The provider time cap remains a fallback. |
| Hangup taking longer               | ToMoshiMoshi retries the hangup command automatically; Telnyx's independent duration cap remains active.                                                             |

## Tests

```sh
npm test
npm run typecheck
npm run build
```

Tests use temporary databases and simulated provider transports. They do not dial telephone numbers, use real API keys, or alter your local profile/history. See [ARCHITECTURE.md](https://github.com/tomoshimoshi/tomoshimoshi/blob/codex/railway-voice/docs/ARCHITECTURE.md) for the implementation and deployment path, and [VERIFICATION.md](https://github.com/tomoshimoshi/tomoshimoshi/blob/codex/railway-voice/docs/VERIFICATION.md) for what has and has not been verified.

## Production foundation

For the release procedure, process health, backup/restore, hangup recovery and logs, see [OPERATIONS](OPERATIONS.md). Known limitations and acceptance work are tracked in [FINDINGS](https://github.com/tomoshimoshi/tomoshimoshi/blob/codex/railway-voice/docs/FINDINGS.md) and [TODO](https://github.com/tomoshimoshi/tomoshimoshi/blob/codex/railway-voice/docs/TODO.md). This remains a private single-user deployment; authentication, billing and multi-user support are intentionally deferred.
