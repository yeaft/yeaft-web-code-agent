# WebChat Server Dockerfile
# Multi-stage build for production optimization

# Stage 1: Build frontend
FROM node:20-alpine AS builder

WORKDIR /app

# Copy web package and vendor files
COPY web/package*.json ./web/
COPY web/vendor ./web/vendor/

# Install web build dependencies
WORKDIR /app/web
RUN npm install

# Copy web source files
COPY web/*.js web/*.css web/*.html ./
COPY web/components ./components/
COPY web/stores ./stores/
COPY web/styles ./styles/
COPY web/utils ./utils/
COPY web/i18n ./i18n/
COPY web/crew-templates ./crew-templates/

# Build frontend (bundles all JS/CSS into single files + gzip)
RUN npm run build

# Stage 2: Production image
FROM node:20-alpine

ARG BUILD_VERSION=dev

WORKDIR /app

# Write version info (injected from git tag at build time)
RUN echo "{\"version\":\"${BUILD_VERSION}\"}" > /app/version.json

# Copy root package files for workspaces support
COPY package.json package-lock.json ./

# Copy server package.json (needed for workspace resolution)
COPY server/package.json ./server/

# Install server dependencies only (using workspaces)
RUN npm ci --workspace=server --omit=dev

# Copy server source
COPY server/*.js ./server/
COPY server/handlers ./server/handlers/
COPY server/routes ./server/routes/
COPY server/db ./server/db/
COPY server/auth ./server/auth/

# Copy built frontend from builder stage (only dist folder needed)
COPY --from=builder /app/web/dist ./web/dist/

# Create data directory for SQLite
RUN mkdir -p /app/data

# Environment variables
ENV NODE_ENV=production
ENV SERVE_DIST=true
ENV PORT=3456

EXPOSE 3456

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3456/api/auth/mode || exit 1

# Start server
CMD ["node", "server/index.js"]
