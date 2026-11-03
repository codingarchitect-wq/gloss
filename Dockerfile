# syntax=docker/dockerfile:1
# Gloss in one container: a production build, served by Next's standalone server.
# Run it with docker-compose.yml, which adds the Postgres it keeps your library in.
# Debian rather than Alpine: monolith's own Linux builds are made for glibc.

ARG TARGETARCH

# monolith saves whole copies of original pages (lib/originals.ts): its release build for this
# machine, checked against the checksum GitHub publishes for it. To upgrade, change both.
FROM scratch AS monolith-arm64
ADD --checksum=sha256:1933940d489c730e8a665dd81681bc6f3f4f3c6265dc3b3066765503626d0389 \
    https://github.com/Y2Z/monolith/releases/download/v2.12.0/monolith-cli-linux-aarch64 /monolith
FROM scratch AS monolith-amd64
ADD --checksum=sha256:5d6db497e19b51db0c95362b41c966d2e4b18ecd415795f7ac2d324fd5adbcf6 \
    https://github.com/Y2Z/monolith/releases/download/v2.12.0/monolith-cli-linux-x86_64 /monolith
FROM monolith-${TARGETARCH} AS monolith

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
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

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0
COPY --from=monolith --chmod=755 /monolith /usr/local/bin/monolith
# monolith won't start without the system's CA certificates, which the slim image leaves out.
# Saved copies live in /data/originals. The ids are the ones earlier (Alpine) images used, so the
# copies already in the volume stay this user's.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 101 gloss && useradd --system --uid 100 --gid gloss --no-create-home gloss \
    && mkdir -p /data/originals && chown gloss:gloss /data/originals
COPY --from=build --chown=gloss:gloss /app/.next/standalone ./
COPY --from=build --chown=gloss:gloss /app/.next/static ./.next/static
COPY --from=build --chown=gloss:gloss /app/public ./public
COPY --from=build /app/db ./db
COPY --from=build /app/scripts/migrate.mjs ./scripts/migrate.mjs
USER gloss
EXPOSE 3100
# The schema is safe to apply on every start, so a fresh database just works.
CMD ["sh", "-c", "node scripts/migrate.mjs && exec node server.js"]
