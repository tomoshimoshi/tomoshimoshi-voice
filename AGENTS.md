# Voice service

This repository owns the Node voice worker, provider callbacks, database migrations,
billing and backend tests. The Next.js frontend lives in tomoshimoshi/tomoshimoshi.

Use Node 24. Run npm run check before publishing code. Tests use isolated databases
and disabled providers; never load production .env into tests or place a real call.
Never edit applied SQL migrations. Preserve the single-worker PostgreSQL lock.
Production deployment requires a maintenance window with no active calls and
stopping the previous worker before starting its replacement; see docs/RAILWAY.md.
Keep the signed identity format and shared lib models compatible with the web.
Do not commit secrets, local .env, node_modules or private runtime data.
