# ClearFlow — Privacy-Preserving Invoice Factoring on Canton Network

**Sealed-bid auctions where competing lenders physically cannot see each other's bids — enforced at the protocol level by Canton's sub-transaction privacy.**

> Built for the [Build on Canton Hackathon 2025](https://www.encodeclub.com/programmes/canton-hackathon)
> Track: Private DeFi & Capital Markets | TradeFi, RWA & Tokenized Assets

---

## The Problem

In traditional invoice factoring, sellers expose sensitive commercial data — debtor identities, exact amounts, payment terms — to every competing lender. This creates:

- **Information leakage** between competing financial institutions
- **Front-running risk** where early bidders influence later bids
- **Privacy violations** that deter businesses from accessing liquidity

On public blockchains, "sealed-bid" auctions are sealed by convention (encrypted on-chain, decrypted later). The data still exists — MEV bots, validators, and anyone with state access can extract it.

## The Solution

ClearFlow uses Canton Network's sub-transaction privacy to guarantee that **bid data physically does not exist on unauthorized participant nodes**. This is not access control — it's a protocol-level property.

| What | How Canton Enforces It |
|---|---|
| Lender A cannot see Lender B's bid | `SealedBid` contract has zero observers — data never delivered to other nodes |
| Lenders cannot see debtor identity | `Invoice` contract has signatories: operator + seller only |
| Losers learn nothing about the winner | `BidRejection` reveals only "you lost" — no rate, no identity |
| Debtor only sees payment redirect | `PaymentNotification` omits auction mechanics entirely |

---

## Live Demo

### Deployed on Canton Seaport Devnet

- **Ledger API:** `https://ledger-api.validator.devnet.sandbox.fivenorth.io`
- **Authentication:** OIDC via FiveNorth sandbox
- **Party ID:** `f4dbfebec4322c5e4cc39a1c4be51b0b::1220971042ca31875e35bbc7f9b219502aa7ed63e50eebc5b999c1229beeb970aa49`

### Run Locally (connected to devnet)

```bash
npm run install:all
npm run dev
```

The backend connects to Seaport Devnet on startup. All transactions are submitted to the Canton ledger via the Ledger API v2.

1. Register as **Operator** (has permissions for all actions)
2. Use keyboard shortcuts `1`/`2`/`3`/`4` to instantly switch between Seller/Lender/Operator/Debtor views
3. Full workflow: Create Invoice → Approve → Confirm → Start Auction → Bid → Close → Settle

### Demo Flow

```
[1] Seller View    → Create invoice, start auction
[2] Lender View    → Submit sealed bid (cannot see other bids)
[3] Operator View  → Approve invoices, run breach tests, view privacy audit
[4] Debtor View    → Confirm obligations, receive payment notifications
```

---

## Architecture

```
Frontend (React 19)              Backend (Express/TypeScript)         Canton Network
┌─────────────────────┐         ┌─────────────────────────┐        ┌──────────────────┐
│ Role-Based Views    │────────>│ REST API (40+ endpoints) │───────>│ Daml Contracts   │
│ Privacy Audit Panel │────────>│ JWT Auth + Role Guards   │        │ ├─ Invoice       │
│ Breach Test Demo    │────────>│ SHA-256 Commitments      │        │ ├─ SealedBid     │
│ AI Agent System     │────────>│ Hash-Chained Audit Log   │        │ ├─ AuctionResult │
└─────────────────────┘         └─────────────────────────┘        │ └─ Settlement    │
                                                                    └──────────────────┘
                                                                    Seaport Devnet (v2 API)
```

### Daml Contract Privacy Model

```
Invoice.Invoice        → signatory: operator, seller       (lenders NEVER see this)
Auction.SealedBid      → signatory: operator, lender       (ZERO observers — fully private)
Auction.AuctionResult  → observer:  winningLender ONLY     (losers get BidRejection)
Auction.BidRejection   → observer:  losing lender          (knows only that they lost)
```

---

## Key Features

### Protocol-Level Privacy
- Sub-transaction privacy via Canton — data non-existence, not access control
- Sealed-bid auctions with zero-observer bid contracts
- Anonymized metadata (amount buckets, sector) — never exact amounts or debtor names
- Interactive breach test proving Canton blocks unauthorized data access

### Cryptographic Integrity
- SHA-256 commit-reveal scheme preventing front-running
- Hash-chained audit log with tamper detection
- Document hashing for invoice authenticity verification

### Financial Workflow
- 4-role system: Seller, Lender, Operator, Debtor
- Invoice tokenization with lifecycle management
- Dispute resolution with operator arbitration
- Portfolio auctions with cross-currency netting
- 6-factor risk scoring engine (sector, terms, amount, history, currency, temporal)

### AI Agent System
- Autonomous bidding agents with 4 strategies (value, volume, selective, adaptive)
- Real-time auction analysis with risk-adjusted recommendations
- Performance tracking: win rate, Sharpe ratio, concentration limits

---

## Tech Stack

| Layer | Technology |
|---|---|
| Smart Contracts | Daml (Canton Network SDK 2.10.4) |
| Ledger | Canton Seaport Devnet (Ledger API v2) |
| Backend | Node.js 20 / Express 4.21 / TypeScript 5.6 |
| Frontend | React 19 / TypeScript |
| Auth | bcrypt + HMAC-SHA256 JWT + role-based guards |
| Cryptography | SHA-256 bid commitments, hash-chained audit |
| Validation | Zod schemas on all inputs |
| Security | Helmet, rate limiting, CORS, atomic file writes |
| Deployment | Docker multi-stage / VPS (systemd + nginx) |

---

## Setup

### Prerequisites

- Node.js 20+
- npm

### Install & Run

```bash
git clone <repo-url> && cd clearflow
npm run install:all
npm run dev
```

Frontend runs on `http://localhost:3000`, backend on `http://localhost:3002`.

### Environment Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Canton Seaport Devnet
SEAPORT_DEVNET=true
LEDGER_API_URL=https://ledger-api.validator.devnet.sandbox.fivenorth.io
SEAPORT_OIDC_CLIENT_SECRET=<your-secret-from-hackathon>
```

### Seed Demo Data

```bash
./scripts/seed-demo.sh
```

### Run Tests

```bash
# Backend (154 tests)
cd backend && npm test

# Daml contracts
daml test
```

---

## Project Structure

```
clearflow/
├── daml/                        # Daml smart contracts
│   ├── Invoice.daml             # Invoice lifecycle + privacy model
│   ├── Auction.daml             # Sealed bids + atomic settlement
│   └── Test.daml                # Privacy verification tests
├── backend/src/
│   ├── server.ts                # REST API (40+ endpoints)
│   ├── daml-client.ts           # Canton Seaport Devnet integration (OIDC + v2 API)
│   ├── ledger.ts                # Ledger state management
│   ├── auth.ts                  # JWT auth + bcrypt + role guards
│   ├── crypto.ts                # SHA-256, commitments, audit chain
│   ├── agent.ts                 # AI bidding agent system
│   ├── validation.ts            # Zod input schemas
│   └── __tests__/               # 154 tests across 9 suites
├── frontend/src/
│   ├── App.tsx                  # Role-based routing + keyboard shortcuts
│   ├── components/
│   │   ├── SellerView.tsx       # Invoice creation + auction management
│   │   ├── LenderView.tsx       # Sealed bid submission
│   │   ├── OperatorView.tsx     # Verification + dispute resolution
│   │   ├── DebtorView.tsx       # Payment notifications
│   │   ├── PrivacyBreachDemo.tsx # Interactive security testing
│   │   └── PrivacyAuditView.tsx # Visibility matrix
│   └── hooks/useApi.ts          # Typed API client
├── canton/                      # Canton network topology
├── deploy/                      # VPS + Docker deployment
├── docker-compose.yml
├── Dockerfile
└── documentation.md             # Full technical reference
```

---

## Privacy Breach Test

The breach test panel simulates real attack scenarios:

1. **Lender → Lender's Bids** — Attempts to read another lender's sealed bid
2. **Lender → Invoice Details** — Attempts to access debtor identity
3. **Non-participant → Settlement** — Attempts to read settlement terms

Each attempt is **BLOCKED** at the protocol level. In Canton mode, the data physically does not exist on the attacker's node. The breach test proves this live.

---

## Documentation

For comprehensive technical documentation including:
- Complete API reference (40+ endpoints with request/response examples)
- Daml contract design with signatory/observer analysis
- Privacy model deep dive
- Risk scoring algorithm
- AI agent architecture
- Deployment guides (VPS, Docker, Seaport Devnet)
- Security considerations

See **[documentation.md](./documentation.md)**

---

## Team

Built for Build on Canton Hackathon 2025.

## License

MIT
