#!/bin/bash
# Start ClearFlow with multi-participant Canton topology
#
# Prerequisites:
#   - Canton binary installed (https://www.canton.io/docs/)
#   - Java 17+ installed
#   - DAR built: cd .. && daml build
#
# This script:
#   1. Starts 4 participant nodes (operator + 3 slots for dynamic registration)
#   2. Starts 1 domain (sequencer + mediator)
#   3. Connects all participants to the domain
#   4. Allocates Operator party on the operator participant
#   5. Starts JSON API instances per participant
#
# Privacy enforcement:
#   Each participant only receives transaction views it's entitled to.
#   A lender on participant-2 never sees a bid from participant-3 —
#   enforced by the Canton protocol, not application code.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Build DAR if not present
DAR_FILE="$PROJECT_DIR/.daml/dist/clearflow-0.1.0.dar"
if [ ! -f "$DAR_FILE" ]; then
  echo "Building DAR..."
  cd "$PROJECT_DIR" && daml build
fi

echo "Starting multi-participant Canton topology..."
echo "  - participant-operator (ledger API: 6861, JSON API: 7571)"
echo "  - participant-1        (ledger API: 6862, JSON API: 7572)"
echo "  - participant-2        (ledger API: 6863, JSON API: 7573)"
echo "  - participant-3        (ledger API: 6864, JSON API: 7574)"
echo "  - clearflow-domain     (public API: 5018)"
echo ""

# Start Canton daemon with bootstrap
canton daemon \
  --config "$SCRIPT_DIR/topology.conf" \
  --bootstrap "$SCRIPT_DIR/bootstrap.canton" &

CANTON_PID=$!

# Wait for Canton to be ready
echo "Waiting for Canton to start..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:6861/readyz > /dev/null 2>&1; then
    echo "Canton is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Canton did not start within 30 seconds"
    kill $CANTON_PID 2>/dev/null
    exit 1
  fi
  sleep 1
done

# Start JSON API instances per participant
# In production, each organization runs their own JSON API
echo ""
echo "Starting JSON API instances..."

# Operator JSON API (port 7571)
daml json-api \
  --ledger-host localhost --ledger-port 6861 \
  --http-port 7571 \
  --allow-insecure-tokens &

# Participant 1 JSON API (port 7572)
daml json-api \
  --ledger-host localhost --ledger-port 6862 \
  --http-port 7572 \
  --allow-insecure-tokens &

# Participant 2 JSON API (port 7573)
daml json-api \
  --ledger-host localhost --ledger-port 6863 \
  --http-port 7573 \
  --allow-insecure-tokens &

# Participant 3 JSON API (port 7574)
daml json-api \
  --ledger-host localhost --ledger-port 6864 \
  --http-port 7574 \
  --allow-insecure-tokens &

echo ""
echo "Multi-participant ClearFlow is ready!"
echo ""
echo "To connect the backend with per-participant routing:"
echo "  export LEDGER_API_URL=http://localhost:7571"
echo "  export CANTON_PARTICIPANT_URLS='operator=http://localhost:7571,p1=http://localhost:7572,p2=http://localhost:7573,p3=http://localhost:7574'"
echo ""
echo "Press Ctrl+C to stop all processes."

# Trap SIGINT/SIGTERM and kill all children
trap 'kill $(jobs -p) 2>/dev/null; exit 0' SIGINT SIGTERM
wait
