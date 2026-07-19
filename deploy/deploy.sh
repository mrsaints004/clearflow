#!/bin/bash
# ClearFlow Deployment Script
# Run this on the VPS after copying code to /opt/clearflow
# Usage: cd /opt/clearflow && ./deploy/deploy.sh

set -euo pipefail

APP_DIR="/opt/clearflow"
cd "$APP_DIR"

echo "=== ClearFlow Deployment ==="

# Verify env file exists
if [ ! -f "$APP_DIR/.env.production" ]; then
  echo "ERROR: $APP_DIR/.env.production not found."
  echo "Copy deploy/.env.production.example to $APP_DIR/.env.production and fill in values."
  exit 1
fi

# 1. Install backend dependencies
echo "[1/5] Installing backend dependencies..."
cd "$APP_DIR/backend"
npm ci --omit=dev --ignore-scripts
npm install bcryptjs  # bcryptjs needs post-install

# 2. Build backend
echo "[2/5] Building backend..."
npx tsc

# 3. Install frontend dependencies
echo "[3/5] Installing frontend dependencies..."
cd "$APP_DIR/frontend"
npm ci --ignore-scripts

# 4. Build frontend
echo "[4/5] Building frontend..."
npm run build

# 5. Create data directory
echo "[5/5] Setting up data directory..."
mkdir -p "$APP_DIR/backend/data"

# Fix permissions
chown -R clearflow:clearflow "$APP_DIR"

# Restart service
echo "Restarting ClearFlow service..."
systemctl restart clearflow

echo ""
echo "=== Deployment Complete ==="
echo "Check status: systemctl status clearflow"
echo "View logs:    journalctl -u clearflow -f"
echo "Health check: curl http://localhost:3002/api/health"
