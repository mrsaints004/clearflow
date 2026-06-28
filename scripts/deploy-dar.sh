#!/bin/bash
# Deploy ClearFlow DAR to Seaport Devnet
# Run after downloading the Daml SDK 3.x
set -e

CLEARFLOW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SDK_TARBALL="/tmp/daml-sdk-3.4.11.tar.gz"
SDK_DIR="$HOME/.daml/sdk/3.4.11"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║     ClearFlow — DAR Deployment to Seaport Devnet           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Step 1: Install SDK 3.4.11 if not present
if [ ! -d "$SDK_DIR" ]; then
  echo "[1/4] Installing Daml SDK 3.4.11..."
  if [ ! -f "$SDK_TARBALL" ]; then
    echo "  ERROR: SDK tarball not found at $SDK_TARBALL"
    echo "  Download it first: curl -L -o $SDK_TARBALL https://github.com/digital-asset/daml/releases/download/v3.4.11/daml-sdk-3.4.11-macos-x86_64.tar.gz"
    exit 1
  fi
  mkdir -p "$SDK_DIR"
  tar xzf "$SDK_TARBALL" -C "$SDK_DIR" --strip-components=1
  echo "  SDK installed to $SDK_DIR"
else
  echo "[1/4] Daml SDK 3.4.11 already installed"
fi

# Step 2: Build the DAR
echo ""
echo "[2/4] Building ClearFlow DAR with SDK 3.4.11..."
cd "$CLEARFLOW_DIR"

# Use SDK 3.4.11's damlc to compile
DAMLC="$SDK_DIR/damlc/damlc"
if [ ! -f "$DAMLC" ]; then
  # Try alternate path
  DAMLC="$SDK_DIR/sdk/damlc/damlc"
fi
if [ ! -f "$DAMLC" ]; then
  echo "  Falling back to daml build..."
  export PATH="$SDK_DIR/bin:$HOME/.daml/bin:$PATH"
  DAML_SDK_VERSION=3.4.11 ~/.daml/bin/daml build
else
  echo "  Using damlc at $DAMLC"
  $DAMLC build --project-root "$CLEARFLOW_DIR"
fi

DAR_FILE="$CLEARFLOW_DIR/.daml/dist/clearflow-0.1.0.dar"
if [ ! -f "$DAR_FILE" ]; then
  echo "  ERROR: DAR file not found at $DAR_FILE"
  exit 1
fi
echo "  DAR built: $DAR_FILE ($(du -h "$DAR_FILE" | cut -f1))"

# Step 3: Get auth token
echo ""
echo "[3/4] Authenticating with Seaport devnet..."
source "$CLEARFLOW_DIR/.env" 2>/dev/null || true

OIDC_ISSUER="${SEAPORT_OIDC_ISSUER:-https://auth.sandbox.fivenorth.io/application/o/token/}"
CLIENT_ID="${SEAPORT_OIDC_CLIENT_ID:-validator-devnet-m2m}"
CLIENT_SECRET="${SEAPORT_OIDC_CLIENT_SECRET}"
LEDGER_URL="${LEDGER_API_URL:-https://ledger-api.validator.devnet.sandbox.fivenorth.io}"

TOKEN=$(curl -sf -X POST "$OIDC_ISSUER" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&audience=$CLIENT_ID&scope=daml_ledger_api" | jq -r '.access_token')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "  ERROR: Failed to get auth token"
  exit 1
fi
echo "  Token obtained (${#TOKEN} chars)"

# Step 4: Upload DAR
echo ""
echo "[4/4] Uploading DAR to Seaport devnet..."
UPLOAD_RESULT=$(curl -sf -X POST "$LEDGER_URL/v2/packages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$DAR_FILE" 2>&1)

if echo "$UPLOAD_RESULT" | jq -e '.code' > /dev/null 2>&1; then
  echo "  ERROR: Upload failed"
  echo "  $UPLOAD_RESULT" | jq .
  exit 1
fi

echo "  DAR uploaded successfully!"
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Deployment complete!                                      ║"
echo "║  ClearFlow contracts are now live on Seaport devnet.       ║"
echo "║                                                            ║"
echo "║  Next: Start the backend with 'npm run dev' and run        ║"
echo "║  './scripts/seed-demo.sh' to populate demo data.           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
