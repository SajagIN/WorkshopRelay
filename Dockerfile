# WorkshopRelay — single image for API / worker / mock (command selects entry).
FROM node:20-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Prisma engines require openssl; certs for HTTPS fetches.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund --legacy-peer-deps

COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
RUN npx prisma generate

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Non-root user for runtime.
RUN useradd --system --uid 10001 --create-home relay
USER relay

EXPOSE 3000 4100
# Default: API. docker-compose overrides per service.
CMD ["npx", "tsx", "src/api/server.ts"]
