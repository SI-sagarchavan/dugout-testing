# The worker image (ADR 0009): what the ECS service runs. Build from the repo root:
#   docker build -f apps/worker/Dockerfile -t dugout-worker .
# It runs TypeScript with tsx, like every entry point here (no build step). Config comes from the
# environment: DATABASE_URL, VALKEY_URL, VALKEY_KEY_PREFIX, LLM_API_KEY (and the model settings in
# .env.example), plus AGENTS, WORKER_CONCURRENCY, WORKER_POLL_MS and WORKER_GRACE_MS. It has no port.
FROM node:22-alpine

RUN corepack enable
WORKDIR /app
RUN chown node:node /app
USER node

# dependencies first, so a code change doesn't download them again
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch
COPY --chown=node:node . .
RUN pnpm install --offline --frozen-lockfile

# One process, so ECS's SIGTERM reaches the worker itself; it hands its runs over and exits
CMD ["node", "--import", "tsx", "apps/worker/scripts/work.ts"]
