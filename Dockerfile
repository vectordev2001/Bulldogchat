# Vector Chat — production Docker image for Render
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native module
RUN apk add --no-cache python3 make g++ sqlite

# Install all deps (incl. dev) for the build
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# --- Production image ---
FROM node:20-alpine AS runner

WORKDIR /app

# Runtime libs: sqlite for backups/debug, openssl for crypto
RUN apk add --no-cache sqlite openssl

ENV NODE_ENV=production
ENV PORT=5000

# Install only production deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the bundled output and static client
COPY --from=builder /app/dist ./dist

# Persistent data directory mounted by Render disk
RUN mkdir -p /app/data

EXPOSE 5000

# Health check pings the API
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/health || exit 1

CMD ["node", "dist/index.cjs"]
