FROM node:22-alpine

WORKDIR /srv

# pnpm via corepack
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

RUN pnpm install --frozen-lockfile=false

EXPOSE 5173
CMD ["pnpm", "--filter", "@osint/web", "dev", "--host", "0.0.0.0"]
