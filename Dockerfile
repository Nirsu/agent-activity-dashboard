FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY ui/package.json ui/package.json
# On a proxied Docker Desktop this install failed twice with npm network
# errors at the default concurrency (maxsockets=15) and succeeded with the
# flags below. The cause was NOT isolated to concurrency - treat this as a
# workaround, not a diagnosis. Builders that do not need it can restore
# normal behaviour with --build-arg NPM_INSTALL_FLAGS="".
ARG NPM_INSTALL_FLAGS="--maxsockets=3 --fetch-retries=5"
RUN npm ci --no-audit --no-fund $NPM_INSTALL_FLAGS

COPY server server
COPY fleet/repository-url.cjs fleet/repository-url.cjs
COPY fleet/brain-paths.cjs fleet/brain-paths.cjs
COPY ui ui
COPY docker/nginx.conf docker/render-nginx.mjs docker/
RUN npm run build
RUN node docker/render-nginx.mjs /app/docker/nginx.generated.conf
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS server

# Brain reads preserved checkouts or a persistent GitHub cache; credentials stay outside the image.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory /sources/repo

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4318 \
    DB_PATH=/app/server/data/history.db \
    RETENTION_DAYS=60

WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/prompts server/prompts
COPY --from=build /app/fleet/repository-url.cjs fleet/repository-url.cjs
COPY --from=build /app/fleet/brain-paths.cjs fleet/brain-paths.cjs

RUN mkdir -p /app/server/data && chown -R node:node /app/server/data
USER node

EXPOSE 4318
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4318/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server/dist/index.js"]

FROM nginx:1.29-alpine AS dashboard

COPY --from=build /app/docker/nginx.generated.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/ui/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
