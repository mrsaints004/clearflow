#!/bin/bash
# Seed ClearFlow with a complete demo scenario for hackathon judges.
# Run this after starting the backend: npm run dev (in backend/)
#
# This script creates a full auction lifecycle:
#   1. Registers 4 parties (seller, 2 lenders, debtor)
#   2. Creates 2 invoices
#   3. Operator approves, debtor confirms
#   4. Starts an auction on the first invoice
#   5. Both lenders submit sealed bids
#   6. Seller closes the auction — winner revealed
#   7. Second invoice left confirmed (ready for judges to start their own auction)
#
# Usage: ./scripts/seed-demo.sh

set -e

API="http://localhost:3002/api"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         ClearFlow — Demo Data Seeder                       ║"
echo "║  Sealed-Bid Auctions with Protocol-Level Privacy           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─── Register Parties ─────────────────────────────────────────────
echo "[1/7] Registering parties..."

curl -sf -X POST "$API/parties/register" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"SellerCo","role":"seller","password":"seller-pass-123"}' | jq -r '"  + " + .displayName + " (" + .role + ")"'

curl -sf -X POST "$API/parties/register" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"LenderAlpha","role":"lender","password":"lender-pass-123"}' | jq -r '"  + " + .displayName + " (" + .role + ")"'

curl -sf -X POST "$API/parties/register" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"LenderBeta","role":"lender","password":"lender-pass-123"}' | jq -r '"  + " + .displayName + " (" + .role + ")"'

curl -sf -X POST "$API/parties/register" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"DebtorInc","role":"debtor","password":"debtor-pass-123"}' | jq -r '"  + " + .displayName + " (" + .role + ")"'

# ─── Login All Parties ─────────────────────────────────────────────
echo ""
echo "[2/7] Authenticating all parties..."

OP_TOKEN=$(curl -sf -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"party":"Operator","password":"operator-secret"}' | jq -r '.token')
echo "  Operator: authenticated"

SELLER_TOKEN=$(curl -sf -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"party":"SellerCo","password":"seller-pass-123"}' | jq -r '.token')
echo "  SellerCo: authenticated"

LENDER_A_TOKEN=$(curl -sf -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"party":"LenderAlpha","password":"lender-pass-123"}' | jq -r '.token')
echo "  LenderAlpha: authenticated"

LENDER_B_TOKEN=$(curl -sf -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"party":"LenderBeta","password":"lender-pass-123"}' | jq -r '.token')
echo "  LenderBeta: authenticated"

DEBTOR_TOKEN=$(curl -sf -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"party":"DebtorInc","password":"debtor-pass-123"}' | jq -r '.token')
echo "  DebtorInc: authenticated"

# ─── Create Invoices ──────────────────────────────────────────────
echo ""
echo "[3/7] Creating invoices (seller tokenizes receivables)..."

curl -sf -X POST "$API/invoices" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -d '{
    "invoiceId":"INV-2026-0001",
    "seller":"SellerCo",
    "debtor":"DebtorInc",
    "amount":75000,
    "currency":"USD",
    "sector":"Manufacturing",
    "paymentTermDays":30,
    "issueDate":"2026-06-01",
    "dueDate":"2026-07-01",
    "reliabilityScore":"A"
  }' | jq -r '"  INV-2026-0001: $75,000 USD / Manufacturing / 30d terms"'

curl -sf -X POST "$API/invoices" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -d '{
    "invoiceId":"INV-2026-0002",
    "seller":"SellerCo",
    "debtor":"DebtorInc",
    "amount":120000,
    "currency":"EUR",
    "sector":"Technology",
    "paymentTermDays":60,
    "issueDate":"2026-06-05",
    "dueDate":"2026-08-04",
    "reliabilityScore":"B"
  }' | jq -r '"  INV-2026-0002: EUR 120,000 / Technology / 60d terms"'

# ─── Approve + Confirm ───────────────────────────────────────────
echo ""
echo "[4/7] Operator approves, debtor confirms obligations..."

curl -sf -X POST "$API/invoices/INV-2026-0001/approve" \
  -H "Authorization: Bearer $OP_TOKEN" > /dev/null
curl -sf -X POST "$API/invoices/INV-2026-0001/confirm" \
  -H "Authorization: Bearer $DEBTOR_TOKEN" > /dev/null
echo "  INV-2026-0001: verified + confirmed"

curl -sf -X POST "$API/invoices/INV-2026-0002/approve" \
  -H "Authorization: Bearer $OP_TOKEN" > /dev/null
curl -sf -X POST "$API/invoices/INV-2026-0002/confirm" \
  -H "Authorization: Bearer $DEBTOR_TOKEN" > /dev/null
echo "  INV-2026-0002: verified + confirmed"

# ─── Start Auction on First Invoice ───────────────────────────────
echo ""
echo "[5/7] Seller starts blind auction on INV-2026-0001..."

curl -sf -X POST "$API/auctions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -d '{"invoiceId":"INV-2026-0001"}' | jq -r '"  Auction opened — lenders see anonymized metadata only"'

# ─── Lenders Submit Sealed Bids ───────────────────────────────────
echo ""
echo "[6/7] Lenders submit sealed bids (each bid is private)..."

COMMIT_A=$(curl -sf -X POST "$API/bids" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LENDER_A_TOKEN" \
  -d '{"lender":"LenderAlpha","invoiceId":"INV-2026-0001","discountRate":2.5}' | jq -r '.commitHash')
echo "  LenderAlpha bid: 2.5% discount rate"
echo "    SHA-256 commitment: ${COMMIT_A:0:16}..."
echo "    (LenderBeta CANNOT see this bid — it does not exist on their node)"

COMMIT_B=$(curl -sf -X POST "$API/bids" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LENDER_B_TOKEN" \
  -d '{"lender":"LenderBeta","invoiceId":"INV-2026-0001","discountRate":3.1}' | jq -r '.commitHash')
echo "  LenderBeta bid: 3.1% discount rate"
echo "    SHA-256 commitment: ${COMMIT_B:0:16}..."
echo "    (LenderAlpha CANNOT see this bid — it does not exist on their node)"

# ─── Close Auction ────────────────────────────────────────────────
echo ""
echo "[7/7] Seller closes auction — lowest rate wins..."

RESULT=$(curl -sf -X POST "$API/auctions/INV-2026-0001/close" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -d '{"seller":"SellerCo"}')
WINNER=$(echo "$RESULT" | jq -r '.winner // .winningLender // "unknown"')
RATE=$(echo "$RESULT" | jq -r '.winningRate // "unknown"')
echo "  Winner: $WINNER at ${RATE}% discount"
echo "  (Losing lender receives BidRejection — knows only that they lost)"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Demo scenario ready!                                      ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║                                                            ║"
echo "║  Login credentials:                                        ║"
echo "║    Operator    / operator-secret                           ║"
echo "║    SellerCo    / seller-pass-123                           ║"
echo "║    LenderAlpha / lender-pass-123                           ║"
echo "║    LenderBeta  / lender-pass-123                           ║"
echo "║    DebtorInc   / debtor-pass-123                           ║"
echo "║                                                            ║"
echo "║  What judges should try:                                   ║"
echo "║    1. Sign in as Operator -> Breach Test tab               ║"
echo "║       Select LenderAlpha vs LenderBeta -> Run test         ║"
echo "║       -> ALL ATTEMPTS BLOCKED (protocol-level)             ║"
echo "║                                                            ║"
echo "║    2. Sign in as LenderAlpha -> see your winning bid       ║"
echo "║       Sign in as LenderBeta  -> see only BidRejection      ║"
echo "║       (proves data isolation between competing lenders)     ║"
echo "║                                                            ║"
echo "║    3. INV-2026-0002 is ready for a new auction             ║"
echo "║       (judges can run the full flow themselves)             ║"
echo "║                                                            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Open http://localhost:3000 to begin."
echo ""
