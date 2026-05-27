# Vector Chat — production Docker image for Render
# Single-stage build: keeps native modules (better-sqlite3) compiled and in place
FROM node:20-bookworm-slim

WORKDIR /app

# System deps: python3/make/g++ for native modules, sqlite3 for runtime, ca-certs for HTTPS
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ sqlite3 ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=5000

# Install ALL deps first (incl. dev) so we can run the build
COPY package*.json ./
RUN npm ci --include=dev

# Copy source and build
COPY . .
RUN npm run build

# Prune dev deps after build to shrink image — better-sqlite3 stays compiled
RUN npm prune --omit=dev && npm cache clean --force

# Persistent data directory mounted by Render disk
RUN mkdir -p /app/data

EXPOSE 5000

# Health check pings the API
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/health || exit 1

CMD ["node", "dist/index.cjs"]
