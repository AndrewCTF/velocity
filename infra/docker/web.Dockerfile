FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

WORKDIR /srv

# pnpm via corepack; version tracks package.json `packageManager`. The image's
# bundled npm (and its tar/pacote/sigstore tree) is never used after this, so
# it is deleted rather than left as fixable-CVE surface; `apk upgrade` pulls
# Alpine security fixes newer than the pinned digest.
RUN apk upgrade --no-cache \
    && corepack enable && corepack prepare pnpm@10.34.5 --activate \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

# Frozen lockfile → reproducible image builds; an out-of-date lockfile is a
# build error here, not a silent dependency drift.
# pnpm is needed only for this install. Its own bundled dependencies carry
# fixable CVEs upstream (tar, brace-expansion, ip-address; still present in
# pnpm 11.27), so the package manager is removed from the image once
# node_modules exists: the containers run vite/tsc straight from node_modules.
RUN pnpm install --frozen-lockfile \
    && corepack disable \
    && rm -rf /root/.cache/node/corepack /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

# Run as an unprivileged user (Alpine BusyBox adduser). Pre-create the dist dir
# so a named volume mounted there (docker-compose.prod.yml web-build) seeds its
# ownership from an app-owned mountpoint and stays writable by uid 10001.
RUN mkdir -p /srv/apps/web/dist \
    && addgroup -S app && adduser -S -G app -u 10001 app && chown -R app /srv
USER app

EXPOSE 5173
WORKDIR /srv/apps/web
CMD ["node_modules/.bin/vite", "--host", "0.0.0.0"]
