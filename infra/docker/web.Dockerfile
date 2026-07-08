FROM node:22-alpine

WORKDIR /srv

# pnpm via corepack
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

# Frozen lockfile → reproducible image builds; an out-of-date lockfile is a
# build error here, not a silent dependency drift.
RUN pnpm install --frozen-lockfile

# Run as an unprivileged user (Alpine BusyBox adduser). Pre-create the dist dir
# so a named volume mounted there (docker-compose.prod.yml web-build) seeds its
# ownership from an app-owned mountpoint and stays writable by uid 10001.
RUN mkdir -p /srv/apps/web/dist \
    && addgroup -S app && adduser -S -G app -u 10001 app && chown -R app /srv
USER app

EXPOSE 5173
CMD ["pnpm", "--filter", "@osint/web", "dev", "--host", "0.0.0.0"]
