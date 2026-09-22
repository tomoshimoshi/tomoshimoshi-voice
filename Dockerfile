FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV VOICE_HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json ./
COPY server ./server
COPY lib ./lib
COPY db/migrations ./db/migrations
COPY scripts/migrate.ts scripts/reconcile-billing.ts ./scripts/

USER node
# Direct Node entrypoint delivers SIGTERM to the worker for graceful shutdown.
CMD ["node", "--import", "tsx", "server/index.ts"]
