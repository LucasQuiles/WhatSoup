# ── Stage 0: Immutable Node and Debian package inputs ──────────────────────────
# Node version pinned to match .nvmrc and package.json#volta.node. The digest and
# snapshot policy are verified by scripts/check-node-pin-consistency.ts.
FROM node:24.15.0-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS base

# The pinned Node binary supplies bundled roots before APT installs certificates.
# HTTPS authenticates the snapshot server; APT still verifies signed metadata.
RUN node -e "require('fs').mkdirSync('/etc/ssl/certs', {recursive:true}); require('fs').writeFileSync('/etc/ssl/certs/ca-certificates.crt', require('tls').rootCertificates.join('\n') + '\n')"
RUN printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261001T000000Z/ bookworm main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261001T000000Z/ bookworm-security main' \
      > /etc/apt/sources.list \
    && rm -rf /etc/apt/sources.list.d/*

# ── Stage 1: Install production dependencies ──────────────────────────────────
FROM base AS deps

RUN apt-get -o APT::Update::Error-Mode=any update \
    && apt-get install -y --no-install-recommends \
      ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY patches/ ./patches/
RUN npm ci --omit=dev

# Console has its own dependency tree (React, Vite, Tailwind)
COPY console/package.json console/package-lock.json ./console/
RUN cd console && npm ci

# ── Stage 2: Build console frontend ───────────────────────────────────────────
FROM deps AS console-build

# Console imports canonical shared modules from the application source.
COPY src/ /app/src/
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
FROM base AS runtime

RUN apt-get -o APT::Update::Error-Mode=any update \
    && apt-get install -y --no-install-recommends \
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
