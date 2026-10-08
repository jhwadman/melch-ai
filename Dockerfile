# syntax=docker/dockerfile:1
# ── Melchizedek A2A server ───────────────────────────────────────────────────
# Builds the compiled server from this repository and runs it as a non-root
# user. Configuration is environment only (see .env.example); syndicates are
# read from /app/config/agents, so mount or COPY your own over it.
#
#   docker build -t melchizedek .
#   docker run --rm -p 4000:4000 --env-file .env \
#     -e HOST=0.0.0.0 melchizedek tutor.yaml
#
# A server bound to 0.0.0.0 needs A2A_SERVER_SECRET (or, knowingly,
# ALLOW_UNAUTHENTICATED=true) — the server refuses otherwise.

# Base image pinned by digest (Dependabot's docker ecosystem proposes updates).
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY config ./config
COPY db ./db
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# SIGTERM fails /readyz, keeps serving for A2A_SHUTDOWN_DELAY_MS (5 s), then
# drains running tasks; the whole stop fits A2A_SHUTDOWN_GRACE_MS (25 s): give
# the orchestrator's stop timeout at least that long.
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "dist/scripts/a2a_server.js"]
CMD ["syndicate.yaml"]
