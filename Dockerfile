# Multi-stage build for ClearFlow
# Stage 1: Build frontend
FROM node:20-alpine3.19 AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
RUN npm run build

# Stage 2: Build backend
FROM node:20-alpine3.19 AS backend-build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --ignore-scripts
COPY backend/ ./
RUN npx tsc

# Stage 3: Production image
FROM node:20-alpine3.19
WORKDIR /app

# Security: run as non-root user
RUN addgroup -S clearflow && adduser -S clearflow -G clearflow

# Copy backend
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY backend/package*.json ./

# Copy frontend build (served by Express in production)
COPY --from=frontend-build /app/frontend/build ./public

# Create data directory with correct permissions
RUN mkdir -p data && chown -R clearflow:clearflow /app

# Switch to non-root user
USER clearflow

ENV NODE_ENV=production
ENV PORT=3002

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/api/health || exit 1

CMD ["node", "dist/server.js"]
