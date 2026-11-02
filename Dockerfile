# syntax=docker/dockerfile:1
# Multi-stage build for the monorepo. Targets: migrate (one-shot DB setup), api, web.
#   docker build --target api -t prospecting-api .
FROM node:24-alpine AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false

FROM base AS manifests
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/

FROM manifests AS deps
RUN npm ci

FROM manifests AS prod-deps
RUN npm ci --omit=dev

FROM deps AS build
COPY . .
RUN npm run db:generate && npm run build

# One-shot: apply migrations as the owner role, then provision the least-privilege login role the API uses.
FROM build AS migrate
ENV NODE_ENV=production
WORKDIR /app/apps/api
USER node
CMD ["sh", "-c", "node ../../node_modules/prisma/build/index.js migrate deploy && node ../../scripts/db-provision-login-role.mjs"]

FROM prod-deps AS api
ENV NODE_ENV=production API_PORT=3001 API_HOST=0.0.0.0 LOG_FORMAT=json REQUIRE_UNPRIVILEGED_DB_ROLE=1
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/apps/api/dist apps/api/dist
WORKDIR /app/apps/api
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]

FROM prod-deps AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/apps/web/.next apps/web/.next
COPY apps/web/next.config.mjs apps/web/
WORKDIR /app/apps/web
USER node
EXPOSE 3000
CMD ["node", "../../node_modules/next/dist/bin/next", "start"]
