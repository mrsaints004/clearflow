# ClearFlow — Full Technical Documentation

> Comprehensive reference for developers, reviewers, and operators. For a quick overview, see [README.md](./README.md).

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Privacy Model](#3-privacy-model)
4. [Daml Smart Contracts](#4-daml-smart-contracts)
5. [Backend API Reference](#5-backend-api-reference)
6. [Authentication & Authorization](#6-authentication--authorization)
7. [Cryptographic Systems](#7-cryptographic-systems)
8. [Risk Scoring Engine](#8-risk-scoring-engine)
9. [AI Agent System](#9-ai-agent-system)
10. [Portfolio Auctions & Cross-Currency Netting](#10-portfolio-auctions--cross-currency-netting)
11. [Frontend Architecture](#11-frontend-architecture)
12. [Dual-Mode Operation](#12-dual-mode-operation)
13. [Data Persistence](#13-data-persistence)
14. [Testing](#14-testing)
15. [VPS Deployment Guide](#15-vps-deployment-guide)
16. [Docker Deployment](#16-docker-deployment)
17. [Configuration Reference](#17-configuration-reference)
18. [Security Considerations](#18-security-considerations)
19. [Troubleshooting](#19-troubleshooting)

---

## 1. Project Overview

ClearFlow is a sealed-bid auction platform for invoice financing, built on Canton Network. It demonstrates protocol-level privacy where competing bidders physically cannot see each other's bids — enforced by Canton's sub-transaction privacy model, not application-layer access control.

### Core Value Proposition

On public blockchains, "sealed-bid" auctions rely on encryption and trust — the data exists on-chain, visible to miners, MEV bots, and anyone with state access. On Canton, sealed bids are sealed by architecture: each participant node only receives contracts where its hosted party is a signatory or observer. Unauthorized data does not exist on the node at all.

### Hackathon Tracks

- **Private DeFi & Capital Markets** — Confidential invoice financing with sealed-bid pricing
- **TradeFi, RWA & Tokenized Assets** — Invoice tokenization, portfolio bundling, cross-currency netting

### Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Smart Contracts | Daml (Canton Network SDK) | 2.10.4 |
| Backend | Node.js / Express / TypeScript | Node 20 / Express 4.21 / TS 5.6 |
| Frontend | React / TypeScript | React 19 / TS 4.9 |
| Authentication | bcryptjs + HMAC-SHA256 JWT | bcryptjs 3.0.3 |
| Input Validation | Zod | 4.4.3 |
| Security Headers | Helmet | 8.2.0 |
| Rate Limiting | express-rate-limit | 8.5.2 |
| Deployment | Docker multi-stage / VPS (systemd + nginx) | — |

---

## 2. Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Client Browser                              │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  React 19 SPA                                                │    │
│  │  ├── Login / Register                                        │    │
│  │  ├── SellerView (create invoices, manage auctions)           │    │
│  │  ├── LenderView (browse auctions, submit sealed bids)        │    │
│  │  ├── OperatorView (verify invoices, resolve disputes)        │    │
│  │  ├── DebtorView (confirm obligations, payment redirects)     │    │
│  │  ├── PrivacyAuditView (visibility matrix)                    │    │
│  │  ├── LivePrivacyPanel (real-time privacy scopes)             │    │
│  │  ├── PrivacyBreachDemo (interactive security testing)        │    │
│  │  └── AgentPanel (AI agent configuration)                     │    │
│  └──────────────────────┬──────────────────────────────────────┘    │
└─────────────────────────┼──────────────────────────────────────────┘
                          │ HTTPS (JWT Bearer Auth)
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Express.js API Server (port 3002)                                  │
│  ├── Helmet security headers                                        │
│  ├── CORS with configurable origins                                 │
│  ├── Rate limiting (500 req/15min production, 20 for auth)          │
│  ├── JWT auth middleware                                             │
│  ├── Role-based authorization (requireRole)                         │
│  ├── Zod input validation on all POST endpoints                     │
│  ├── URL parameter validation                                       │
│  ├── 40+ REST endpoints                                             │
│  ├── SHA-256 audit chain                                             │
│  └── Graceful shutdown (SIGTERM/SIGINT)                              │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ daml-client   │  │ ledger.ts    │  │ agent.ts     │              │
│  │ (Canton API)  │  │ (Standalone) │  │ (AI Agents)  │              │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘              │
└─────────┼─────────────────┼────────────────────────────────────────┘
          │                 │
          ▼                 ▼
┌──────────────────┐  ┌──────────────────┐
│ Canton Network   │  │ File Persistence │
│ (JSON API)       │  │ (backend/data/)  │
│ ├── Seaport      │  │ ├── invoices     │
│ │   Devnet       │  │ ├── auctions     │
│ └── Local Canton │  │ ├── settlements  │
│    (4 nodes)     │  │ ├── parties      │
└──────────────────┘  │ └── agents       │
                      └──────────────────┘
```

### Request Flow

1. Client sends HTTPS request with `Authorization: Bearer <JWT>` header
2. Helmet applies security headers
3. CORS validates origin
4. Rate limiter checks request count
5. Auth middleware extracts party + role from JWT
6. Role guard (`requireRole`) verifies the caller has the right role
7. Zod schema validates request body
8. URL parameters validated against safe pattern
9. Route handler executes business logic (Canton API or standalone ledger)
10. Audit chain records the action
11. Response returned with appropriate HTTP status

---

## 3. Privacy Model

### Canton Sub-Transaction Privacy

Canton's privacy model differs fundamentally from other blockchains:

| Concept | Public Chain | Canton Network |
|---|---|---|
| Data visibility | All validators see all data | Each participant only sees data where its party is signatory/observer |
| "Sealed" mechanism | Encryption + trust | Data non-existence on unauthorized nodes |
| Attack surface | MEV, front-running, miner extraction | None — data physically absent |
| Verification | Decrypt after reveal | Canton sequencer enforces delivery rules |

### ClearFlow Visibility Matrix

| Data Element | Operator | Seller | Lender (pre-bid) | Winning Lender | Losing Lenders | Debtor |
|---|---|---|---|---|---|---|
| Invoice details | Full | Full | Metadata only | Full (post-win) | Never | Full |
| Debtor identity | Yes | Yes | No | Yes (post-win) | No | Yes |
| Exact amount | Yes | Yes | Bucket only | Yes (post-win) | No | Yes |
| Own bid | N/A | N/A | Yes | Yes | Yes | No |
| Other bids | All (post-close) | All (post-close) | No | No | No | No |
| Winner identity | Yes | Yes (post-close) | N/A | Yes | No | Post-settlement |
| Settlement terms | Yes | Yes | N/A | Yes | No | Payment redirect only |

### How Privacy Is Enforced

**In Canton mode (protocol-level):**
- Each `SealedBid` contract has `signatory operator, lender` and NO observers
- Canton's sequencer only delivers contract data to nodes hosting signatories/observers
- Lender A's participant node never receives Lender B's bid data — it doesn't exist there

**In standalone mode (application-level):**
- `getBidsForParty()` filters bids to only return those matching the requesting party
- Auction details are filtered by role before returning
- This mirrors the Canton guarantee at the application layer

### Privacy Breach Testing

The `/api/privacy-breach-test` endpoint simulates attack scenarios:
- Lender trying to read another lender's sealed bids
- Lender trying to access full invoice details
- Non-participant trying to access settlement details

Each attempt is logged with the protection mechanism that blocked it.

---

## 4. Daml Smart Contracts

### Contract Templates

#### `Invoice.Invoice`
```
Signatories: operator, seller
Observer: debtor (debtorName field)
```

The source of truth for invoice data. Only the seller and operator see full details. The debtor can see invoices where they are the obligor.

**Choices:**
| Choice | Controller | Pre-condition | Post-condition |
|---|---|---|---|
| `Approve` | operator | status == "pending" | status = "verified" |
| `Confirm` | debtor | status == "verified" | status = "confirmed" |
| `Dispute` | debtor | status == "verified" or "confirmed" | status = "disputed" |
| `ResolveDispute` | operator | status == "disputed" | status = "pending" (upheld) or "confirmed" (rejected) |
| `CreateAuction` | seller | status == "confirmed" | Creates `AuctionInvite` |

#### `Invoice.AuctionInvite`
```
Signatories: operator, seller
Observers: lenderObservers[] (dynamic)
```

Contains anonymized `InvoiceMetadata` (amount bucket, sector, payment terms, reliability score — no debtor name or exact amount). Lenders are added as observers so they can discover the auction.

**Choices:**
| Choice | Controller | Effect |
|---|---|---|
| `AddLenderObserver` | operator | Adds lender to observer list |
| `CloseAuction` | seller | Sets status = "closed" |

#### `Auction.SealedBid`
```
Signatories: operator, lender
Observers: NONE
```

The core privacy mechanism. Zero observers means no one else can see this contract on the ledger.

**Ensure clause:** `(revealed && rate > 0 && rate < 1) || (!revealed && rate == 0 && commitHash != "")`

This enforces that unrevealed bids cannot leak the discount rate.

**Choices:**
| Choice | Controller | Pre-condition | Effect |
|---|---|---|---|
| `Reveal` | lender | !revealed, rate in (0,1), nonce != "" | Sets discountRate = actualRate, revealed = True |

#### `Auction.AuctionResult`
```
Signatories: operator, seller
Observer: winningLender ONLY
```

Only the winning lender sees the result details. Losing lenders receive a separate `BidRejection`.

**Choices:**
| Choice | Controller | Effect |
|---|---|---|
| `Settle` | winningLender | Creates `SettledInvoice` with financedAmount = amount * (1 - rate) |

#### `Auction.BidRejection`
```
Signatory: operator
Observer: losing lender
```

The losing lender learns only that they lost — not who won, at what rate, or any settlement details.

#### `Auction.SettledInvoice`
```
Signatories: operator, seller
Observer: winning lender
```

The final settled state representing the completed financing transaction.

**Choices:**
| Choice | Controller | Effect |
|---|---|---|
| `MarkCollected` | lender | Sets status = "collected" |

#### `Invoice.PaymentNotification`
```
Signatory: operator
Observers: debtor, winningLender
```

Notifies the debtor to redirect payment to the winning lender.

### Data Types

**InvoiceData** (full, visible to seller/operator):
```
invoiceId, seller, debtorName, amount, currency, sector,
paymentTermDays, issueDate, dueDate, reliabilityScore
```

**InvoiceMetadata** (anonymized, visible to lenders):
```
invoiceId, amountBucket, currency, sector, paymentTermDays, reliabilityScore
```

Amount buckets: "Under 10K", "10K-50K", "50K-100K", "100K-500K", "500K+"

---

## 5. Backend API Reference

### Authentication Endpoints

#### `POST /api/auth/login`
Rate limited: 20 requests per 15 minutes.

**Request:**
```json
{ "party": "SellerCo", "password": "your-password" }
```
**Response:**
```json
{ "token": "eyJ...", "party": "SellerCo", "role": "seller", "expiresIn": "24h" }
```

#### `POST /api/parties/register`
**Request:**
```json
{ "displayName": "SellerCo", "role": "seller", "password": "min-8-chars" }
```
**Roles:** `seller`, `lender`, `debtor`, `operator`

**Validation:**
- displayName: 1-50 chars, alphanumeric + hyphens/underscores
- password: 8-128 chars
- role: must be one of seller, lender, debtor, operator

### Party Endpoints

#### `GET /api/parties`
Returns all registered parties (display name, role, partyId, registeredAt).

### Invoice Endpoints

#### `POST /api/invoices`
**Requires role:** seller or operator

**Request:**
```json
{
  "invoiceId": "INV-001",
  "seller": "SellerCo",
  "debtor": "DebtorInc",
  "amount": 75000,
  "currency": "USD",
  "sector": "Manufacturing",
  "paymentTermDays": 30,
  "reliabilityScore": "A"
}
```

**Validation:**
- invoiceId: 1-50 chars, alphanumeric + hyphens/underscores
- amount: positive, max 100,000,000
- currency: exactly 3 chars
- paymentTermDays: 1-365
- reliabilityScore: A, B, or C

#### `GET /api/invoices`
Query params: `?seller=SellerCo` (optional filter)

#### `POST /api/invoices/:invoiceId/approve`
**Requires role:** operator

Transitions invoice from "pending" to "verified".

#### `POST /api/invoices/:invoiceId/confirm`
**Requires role:** debtor or operator

Transitions invoice from "verified" to "confirmed". Validates caller is the debtor on this invoice.

#### `POST /api/invoices/:invoiceId/dispute`
**Requires role:** debtor or operator

**Request:**
```json
{ "reason": "Amount does not match our records" }
```

#### `POST /api/invoices/:invoiceId/resolve-dispute`
**Requires role:** operator

**Request:**
```json
{ "resolution": "upheld" }
```
Resolution values: `upheld` (back to pending) or `rejected` (back to confirmed)

### Auction Endpoints

#### `POST /api/auctions`
**Requires role:** seller or operator

**Request:**
```json
{ "invoiceId": "INV-001" }
```
Invoice must be in "confirmed" status.

#### `GET /api/auctions`
Returns all auctions with bid counts. No bid details exposed.

#### `GET /api/auctions/:invoiceId`
Query params: `?party=LenderAlpha&role=lender`

Response varies by role:
- **Lender:** sees metadata, their own bid, total bid count, win status
- **Seller:** sees metadata, bid count, winning lender/rate after close, all bids after close
- **No role:** sees metadata, bid count only

#### `POST /api/auctions/:invoiceId/close`
**Requires role:** seller or operator

Validates seller ownership. Requires minimum 2 bids. Selects lowest discount rate as winner.

### Bid Endpoints

#### `POST /api/bids`
**Requires role:** lender or operator

**Request:**
```json
{
  "lender": "LenderAlpha",
  "invoiceId": "INV-001",
  "discountRate": 0.035
}
```

**Validation:**
- discountRate: must be > 0 and < 1, max 4 decimal places
- Debtor cannot bid on their own invoice
- Duplicate bids from same lender rejected

**Response:**
```json
{
  "status": "bid_accepted",
  "invoiceId": "INV-001",
  "commitHash": "a1b2c3..."
}
```

### Settlement Endpoints

#### `POST /api/settlements`
**Requires role:** lender or operator

**Request:**
```json
{ "invoiceId": "INV-001", "lender": "LenderAlpha" }
```
Only the winning lender can settle. Creates payment notification for the debtor.

#### `GET /api/settlements/:invoiceId`
Returns settlement details. Access restricted to seller and winning lender.

#### `GET /api/settlements`
Returns all settlements visible to the caller.

### Portfolio Auction Endpoints

#### `POST /api/portfolio-auctions`
**Request:**
```json
{ "invoiceIds": ["INV-001", "INV-002", "INV-003"], "seller": "SellerCo" }
```
Requires 2-50 confirmed invoices from the same seller, not already in individual auctions.

#### `GET /api/portfolio-auctions`
#### `GET /api/portfolio-auctions/:portfolioId`
#### `POST /api/portfolio-auctions/:portfolioId/bid`
#### `POST /api/portfolio-auctions/:portfolioId/close`
#### `POST /api/portfolio-auctions/:portfolioId/settle`

Same patterns as individual auctions but operate on bundled invoices.

### Agent Endpoints

#### `POST /api/agents`
**Request:**
```json
{
  "name": "AlphaBot",
  "party": "LenderAlpha",
  "strategy": "value",
  "riskTolerance": "moderate",
  "maxDiscountRate": 0.10,
  "minDiscountRate": 0.005,
  "autoBid": false,
  "enabled": true
}
```
Strategies: `value`, `volume`, `selective`, `adaptive`

#### `POST /api/agents/:name/analyze`
Analyzes one or all auctions using the agent's strategy + optional LLM.

#### `POST /api/agents/:name/auto-bid`
Executes an autonomous bid if the agent's analysis recommends it.

#### `GET /api/agents/:name/performance`
Returns win rate, bid count, average rates, Sharpe ratio.

#### `GET /api/agents/:name/portfolio-state`
Returns sector concentration, HHI, total exposure.

### Audit & Privacy Endpoints

#### `GET /api/audit-log`
Returns the full hash-chained audit log with integrity verification.

#### `GET /api/audit-log/verify`
Verifies the audit chain integrity (recomputes all hashes).

#### `GET /api/privacy-scope/:party`
Returns what data is visible to a specific party, based on their role.

#### `POST /api/privacy-breach-test`
**Request:**
```json
{ "attackerParty": "LenderBeta", "targetParty": "LenderAlpha", "targetData": "bids" }
```
Simulates privacy breach attempts and reports blocking results.

### System Endpoints

#### `GET /api/health`
```json
{ "status": "ok", "mode": "canton-ledger", "authRequired": true, "uptime": 3600 }
```

#### `GET /api/health/ready`
Deep health check that verifies Canton ledger connectivity.

#### `POST /api/reset`
**Development only.** Clears all persisted data. Blocked in production.

---

## 6. Authentication & Authorization

### Authentication Flow

1. Party registers via `POST /api/parties/register` (password bcrypt-hashed with cost 10)
2. Party logs in via `POST /api/auth/login` (rate-limited to 20 attempts per 15 min)
3. Server returns a signed JWT (HMAC-SHA256) with 24-hour expiry
4. Client includes `Authorization: Bearer <token>` on all subsequent requests
5. Auth middleware extracts `authenticatedParty` and `authenticatedRole` from JWT
6. Role guards (`requireRole`) enforce that the caller has the correct role for each endpoint

### JWT Structure

```json
{
  "sub": "SellerCo",
  "role": "seller",
  "iat": 1720000000,
  "exp": 1720086400
}
```

Signed with `APP_SECRET` using HMAC-SHA256.

### Role Enforcement

| Endpoint | Required Role |
|---|---|
| `POST /api/invoices` | seller, operator |
| `POST /api/invoices/:id/approve` | operator |
| `POST /api/invoices/:id/confirm` | debtor, operator |
| `POST /api/invoices/:id/dispute` | debtor, operator |
| `POST /api/invoices/:id/resolve-dispute` | operator |
| `POST /api/auctions` | seller, operator |
| `POST /api/auctions/:id/close` | seller, operator |
| `POST /api/bids` | lender, operator |
| `POST /api/settlements` | lender, operator |

When `REQUIRE_AUTH=false` (development), role guards are bypassed.

---

## 7. Cryptographic Systems

### Bid Commitment Scheme (Commit-Reveal)

**Commit phase:**
1. Lender chooses discount rate (e.g., 0.035) and a random nonce
2. Backend generates nonce: `crypto.randomBytes(16).toString("hex")` (128-bit)
3. Commitment: `SHA-256(discountRate.toFixed(10) + ":" + nonce)`
4. `SealedBid` contract created with `discountRate = 0` and `commitHash = <hash>`

**Reveal phase:**
1. After auction closes, lender exercises `Reveal` with actual rate + nonce
2. Backend verifies: `SHA-256(actualRate.toFixed(10) + ":" + nonce) === commitHash`
3. Daml contract enforces: `actualRate > 0 && actualRate < 1 && nonce != ""`

### Hash-Chained Audit Log

Each audit entry contains:
```json
{
  "sequenceNumber": 0,
  "timestamp": "2026-07-06T12:00:00.000Z",
  "action": "CREATE_INVOICE",
  "party": "SellerCo",
  "data": { "invoiceId": "INV-001", "amount": 75000 },
  "prevHash": "0000...0000",
  "hash": "a1b2c3..."
}
```

The `hash` is computed as: `SHA-256(JSON.stringify({sequenceNumber, timestamp, action, party, data, prevHash}))`

Each entry's `prevHash` must equal the previous entry's `hash`, creating a tamper-evident chain. Verification recomputes all hashes from genesis.

### Document Hashing

Invoice documents are hashed using SHA-256 over deterministic serialization:
- Fields sorted alphabetically
- `JSON.stringify(fields, Object.keys(fields).sort())`
- Ensures consistent hashes regardless of property insertion order

---

## 8. Risk Scoring Engine

### 6-Factor Model

| Factor | Weight | Range | Description |
|---|---|---|---|
| Sector Stability | 0.20 | 0-100 | Historical stability by industry |
| Payment Term Risk | 0.15 | 0-100 | Shorter terms = lower risk |
| Amount Concentration | 0.15 | 0-100 | Mid-range amounts score highest |
| Debtor Track Record | 0.30 | 0-100 | Payment history + reliability rating |
| Currency Stability | 0.10 | 0-100 | Major reserve currencies score higher |
| Temporal Proximity | 0.10 | 0-100 | Closer due dates = lower risk |

### Sector Volatility Scores

| Sector | Score |
|---|---|
| Healthcare | 80 |
| Manufacturing | 75 |
| Finance | 70 |
| Logistics | 65 |
| Energy | 60 |
| Technology | 50 |
| Retail | 45 |
| Construction | 35 |

### Grade Thresholds

| Score Range | Grade |
|---|---|
| 85-100 | AAA |
| 75-84 | AA |
| 65-74 | A |
| 55-64 | BBB |
| 45-54 | BB |
| 35-44 | B |
| 0-34 | CCC |

### Debtor History

The score factors in:
- Total invoices from this debtor
- Number settled on time
- Number of disputes
- Reliability rating (A = +20, B = +10, C = +0)

---

## 9. AI Agent System

### Agent Configuration

```json
{
  "name": "AlphaBot",
  "party": "LenderAlpha",
  "strategy": "value",
  "riskTolerance": "moderate",
  "maxDiscountRate": 0.10,
  "minDiscountRate": 0.005,
  "autoBid": false,
  "enabled": true
}
```

### Strategies

| Strategy | Behavior |
|---|---|
| **value** | Targets high-risk invoices with wider spreads |
| **volume** | Bids aggressively on many auctions at tight spreads |
| **selective** | Only bids on low-risk, high-quality invoices |
| **adaptive** | Uses historical outcome data to calibrate rates dynamically |

### Analysis Pipeline

1. Agent receives auction metadata (anonymized — no debtor, no exact amount)
2. Risk factors evaluated: sector, payment terms, reliability score, amount bucket, competition
3. Suggested discount rate computed based on strategy + risk tolerance
4. Optional LLM analysis (Claude API with 5-second timeout) for reasoning explanation
5. Recommendation: `bid`, `skip`, or `watch`

### Performance Tracking

- **Win rate:** wins / total bids
- **Average bid rate:** across all bids
- **Average winning rate:** only for won auctions
- **Sharpe ratio:** risk-adjusted returns
- **Portfolio HHI:** Herfindahl-Hirschman Index for sector concentration
- **Concentration limits:** 40% max per sector

### Adaptive Learning

When `strategy = "adaptive"`:
1. Historical outcomes stored per (sector, reliability, amountBucket) tuple
2. Win probability modeled: proportion of past bids at similar rates that won
3. Rate adjusted: higher win probability at current rate → lower the rate (more competitive)
4. Minimum 5 historical data points required; otherwise falls back to base strategy

---

## 10. Portfolio Auctions & Cross-Currency Netting

### Portfolio Creation

Bundle 2-50 confirmed invoices from the same seller into a single auction. Benefits:
- Diversification reduces per-invoice risk
- Single bid covers the entire portfolio
- Cross-currency netting reduces FX exposure

### Metadata

```json
{
  "invoiceCount": 5,
  "totalAmountBucket": "100K-500K",
  "sectors": ["Manufacturing", "Technology"],
  "currencies": ["USD", "EUR"],
  "avgPaymentTermDays": 45,
  "avgRiskGrade": "A",
  "netting": { ... }
}
```

### Cross-Currency Netting

When a portfolio contains invoices in multiple currencies:

1. Each currency amount converted to USD using mid-market rates
2. Gross exposure = sum of all USD equivalents
3. Netting benefit = gross × diversification factor × 15%
4. Diversification factor = 1 - (1 / sqrt(numCurrencies))
5. Net exposure = gross - netting benefit

**Supported currencies:** USD, EUR, GBP, CHF, JPY, CAD, AUD, SGD, HKD, CNY

---

## 10b. Demo Mode (Single-Account Operation)

### Overview

For presentations and hackathon demos, ClearFlow supports single-account operation where one user can demonstrate all roles without signing in/out.

### Setup

1. Register as **Operator** (first option in the dropdown)
2. The operator role has permissions for all backend endpoints (`requireRole` allows operator on every action)
3. Use the role switcher bar or keyboard shortcuts to flip between views instantly

### Keyboard Shortcuts

| Key | View |
|---|---|
| `1` | Seller |
| `2` | Lender |
| `3` | Operator |
| `4` | Debtor |

Shortcuts are disabled when typing in input fields.

### Single-Account Workflow

1. Press `1` → Create an invoice (set yourself as debtor)
2. Press `3` → Approve the invoice as operator
3. Press `4` → Confirm the invoice as debtor
4. Press `1` → Start a sealed auction
5. Press `2` → Submit a sealed bid as lender
6. Press `1` → Close the auction
7. Press `2` → Settle as winning lender
8. Press `3` → Run breach test to prove privacy guarantees

### Design Decisions

- The debtor-cannot-bid validation is relaxed in demo mode to allow single-account flow
- The role switcher shows all 4 roles regardless of the authenticated user's primary role
- Each role button displays its keyboard shortcut as a visual badge
- View switching is instant (no re-authentication, no API calls)

---

## 11. Frontend Architecture

### Component Structure

| Component | Role | Key Features |
|---|---|---|
| `App.tsx` | Root | Login/register forms, role-based view routing |
| `SellerView.tsx` | Seller dashboard | Create invoices, start auctions, view winners |
| `LenderView.tsx` | Lender dashboard | Browse auctions, submit sealed bids, settlement |
| `OperatorView.tsx` | Admin dashboard | Verify invoices, resolve disputes, breach testing |
| `DebtorView.tsx` | Debtor dashboard | Confirm obligations, view payment notifications |
| `PrivacyAuditView.tsx` | Privacy audit | Visibility matrix showing who sees what |
| `LivePrivacyPanel.tsx` | Real-time privacy | Live privacy scope visualization |
| `PrivacyBreachDemo.tsx` | Security demo | Interactive breach attempt simulation |
| `AgentPanel.tsx` | Agent management | Create/configure AI bidding agents |
| `PricingAssistant.tsx` | Bid helper | Automated discount rate recommendations |
| `TransactionLog.tsx` | Audit trail | Hash-chained audit log viewer |
| `SettlementFlowDiagram.tsx` | Visual flow | Settlement process visualization |
| `ConfirmDialog.tsx` | UI utility | Confirmation modal |
| `ErrorBoundary.tsx` | Error handling | React error boundary |
| `LoadingSpinner.tsx` | UI utility | Loading indicator |
| `Toast.tsx` | UI utility | Toast notifications |

### API Client (`hooks/useApi.ts`)

Centralized API client with:
- JWT token management (in-memory, not localStorage)
- Automatic `Authorization: Bearer` header injection
- Error extraction from JSON responses
- All API methods typed

### State Management

- React component state (useState/useEffect)
- Auth token stored in module-level variable (not persisted to browser storage)
- Polling for data updates (no WebSocket)

---

## 12. Dual-Mode Operation

### Mode Detection

On startup, the backend probes the Canton ledger:

```
Canton available? ──→ Yes ──→ Canton Ledger Mode (protocol-level privacy)
                  └──→ No  ──→ Standalone Ledger Mode (application-level privacy)
```

### Canton Ledger Mode

- Connects to Canton JSON API (v1 or v2)
- Supports Seaport Devnet (OAuth2/OIDC token refresh)
- Supports local multi-participant topology
- Privacy enforced at protocol level by Canton sequencer
- Backend also maintains local cache for performance

### Standalone Ledger Mode

- In-memory ledger with file-based persistence
- Mirrors all Daml contract logic in TypeScript
- Same API surface and privacy guarantees
- Privacy enforced via application-layer filtering
- No external dependencies required

### Seaport Devnet Mode

- Uses OIDC client credentials flow for token management
- Tokens auto-refresh every 8 hours (with 1-minute buffer)
- All parties map to a single participant (devnet limitation)
- Supports both Ledger API v1 and v2

---

## 13. Data Persistence

### File Storage

All persistent data stored as JSON files in `backend/data/`:

| File | Contents |
|---|---|
| `invoices.json` | Invoice cache (Canton) / invoice store (standalone) |
| `parties.json` | Party registry with Canton party IDs |
| `password-hashes.json` | Bcrypt password hashes (NEVER plaintext) |
| `ledger-invoices.json` | Standalone ledger invoice state |
| `ledger-auctions.json` | Standalone ledger auction state |
| `ledger-settlements.json` | Standalone ledger settlement state |
| `ledger-notifications.json` | Payment notification state |
| `ledger-portfolios.json` | Portfolio auction state |
| `ledger-parties.json` | Standalone party registry |
| `agent-actions.json` | Agent bid decision history |
| `agent-outcomes.json` | Agent performance tracking data |

### Atomic Writes

All file writes use the atomic pattern:
1. Serialize to JSON with 2-space indentation
2. Write to temporary file with `mode: 0o600` (owner-only read/write)
3. `fs.renameSync()` temp file to target (atomic on POSIX)

Write locks prevent concurrent writes to the same file.

---

## 14. Testing

### Backend Test Suite (154 tests)

Run all tests:
```bash
cd backend && npm test
```

| Test File | Coverage |
|---|---|
| `ledger.test.ts` | Invoice lifecycle, auction flow, settlements, privacy filtering |
| `crypto.test.ts` | SHA-256 hashing, bid commitments, nonce generation, audit chain |
| `validation.test.ts` | Zod schema validation for all input types |
| `risk.test.ts` | Risk scoring algorithm, grade thresholds, factor weights |
| `disputes.test.ts` | Dispute creation, resolution, state transitions |
| `portfolio.test.ts` | Portfolio creation, bundled bidding, cross-currency netting |
| `agent.test.ts` | Agent registration, strategy analysis, autonomous bidding |
| `agent-learning.test.ts` | Outcome recording, win rate, Sharpe ratio, HHI, adaptive rates |

### Daml Contract Tests

```bash
daml test
```

Tests cover:
- Full invoice lifecycle with end-to-end commit-reveal
- Bid privacy verification (Lender A cannot see Lender B's bid)
- Dispute resolution flows
- Atomic settlement
- State transition guards (ensure clauses)

---

## 15. VPS Deployment Guide

### Prerequisites

- Ubuntu 22.04+ or Debian 12+ VPS
- At least 1 GB RAM, 10 GB storage
- A domain name pointing to the VPS IP
- Root or sudo access

### Automated Setup

```bash
# 1. Clone the repo to your local machine
git clone <your-repo-url> clearflow
cd clearflow

# 2. Copy to VPS
rsync -avz --exclude node_modules --exclude .git --exclude .daml \
  . root@your-vps:/opt/clearflow/

# 3. SSH into VPS and run setup
ssh root@your-vps
cd /opt/clearflow
chmod +x deploy/setup-vps.sh deploy/deploy.sh
./deploy/setup-vps.sh your-domain.com
```

The setup script installs:
- Node.js 20
- Nginx (reverse proxy with SSL termination)
- Let's Encrypt SSL certificate (auto-renewing)
- UFW firewall (SSH + HTTPS only, port 3002 blocked externally)
- systemd service with security hardening

### Configure Secrets

```bash
cp deploy/.env.production.example /opt/clearflow/.env.production
nano /opt/clearflow/.env.production
```

Generate strong secrets:
```bash
# Generate random secrets
openssl rand -hex 32  # For APP_SECRET
openssl rand -hex 32  # For JWT_SECRET
openssl rand -base64 24  # For OPERATOR_PASSWORD
```

### Build & Deploy

```bash
cd /opt/clearflow
./deploy/deploy.sh
```

### Verify

```bash
# Check service status
systemctl status clearflow

# Watch logs
journalctl -u clearflow -f

# Health check
curl https://your-domain.com/api/health
```

### Updating

```bash
# On your local machine
rsync -avz --exclude node_modules --exclude .git --exclude .daml \
  --exclude backend/data --exclude .env.production \
  . root@your-vps:/opt/clearflow/

# On the VPS
cd /opt/clearflow && ./deploy/deploy.sh
```

### systemd Service Management

```bash
systemctl start clearflow      # Start
systemctl stop clearflow       # Stop
systemctl restart clearflow    # Restart
systemctl status clearflow     # Status
journalctl -u clearflow -f     # Live logs
journalctl -u clearflow --since "1 hour ago"  # Recent logs
```

### Nginx Configuration

The nginx config at `/etc/nginx/sites-available/clearflow`:
- Reverse proxies `/api/` to the Node.js backend on port 3002
- Serves frontend static files from `/opt/clearflow/frontend/build`
- Handles SSL termination with Let's Encrypt
- Adds security headers (HSTS, X-Frame-Options, X-Content-Type-Options)
- Caches static assets for 30 days
- Blocks access to dotfiles

---

## 16. Docker Deployment

### Build & Run

```bash
docker-compose up --build
```

### Docker Compose Configuration

The `docker-compose.yml` starts a single service with:
- Multi-stage Alpine Linux build (frontend build → backend build → production image)
- Non-root user (`clearflow`)
- Persistent volume for data directory
- Health check every 15 seconds
- Auto-restart on failure

### Environment Variables

Pass production secrets via environment:
```bash
APP_SECRET=your-secret JWT_SECRET=your-jwt-secret OPERATOR_PASSWORD=your-password \
  docker-compose up --build
```

### Dockerfile Details

| Stage | Base | Purpose |
|---|---|---|
| frontend-build | node:20-alpine3.19 | `npm ci && npm run build` |
| backend-build | node:20-alpine3.19 | `npm ci && npx tsc` |
| production | node:20-alpine3.19 | Copies dist + node_modules + frontend build |

---

## 17. Configuration Reference

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | 3002 | Server port |
| `NODE_ENV` | Yes (prod) | development | Set to "production" for prod |
| `APP_SECRET` | Yes (prod) | dev default | HMAC key for app JWT tokens |
| `JWT_SECRET` | Yes (prod) | dev default | HMAC key for Canton ledger tokens |
| `OPERATOR_PASSWORD` | Yes (prod) | operator-secret | Default operator account password |
| `REQUIRE_AUTH` | No | false | Enforce JWT auth on all endpoints |
| `ALLOWED_ORIGINS` | No | localhost | Comma-separated CORS origins |
| `SEAPORT_DEVNET` | No | false | Enable Seaport devnet mode |
| `LEDGER_API_URL` | No | localhost:7575 | Canton JSON API URL |
| `SEAPORT_PARTY_ID` | Devnet | — | Seaport participant party ID |
| `SEAPORT_OIDC_ISSUER` | Devnet | — | OIDC token endpoint |
| `SEAPORT_OIDC_CLIENT_ID` | Devnet | — | OIDC client ID |
| `SEAPORT_OIDC_CLIENT_SECRET` | Devnet | — | OIDC client secret |
| `CANTON_PARTICIPANT_URLS` | No | — | Per-participant routing (e.g., "operator=http://...:7571,p1=...") |
| `CANTON_LEDGER_ID` | No | sandbox | Canton ledger identifier |

### Production Checklist

- [ ] `NODE_ENV=production`
- [ ] `APP_SECRET` changed from default (server refuses to start otherwise)
- [ ] `JWT_SECRET` changed from default
- [ ] `OPERATOR_PASSWORD` changed from default
- [ ] `REQUIRE_AUTH=true`
- [ ] `ALLOWED_ORIGINS` set to your domain
- [ ] HTTPS enabled (via nginx/reverse proxy)
- [ ] `.env` file not committed to git
- [ ] Firewall blocks direct access to port 3002

---

## 18. Security Considerations

### Implemented Protections

| Protection | Implementation |
|---|---|
| **HTTPS** | Nginx with Let's Encrypt (VPS) or platform-provided (Docker) |
| **Security Headers** | Helmet (CSP, X-Frame-Options, X-Content-Type-Options, HSTS) |
| **Rate Limiting** | 500 req/15min (API), 20 req/15min (auth) |
| **Request Size** | 10KB body limit |
| **Password Storage** | bcrypt with cost factor 10 |
| **JWT Tokens** | HMAC-SHA256, 24h expiry |
| **Input Validation** | Zod schemas on all POST bodies, regex validation on URL params |
| **CORS** | Configurable allowed origins, credentials mode |
| **Role-Based Access** | `requireRole()` middleware on all mutating endpoints |
| **Non-Root Container** | Docker runs as `clearflow` user |
| **Atomic File Writes** | Write-then-rename prevents corruption |
| **Production Config Check** | Server refuses to start with default secrets |
| **Error Sanitization** | Production errors return generic messages, no stack traces |
| **Systemd Hardening** | NoNewPrivileges, ProtectSystem, ProtectHome, PrivateTmp |

### Known Limitations

- File-based persistence is not suitable for multi-instance horizontal scaling
- Bid reveal happens immediately (same API call as commit) rather than after auction close
- In standalone mode, privacy is application-level — an attacker with database access could see all data
- No CSRF protection (stateless JWT, no cookies — CSRF not applicable)
- Audit chain is in-memory and not persisted across restarts (Canton mode)

---

## 19. Troubleshooting

### Common Issues

**Server won't start in production:**
```
FATAL: Missing required env vars in production: APP_SECRET, JWT_SECRET
```
Set the required environment variables. The server refuses to start with default values in production.

**Canton ledger not connecting:**
```
Failed to connect to Daml ledger
```
- Check `LEDGER_API_URL` is correct
- Verify Canton is running: `curl http://localhost:7575/readyz`
- The app will fall back to standalone mode automatically

**CORS errors in browser:**
```
Access to fetch blocked by CORS policy
```
Set `ALLOWED_ORIGINS` to include your frontend URL.

**Rate limit hit:**
```
{ "error": "Too many requests, please try again later" }
```
Wait 15 minutes or increase `max` in the rate limiter config.

**Port already in use:**
```
Error: listen EADDRINUSE: address already in use :::3002
```
Kill the existing process: `lsof -ti:3002 | xargs kill`

### Logs

**VPS:**
```bash
journalctl -u clearflow -f          # Live logs
journalctl -u clearflow --since "1 hour ago"  # Recent
```

**Docker:**
```bash
docker-compose logs -f app
```

**Development:**
Console output with `[timestamp] METHOD /path` format.

---

## File Structure

```
clearflow/
├── daml/                            # Smart contracts
│   ├── Invoice.daml                 # Invoice lifecycle + auction creation
│   ├── Auction.daml                 # Sealed bids + settlement
│   └── Test.daml                    # Privacy + commit-reveal tests
├── backend/
│   ├── src/
│   │   ├── server.ts                # Express API (40+ endpoints)
│   │   ├── daml-client.ts           # Canton JSON API integration
│   │   ├── ledger.ts                # Standalone ledger
│   │   ├── auth.ts                  # JWT auth + bcrypt + role guards
│   │   ├── crypto.ts                # SHA-256 commitments + audit chain
│   │   ├── agent.ts                 # AI agent system
│   │   ├── agent-llm.ts             # LLM-based analysis
│   │   ├── agent-learning.ts        # Performance tracking + adaptive learning
│   │   ├── persistence.ts           # Atomic file persistence
│   │   ├── validation.ts            # Zod schemas
│   │   └── __tests__/               # 154 tests (9 files)
│   ├── data/                        # Persisted JSON state
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx                  # Main app + routing
│   │   ├── components/              # 15 React components
│   │   ├── hooks/useApi.ts          # API client
│   │   └── types/index.ts           # TypeScript interfaces
│   └── package.json
├── canton/                          # Canton network config
│   ├── topology.conf                # 4-participant topology
│   ├── bootstrap.canton             # Party allocation
│   └── start.sh                     # Boot script
├── deploy/                          # VPS deployment
│   ├── setup-vps.sh                 # Automated VPS setup
│   ├── deploy.sh                    # Build + deploy script
│   ├── nginx.conf                   # Nginx reverse proxy config
│   ├── clearflow.service            # systemd unit file
│   └── .env.production.example      # Production env template
├── scripts/
│   ├── seed-demo.sh                 # Demo data seeding
│   └── deploy-dar.sh                # Daml archive deployment
├── docker-compose.yml               # Docker deployment
├── Dockerfile                       # Multi-stage build
├── .dockerignore                    # Docker build exclusions
├── .gitignore
├── daml.yaml                        # Daml SDK config
├── render.yaml                      # Render.com config (alternative)
├── README.md                        # Overview + quick start
├── documentation.md                 # This file — full reference
└── LICENSE                          # MIT
```
