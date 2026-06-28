# ClearFlow — Provably Private Sealed-Bid Auctions on Canton Network

**The first platform where competing bidders physically cannot see each other's bids — enforced by Canton's sub-transaction privacy at the protocol level, not the application layer.**

ClearFlow applies Canton Network's participant-level privacy guarantees to invoice financing auctions. The result: a system where data isolation is not a feature you trust — it's a property you can verify.

> Built for the [Build on Canton Hackathon 2026](https://www.encodeclub.com/programmes/canton-hackathon)
> Tracks: Private DeFi & Capital Markets | TradeFi, RWA & Tokenized Assets

---

## Why This Matters

On every other blockchain, sealed-bid auctions are sealed by convention — the data exists on-chain, and you trust the smart contract not to leak it. On Canton, sealed bids are sealed by physics — the data physically does not exist on unauthorized participant nodes.

### The Problem with "Private" Auctions on Public Chains

| Chain Type | What "sealed" means | Risk |
|---|---|---|
| **Public L1** (Ethereum, Solana) | Encrypted on-chain, decrypted after reveal | MEV bots, front-running, miner extraction |
| **Permissioned L1** (Hyperledger) | Access-controlled channels | Shared state within channels, operator visibility |
| **Canton Network** | **Data physically absent from unauthorized nodes** | **None — protocol-level guarantee** |

### ClearFlow's Privacy Model

| Data | Seller | Lender (pre-bid) | Winning Lender | Other Lenders | Debtor |
|---|---|---|---|---|---|
| Debtor identity | Yes | **No** | Yes (post-win) | **No** | Yes |
| Exact invoice amount | Yes | **No** (bucket only) | Yes (post-win) | **No** | Yes |
| Other lenders' bids | After close | **No** | **No** | **No** | No |
| Settlement details | Yes | N/A | Yes | **No** | Redirection only |

This is not access control. Each Canton participant node only receives contracts where its hosted party is a signatory or observer. There is no global ledger to query.

---

## How It Works

```
Seller                 Operator               Debtor                Lender A              Lender B
  │                       │                      │                     │                     │
  ├── Tokenize Invoice ──>│                      │                     │                     │
  │                       ├── Verify ────────────>│                     │                     │
  │                       │                      ├── Confirm ─────────>│                     │
  │                       │                      │                     │                     │
  ├── Start Auction ─────>│ (broadcasts anonymized metadata to all lenders)                  │
  │                       │                      │                     │                     │
  │                       │                      │   ┌─ Submit Bid ────┤                     │
  │                       │                      │   │  (PRIVATE: only  │                     │
  │                       │                      │   │   operator +     │                     │
  │                       │                      │   │   this lender)   │                     │
  │                       │                      │   │                  │   ┌─ Submit Bid ────┤
  │                       │                      │   │                  │   │  (PRIVATE: only  │
  │                       │                      │   │                  │   │   operator +     │
  │                       │                      │   │                  │   │   this lender)   │
  │                       │                      │   │                  │   │                  │
  ├── Close Auction ─────>│                      │   │                  │   │                  │
  │                       ├── AuctionResult ─────┼───┼──────────────────┤   │                  │
  │                       │   (winner only)      │   │                  │   │                  │
  │                       ├── BidRejection ──────┼───┼──────────────────┼───┼──────────────────┤
  │                       │   (loser: knows      │   │                  │   │                  │
  │                       │    only that they     │   │                  │   │                  │
  │                       │    lost, nothing      │   │                  │   │                  │
  │                       │    else)              │   │                  │   │                  │
```

**Lender A and Lender B never learn each other's bids, identities, or even that the other participated.** This is guaranteed by Canton's sub-transaction privacy — each `SealedBid` contract has only 2 signatories (operator + that specific lender) and zero observers.

---

## Architecture

```
Frontend (React/TypeScript)      Backend (Express/TypeScript)      Canton Network
┌─────────────────────┐         ┌─────────────────────┐          ┌──────────────────┐
│ Login / Register    │────────>│                     │─────────>│ Daml Contracts    │
│ Seller View         │────────>│  REST API           │          │ ├─ Invoice        │
│ Operator View       │────────>│  (port 3002)        │          │ ├─ AuctionInvite  │
│ Debtor View         │────────>│                     │          │ ├─ SealedBid      │
│ Lender View         │────────>│  JWT Auth + bcrypt  │          │ ├─ AuctionResult  │
│ Privacy Audit View  │         │  SHA-256 Crypto     │          │ ├─ BidRejection   │
│ Breach Test Panel   │         │  Audit Chain        │          │ └─ SettledInvoice │
└─────────────────────┘         └─────────────────────┘          └──────────────────┘
                                         │
                                         ▼
                                Canton Multi-Participant Topology
                                ┌─────────────────────────────┐
                                │ participant-operator (6861)  │
                                │ participant-1       (6862)   │
                                │ participant-2       (6863)   │
                                │ participant-3       (6864)   │
                                │ clearflow-domain    (5018)   │
                                └─────────────────────────────┘
```

---

## Daml Contract Design

The privacy model is enforced through Daml's signatory/observer system:

```
Invoice.Invoice        → signatory: operator, seller       (lenders never see this)
Invoice.AuctionInvite  → signatory: operator, seller
                         observer:  lenderObservers[]       (lenders see metadata only)
Auction.SealedBid      → signatory: operator, lender       (no observers — fully private)
Auction.AuctionResult  → signatory: operator, seller
                         observer:  winningLender only      (losers get BidRejection)
Auction.BidRejection   → signatory: operator
                         observer:  losing lender           (sees only that they lost)
Auction.SettledInvoice → signatory: operator, seller
                         observer:  winning lender
Invoice.PaymentNotification → signatory: operator
                              observer:  debtor, winningLender
```

Canton's protocol guarantees that each participant node only receives contracts where its hosted party is a signatory or observer. Data physically does not exist on unauthorized nodes.

---

## Quick Start

### Standalone Mode (no Canton required)

```bash
npm run install:all
npm run dev
```

The app detects whether Canton is available and falls back to a standalone ledger that mirrors the Daml contract logic with application-level privacy enforcement.

### Seed Demo Data

```bash
./scripts/seed-demo.sh
```

Registers 4 parties (SellerCo, LenderAlpha, LenderBeta, DebtorInc), creates 2 invoices, and prints login credentials.

### With Canton Ledger (protocol-level privacy)

```bash
daml build
cd canton && ./start.sh
cd backend && LEDGER_API_URL=http://localhost:7571 npm run dev
cd frontend && npm start
```

### With Seaport Devnet

```bash
cd backend && SEAPORT_DEVNET=true LEDGER_API_URL=https://devnet.seaport.to npm run dev
```

### With Docker

```bash
docker-compose up --build
```

---

## Running Tests

### Daml Contract Tests

```bash
daml test
```

Tests cover: full invoice lifecycle, **bid privacy verification** (Lender A cannot see Lender B's bid via `queryContractId`), commit-reveal flow, dispute resolution, and atomic settlement.

### Backend Tests

```bash
cd backend && npx tsx src/__tests__/run-all.ts
```

40+ tests across: ledger operations, cryptography, risk scoring, portfolio auctions, disputes, and input validation.

---

## Key Features

### Privacy-First Design

- **Sub-transaction privacy** — Canton protocol ensures data non-existence on unauthorized nodes
- **Sealed-bid auctions** — `SealedBid` contracts have zero observers; only operator + that lender
- **Anonymized metadata** — lenders see amount buckets (e.g., "50K-100K"), never exact amounts or debtor names
- **Privacy breach testing** — live security panel proving Canton's data isolation

### Cryptographic Integrity

- **SHA-256 bid commitments** — commit-reveal prevents front-running and bid manipulation
- **Hash-chained audit log** — tamper-evident trail with integrity verification endpoint
- **Document hashing** — SHA-256 fingerprints for invoice authenticity

### Multi-Party Workflow

- **4-role system** — Seller, Lender, Operator, Debtor with enforced isolation
- **Dynamic party registration** — no hardcoded parties, bcrypt password hashing
- **Dispute resolution** — debtor can dispute, operator arbitrates
- **Portfolio auctions** — bundle multiple invoices with cross-currency netting

### Production Readiness

- **Dual-mode operation** — auto-detects Canton or falls back to standalone ledger
- **JWT authentication** with bcrypt password hashing
- **Helmet security headers**, rate limiting, CORS
- **Docker multi-stage build** with non-root user
- **6-factor risk scoring** — sector, terms, amount, debtor history, currency, temporal

---

## Project Structure

```
clearflow/
├── daml/                        # Daml smart contracts
│   ├── Invoice.daml             # Invoice tokenization + anonymized metadata
│   ├── Auction.daml             # Sealed bids + atomic settlement
│   └── Test.daml                # Privacy + commit-reveal + dispute tests
├── backend/
│   └── src/
│       ├── server.ts            # REST API (40+ endpoints)
│       ├── daml-client.ts       # Canton JSON API integration
│       ├── ledger.ts            # Standalone ledger with persistence
│       ├── auth.ts              # bcrypt auth + JWT tokens
│       ├── crypto.ts            # SHA-256, bid commitments, audit chain
│       ├── persistence.ts       # Atomic file persistence
│       ├── validation.ts        # Zod input validation schemas
│       └── __tests__/           # 40+ tests (8 test suites)
├── frontend/
│   └── src/
│       ├── App.tsx              # Login/register + view router
│       ├── components/
│       │   ├── SellerView.tsx    # Invoice creation + auction management
│       │   ├── LenderView.tsx   # Sealed bid submission + pricing
│       │   ├── OperatorView.tsx  # Verification + dispute resolution
│       │   ├── DebtorView.tsx   # Confirmation + payment notifications
│       │   ├── PrivacyAuditView.tsx  # Visibility matrix
│       │   ├── LivePrivacyPanel.tsx  # Real-time privacy scopes
│       │   ├── PrivacyBreachDemo.tsx # Security testing
│       │   └── TransactionLog.tsx
│       ├── hooks/useApi.ts
│       └── types/index.ts
├── canton/                      # Canton network configuration
│   ├── topology.conf            # 4-participant topology
│   ├── bootstrap.canton         # Party allocation + DAR upload
│   └── start.sh                 # Start Canton + JSON APIs
├── scripts/
│   └── seed-demo.sh             # Seed demo data
├── docker-compose.yml
├── Dockerfile                   # Multi-stage production build
└── render.yaml                  # Render.com deployment config
```

## Tech Stack

| Layer | Technology |
|---|---|
| Smart Contracts | Daml (Canton Network SDK 2.10.4) |
| Backend | Node.js / Express / TypeScript |
| Frontend | React 19 / TypeScript |
| Authentication | bcrypt + HMAC-SHA256 JWT |
| Cryptography | SHA-256 bid commitments, hash-chained audit log |
| Privacy | Canton sub-transaction privacy (protocol-level) |
| Deployment | Docker multi-stage build, Render.com |

## License

MIT
