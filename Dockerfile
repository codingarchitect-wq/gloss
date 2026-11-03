# syntax=docker/dockerfile:1
# Gloss in one container: a production build, served by Next's standalone server.
# Run it with docker-compose.yml, which adds the Postgres it keeps your library in.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
# Fixed into the build (lib/auth-mode.ts): one local reader and no sign-in, unless Clerk keys are given.
ARG NEXT_PUBLIC_GLOSS_LOCAL_USER=1
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3100
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
ENV NEXT_PUBLIC_GLOSS_LOCAL_USER=$NEXT_PUBLIC_GLOSS_LOCAL_USER \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0
# monolith saves whole copies of original pages (lib/originals.ts); they live in /data/originals.
RUN apk add --no-cache monolith && addgroup -S gloss && adduser -S gloss -G gloss && mkdir -p /data/originals && chown gloss:gloss /data/originals
COPY --from=build --chown=gloss:gloss /app/.next/standalone ./
COPY --from=build --chown=gloss:gloss /app/.next/static ./.next/static
COPY --from=build --chown=gloss:gloss /app/public ./public
COPY --from=build /app/db ./db
COPY --from=build /app/scripts/migrate.mjs ./scripts/migrate.mjs
USER gloss
EXPOSE 3100
# The schema is safe to apply on every start, so a fresh database just works.
CMD ["sh", "-c", "node scripts/migrate.mjs && exec node server.js"]
