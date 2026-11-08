# syntax=docker/dockerfile:1
# ── stage 1: build ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
# manifests first: the npm ci layer is cached until dependencies change
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared shared
COPY client client
COPY server server
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
RUN npm run build -w client \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf client/src client/public client/tools client/test shared/test server/test server/scripts

# ── stage 2: runtime ───────────────────────────────────────────────────────────
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/client/dist \
    LOG_DIR=/tmp/skyduel-logs
WORKDIR /app
# only production node_modules, the shared sources (run as TypeScript by Node), the server and the built client
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/client/dist ./client/dist
COPY --from=build --chown=node:node /app/client/package.json ./client/package.json
ARG GIT_SHA=dev
ARG GIT_TAG=
ENV GIT_SHA=$GIT_SHA GIT_TAG=$GIT_TAG
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# exec form, node directly: SIGTERM from `docker stop` reaches Node itself.
# (`npm start` would be PID 1 and would not forward the signal — the 10 s kill would follow.)
CMD ["node", "server/src/index.ts"]
