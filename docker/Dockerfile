# ── Stage 1: Install production dependencies ──────────────────────────────────
# Node version pinned to match .nvmrc and package.json#volta.node.
FROM node:24.15.0-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Console has its own dependency tree (React, Vite, Tailwind)
COPY console/package.json console/package-lock.json ./console/
RUN cd console && npm ci

# ── Stage 2: Build console frontend ───────────────────────────────────────────
FROM deps AS console-build

WORKDIR /app/console
COPY console/ .
# 'npm run build' runs 'tsc -b && vite build' — matches the CI Console
# build step and the verify:release gate, so the stricter
# tsconfig.app.json flags (noUnusedLocals/Parameters, verbatimModuleSyntax,
# erasableSyntaxOnly, noUncheckedSideEffectImports) are enforced in the
# image build instead of being silently dropped by a bare vite invocation.
RUN npm run build
# Output lands at /app/dist (vite.config.ts: outDir: '../dist')

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
# Node version pinned to match .nvmrc and package.json#volta.node.
FROM node:24.15.0-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      tini \
    && rm -rf /var/lib/apt/lists/*

# The node:24-slim image already has UID/GID 1000 (user 'node').
# Reuse it for volume permission compatibility with host UID 1000.
RUN usermod -l whatsoup -d /home/whatsoup -m node && \
    groupmod -n whatsoup node

WORKDIR /app

# Production node_modules from stage 1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json

# Source code — no build step, TypeScript runs via --experimental-strip-types
COPY src/ ./src/
COPY tsconfig.json ./

# Built console from stage 2
COPY --from=console-build /app/dist ./dist/

# Entrypoint
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# XDG directories owned by runtime user
RUN mkdir -p /home/whatsoup/.config/whatsoup/instances \
             /home/whatsoup/.local/share/whatsoup/instances \
             /home/whatsoup/.local/state/whatsoup/instances \
  && chown -R whatsoup:whatsoup /home/whatsoup /app

USER whatsoup

ENV NODE_OPTIONS="--experimental-strip-types --disable-warning=ExperimentalWarning"
ENV WHATSOUP_DOCKER=1

# Fleet console port (default)
EXPOSE 9099

ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
