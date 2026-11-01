# One image for everything that runs the repo's code in Docker (ADR 0021): the pipeline's API,
# worker, Studio and web app, and dugout's worker and Figma watcher. Each compose service picks its
# own command. Build from the repo root:
#   docker build -f docker/Dockerfile -t dugout-stack:dev .
#
# Not the ECS worker image (apps/worker/Dockerfile): that one is Alpine and has no browser, so it
# cannot run the card agents' renderer. This one carries Chromium for Playwright.
FROM node:22-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CI=1
RUN corepack enable && corepack prepare pnpm@10.7.1 --activate

# The browser first, and at the version pnpm-workspace.yaml pins: it picks the Chromium that renders
# every pixel the agents measure against, and this layer is rebuilt only when that changes.
ARG PLAYWRIGHT_VERSION=1.62.1
RUN npx --yes playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN chown node:node /app
USER node

# dependencies first, so a code change doesn't download them again
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch
COPY --chown=node:node . .
RUN pnpm install --offline --frozen-lockfile && pnpm pipeline:build
