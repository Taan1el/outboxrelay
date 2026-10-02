# Multi-stage Docker build for OutboxRelay
FROM node:24-alpine AS base
WORKDIR /app

# Stage 1: Build client and server
FROM base AS builder
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci

COPY shared/ ./shared/
COPY server/ ./server/
COPY client/ ./client/

RUN npm run build

# Stage 2: Production runtime
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=4003

COPY package.json ./
COPY server/package.json ./server/
COPY --from=builder /app/node_modules ./node_modules
# tsc compiles shared/ into server/dist/shared, so the shared sources are not copied.
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

# The SQLite file lives in /app/data (mount a volume there); the unprivileged node user must own it.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 4003

CMD ["node", "server/dist/server/src/index.js"]