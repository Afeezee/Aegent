# -----------------------------------------------------------------------------
# Aegent — one image serves both the SPA and the ciphertext relay.
#
# Build stage: install all deps, compile server, build web bundle.
# Runtime stage: prune devDeps, ship node_modules + built dist folders.
#
# Working directory at runtime is /app/server so the DB (data/aegent.db) and
# the SPA lookup (../../web/dist) both resolve correctly.
# -----------------------------------------------------------------------------

FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so `npm ci` is cached when only source changes.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

# Full source, then build + prune to a production-only tree.
# NODE_OPTIONS sets Vite's heap ceiling. This project's bundle step
# (transformers.js + pdfjs + xlsx + Office parsers) needs well over
# 1 GB to render chunks, so the old 460 MB cap — set back when we
# built on a 512 MB container — now STARVES the build and it dies
# with "JavaScript heap out of memory". 2 GB is comfortable on a
# host with a few GB of RAM (add swap if the host is tight).
ENV NODE_OPTIONS="--max-old-space-size=2048"
COPY . .
RUN npm run build \
 && npm prune --omit=dev --workspaces --include-workspace-root

# -----------------------------------------------------------------------------
FROM node:22-alpine

# Node 22.5+ ships node:sqlite built-in; no native compilation needed.
WORKDIR /app

# Bring the pruned tree over as-is: package manifests, hoisted node_modules,
# server/dist, web/dist. Everything the runtime needs, and no more.
COPY --from=build /app ./

# Non-root for defence in depth.
RUN addgroup -S aegent && adduser -S aegent -G aegent \
 && mkdir -p /app/server/data \
 && chown -R aegent:aegent /app
USER aegent

ENV NODE_ENV=production
ENV PORT=8787
WORKDIR /app/server
EXPOSE 8787

# NOTE: the persistent volume MUST be mounted at /app/server/data by the
# platform (Railway Volume, docker -v, k8s PVC — whatever). SQLite lives
# there. Losing that directory means losing every message.
# (No `VOLUME` directive here — Railway rejects it and manages mounts itself.)

CMD ["node", "dist/index.js"]
