import {
  hashInvoiceDocument,
  computeBidCommitment,
  generateNonce,
  verifyBidCommitment,
  AuditChain,
} from "./crypto";
import fs from "fs";
import path from "path";

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const LEDGER_API_URL = process.env.LEDGER_API_URL || (IS_PRODUCTION ? "" : "http://localhost:7575");

export interface InvoiceData {
  invoiceId: string;
  seller: string;
  debtor: string;
  amount: number;
  currency: string;
  sector: string;
  paymentTermDays: number;
  issueDate: string;
  dueDate: string;
  reliabilityScore: string;
  status?: "pending" | "verified" | "confirmed" | "disputed";
  documentHash?: string;
  riskScore?: RiskScore;
  disputeReason?: string;
  disputedAt?: string;
  disputeResolution?: string;
  resolvedAt?: string;
}

export interface RiskScore {
  overall: number;       // 0-100 composite score
  grade: string;         // AAA, AA, A, BBB, BB, B, CCC
  factors: RiskFactor[];
  computedAt: string;
}

export interface RiskFactor {
  name: string;
  weight: number;        // 0-1 weight
  rawScore: number;      // 0-100 raw factor score
  weightedScore: number; // rawScore * weight
  explanation: string;
}

export interface InvoiceMetadata {
  invoiceId: string;
  amountBucket: string;
  currency: string;
  sector: string;
  paymentTermDays: number;
  reliabilityScore: string;
}

export interface SealedBid {
  lender: string;
  invoiceId: string;
  discountRate: number;    // 0 until revealed
  commitHash?: string;
  nonce?: string;
  verified?: boolean;
  revealed?: boolean;      // true after lender reveals rate + nonce
}

export interface AuctionState {
  invoiceId: string;
  metadata: InvoiceMetadata;
  status: "open" | "closed" | "settled";
  bids: SealedBid[];
  winningLender?: string;
  winningRate?: number;
}

export interface Settlement {
  invoiceId: string;
  seller: string;
  lender: string;
  originalAmount: number;
  financedAmount: number;
  discountRate: number;
  status: string;
  debtor?: string;
}

export interface PaymentNotification {
  invoiceId: string;
  debtor: string;
  seller: string;
  winningLender: string;
  amount: number;
  dueDate: string;
  createdAt: string;
}

export interface CurrencyExposure {
  currency: string;
  amount: number;
  usdEquivalent: number;
  invoiceCount: number;
}

export interface NettingResult {
  grossExposure: number;         // Sum of all USD equivalents
  netExposure: number;           // After netting offsetting positions
  nettingBenefit: number;        // Reduction from netting
  nettingRatio: number;          // netExposure / grossExposure
  currencyBreakdown: CurrencyExposure[];
  baseCurrency: string;
}

export interface PortfolioAuction {
  portfolioId: string;
  invoiceIds: string[];
  seller: string;
  totalAmount: number;
  weightedRiskScore: number;
  status: "open" | "closed" | "settled";
  bids: SealedBid[];
  winningLender?: string;
  winningRate?: number;
  metadata: {
    invoiceCount: number;
    totalAmountBucket: string;
    sectors: string[];
    currencies: string[];
    avgPaymentTermDays: number;
    avgRiskGrade: string;
    netting?: NettingResult;
  };
}

// Cross-currency exchange rates (mid-market, relative to USD)
// These are fallback rates used when live rates are unavailable.
const FALLBACK_FX_RATES: Record<string, number> = {
  USD: 1.0,
  EUR: 1.08,
  GBP: 1.27,
  CHF: 1.12,
  JPY: 0.0064,
  CAD: 0.74,
  AUD: 0.66,
  SGD: 0.75,
  HKD: 0.128,
  CNY: 0.138,
};

let liveFxRates: Record<string, number> | null = null;
let fxLastFetched = 0;
const FX_CACHE_TTL = 3600_000; // 1 hour

async function fetchLiveFxRates(): Promise<void> {
  if (Date.now() - fxLastFetched < FX_CACHE_TTL && liveFxRates) return;
  try {
    // Open Exchange Rates free tier (no key needed for latest.json via frankfurter)
    const resp = await fetch("https://api.frankfurter.app/latest?from=USD");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as { rates: Record<string, number> };
    // Frankfurter returns rates as "1 USD = X foreign", we need "1 foreign = X USD"
    const rates: Record<string, number> = { USD: 1.0 };
    for (const [cur, rate] of Object.entries(data.rates)) {
      rates[cur] = 1 / rate; // invert: how many USD per 1 unit of foreign currency
    }
    liveFxRates = rates;
    fxLastFetched = Date.now();
    console.log(`[FX] Updated live rates for ${Object.keys(rates).length} currencies`);
  } catch (e: any) {
    console.warn(`[FX] Failed to fetch live rates, using fallback: ${e.message}`);
  }
}

// Call on startup (non-blocking)
fetchLiveFxRates();

function getFxRate(currency: string): number {
  if (liveFxRates && currency in liveFxRates) return liveFxRates[currency];
  return FALLBACK_FX_RATES[currency] || 1.0;
}

function toUSD(amount: number, currency: string): number {
  return amount * getFxRate(currency);
}

function computeNetting(invoices: InvoiceData[]): NettingResult {
  const byCurrency = new Map<string, { amount: number; count: number }>();

  for (const inv of invoices) {
    const cur = inv.currency || "USD";
    const existing = byCurrency.get(cur) || { amount: 0, count: 0 };
    existing.amount += inv.amount;
    existing.count += 1;
    byCurrency.set(cur, existing);
  }

  const breakdown: CurrencyExposure[] = [];
  let grossExposure = 0;

  for (const [currency, data] of byCurrency) {
    const usdEquiv = toUSD(data.amount, currency);
    grossExposure += usdEquiv;
    breakdown.push({
      currency,
      amount: data.amount,
      usdEquivalent: Math.round(usdEquiv * 100) / 100,
      invoiceCount: data.count,
    });
  }

  // Netting: if invoices are in multiple currencies, the net exposure
  // is reduced because currency fluctuations partially offset.
  // Simplified model: netting benefit = 1 - (1 / sqrt(numCurrencies))
  // This reflects diversification benefit from multiple currencies.
  const numCurrencies = byCurrency.size;
  const diversificationFactor = numCurrencies > 1 ? 1 - (1 / Math.sqrt(numCurrencies)) : 0;
  const nettingBenefit = grossExposure * diversificationFactor * 0.15; // 15% max benefit from diversification
  const netExposure = grossExposure - nettingBenefit;

  return {
    grossExposure: Math.round(grossExposure * 100) / 100,
    netExposure: Math.round(netExposure * 100) / 100,
    nettingBenefit: Math.round(nettingBenefit * 100) / 100,
    nettingRatio: grossExposure > 0 ? Math.round((netExposure / grossExposure) * 10000) / 10000 : 1,
    currencyBreakdown: breakdown.sort((a, b) => b.usdEquivalent - a.usdEquivalent),
    baseCurrency: "USD",
  };
}

const SECTOR_VOLATILITY: Record<string, number> = {
  Manufacturing: 75,
  Healthcare: 80,
  Technology: 50,
  Retail: 45,
  Construction: 35,
  Energy: 60,
  Finance: 70,
  Logistics: 65,
};

const GRADE_THRESHOLDS: [number, string][] = [
  [85, "AAA"], [75, "AA"], [65, "A"], [55, "BBB"], [45, "BB"], [35, "B"], [0, "CCC"],
];

function computeRiskScore(invoice: InvoiceData, debtorHistory: { totalInvoices: number; settledOnTime: number; disputes: number }): RiskScore {
  const factors: RiskFactor[] = [];

  // Factor 1: Sector stability (weight: 0.20)
  const sectorScore = SECTOR_VOLATILITY[invoice.sector] ?? 50;
  factors.push({
    name: "Sector Stability",
    weight: 0.20,
    rawScore: sectorScore,
    weightedScore: sectorScore * 0.20,
    explanation: `${invoice.sector} sector has ${sectorScore >= 70 ? "high" : sectorScore >= 50 ? "moderate" : "low"} historical stability`,
  });

  // Factor 2: Payment term risk (weight: 0.15) — shorter is better
  const termScore = Math.max(0, Math.min(100, 100 - (invoice.paymentTermDays - 15) * 1.2));
  factors.push({
    name: "Payment Term Risk",
    weight: 0.15,
    rawScore: Math.round(termScore),
    weightedScore: Math.round(termScore * 0.15 * 100) / 100,
    explanation: `Net ${invoice.paymentTermDays} days — ${invoice.paymentTermDays <= 30 ? "standard terms" : invoice.paymentTermDays <= 60 ? "extended terms increase risk" : "long-dated, elevated risk"}`,
  });

  // Factor 3: Amount concentration (weight: 0.15) — mid-range is best
  const amountScore = invoice.amount < 10000 ? 60 :
    invoice.amount < 50000 ? 80 :
    invoice.amount < 100000 ? 90 :
    invoice.amount < 500000 ? 70 : 50;
  factors.push({
    name: "Amount Concentration",
    weight: 0.15,
    rawScore: amountScore,
    weightedScore: Math.round(amountScore * 0.15 * 100) / 100,
    explanation: `$${invoice.amount.toLocaleString()} — ${amountScore >= 80 ? "optimal range for diversification" : "higher concentration risk"}`,
  });

  // Factor 4: Debtor track record (weight: 0.30)
  let debtorScore = 50; // default
  if (debtorHistory.totalInvoices > 0) {
    const paymentRate = debtorHistory.settledOnTime / debtorHistory.totalInvoices;
    const disputeRate = debtorHistory.disputes / debtorHistory.totalInvoices;
    debtorScore = Math.round(paymentRate * 80 + (1 - disputeRate) * 20);
  }
  // Also factor in reliabilityScore
  const ratingBoost = invoice.reliabilityScore === "A" ? 20 : invoice.reliabilityScore === "B" ? 10 : 0;
  debtorScore = Math.min(100, debtorScore + ratingBoost);
  factors.push({
    name: "Debtor Track Record",
    weight: 0.30,
    rawScore: debtorScore,
    weightedScore: Math.round(debtorScore * 0.30 * 100) / 100,
    explanation: `Rating ${invoice.reliabilityScore}, ${debtorHistory.totalInvoices} historical invoices, ${debtorHistory.disputes} disputes`,
  });

  // Factor 5: Currency risk (weight: 0.10)
  const currencyScore = invoice.currency === "USD" ? 90 : invoice.currency === "EUR" ? 85 : 60;
  factors.push({
    name: "Currency Stability",
    weight: 0.10,
    rawScore: currencyScore,
    weightedScore: Math.round(currencyScore * 0.10 * 100) / 100,
    explanation: `${invoice.currency} — ${currencyScore >= 85 ? "major reserve currency" : "elevated FX risk"}`,
  });

  // Factor 6: Temporal proximity (weight: 0.10) — closer due date is lower risk
  const dueDateMs = Date.parse(invoice.dueDate + (invoice.dueDate.includes("T") ? "" : "T00:00:00Z"));
  const daysUntilDue = Math.max(1, Math.round(((isNaN(dueDateMs) ? Date.now() : dueDateMs) - Date.now()) / (1000 * 60 * 60 * 24)));
  const temporalScore = Math.max(0, Math.min(100, 100 - (daysUntilDue - 30) * 0.8));
  factors.push({
    name: "Temporal Proximity",
    weight: 0.10,
    rawScore: Math.round(temporalScore),
    weightedScore: Math.round(temporalScore * 0.10 * 100) / 100,
    explanation: `${daysUntilDue} days until due — ${daysUntilDue <= 30 ? "near-term, lower risk" : "longer horizon, more uncertainty"}`,
  });

  const overall = Math.round(factors.reduce((sum, f) => sum + f.weightedScore, 0));
  const grade = GRADE_THRESHOLDS.find(([threshold]) => overall >= threshold)?.[1] || "CCC";

  return {
    overall,
    grade,
    factors,
    computedAt: new Date().toISOString(),
  };
}

function toAmountBucket(amount: number): string {
  if (amount < 10000) return "Under 10K";
  if (amount < 50000) return "10K-50K";
  if (amount < 100000) return "50K-100K";
  if (amount < 500000) return "100K-500K";
  return "500K+";
}

function toMetadata(inv: InvoiceData): InvoiceMetadata {
  return {
    invoiceId: inv.invoiceId,
    amountBucket: toAmountBucket(inv.amount),
    currency: inv.currency,
    sector: inv.sector,
    paymentTermDays: inv.paymentTermDays,
    reliabilityScore: inv.reliabilityScore,
  };
}

const DATA_DIR = process.env.VERCEL
  ? path.join("/tmp", "clearflow-data")
  : path.join(__dirname, "..", "data");

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function persistToFile(name: string, data: any): void {
  ensureDataDir();
  const target = path.join(DATA_DIR, `${name}.json`);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
  fs.renameSync(tmp, target);
}

function loadFromFile<T>(name: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, `${name}.json`), "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapToObj<V>(map: Map<string, V>): Record<string, V> {
  return Object.fromEntries(map);
}

function objToMap<V>(obj: Record<string, V>): Map<string, V> {
  return new Map(Object.entries(obj));
}

interface PartyEntry {
  displayName: string;
  role: string;
  partyId: string;
  registeredAt: string;
}

function generatePartyId(displayName: string): string {
  const hex = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
  return `${displayName}::${hex}`;
}

class StandaloneLedger {
  private invoices: Map<string, InvoiceData>;
  private auctions: Map<string, AuctionState>;
  private settlements: Map<string, Settlement>;
  private paymentNotifications: Map<string, PaymentNotification>;
  private portfolioAuctions: Map<string, PortfolioAuction>;
  private parties: PartyEntry[];
  public auditChain: AuditChain = new AuditChain();

  constructor() {
    // Load persisted state from disk
    this.invoices = objToMap(loadFromFile<Record<string, InvoiceData>>("ledger-invoices", {}));
    this.auctions = objToMap(loadFromFile<Record<string, AuctionState>>("ledger-auctions", {}));
    this.settlements = objToMap(loadFromFile<Record<string, Settlement>>("ledger-settlements", {}));
    this.paymentNotifications = objToMap(loadFromFile<Record<string, PaymentNotification>>("ledger-notifications", {}));
    this.portfolioAuctions = objToMap(loadFromFile<Record<string, PortfolioAuction>>("ledger-portfolios", {}));
    this.parties = loadFromFile<PartyEntry[]>("ledger-parties", []);

    // Seed Operator if no parties exist
    if (!this.parties.find((p) => p.displayName === "Operator")) {
      this.parties.push({ displayName: "Operator", role: "operator", partyId: generatePartyId("Operator"), registeredAt: new Date().toISOString() });
      persistToFile("ledger-parties", this.parties);
    }
    // Backfill partyId for legacy parties loaded from disk that don't have one
    let backfilled = false;
    for (const p of this.parties) {
      if (!p.partyId) {
        console.warn(`[Ledger] Party "${p.displayName}" missing partyId — generating one. This party's ID will differ from any Canton-allocated ID.`);
        p.partyId = generatePartyId(p.displayName);
        backfilled = true;
      }
    }
    if (backfilled) persistToFile("ledger-parties", this.parties);

    const loadedCount = this.invoices.size + this.auctions.size + this.settlements.size;
    if (loadedCount > 0) {
      console.log(`[Ledger] Restored ${this.invoices.size} invoices, ${this.auctions.size} auctions, ${this.settlements.size} settlements from disk`);
    }
    if (this.parties.length > 0) {
      console.log(`[Ledger] ${this.parties.length} registered parties: ${this.parties.map((p) => `${p.displayName}(${p.role})`).join(", ")}`);
    }
  }

  private persist(): void {
    persistToFile("ledger-invoices", mapToObj(this.invoices));
    persistToFile("ledger-auctions", mapToObj(this.auctions));
    persistToFile("ledger-settlements", mapToObj(this.settlements));
    persistToFile("ledger-notifications", mapToObj(this.paymentNotifications));
    persistToFile("ledger-portfolios", mapToObj(this.portfolioAuctions));
    persistToFile("ledger-parties", this.parties);
  }

  registerParty(displayName: string, role: string): PartyEntry {
    const existing = this.parties.find((p) => p.displayName === displayName);
    if (existing) return existing;
    const entry: PartyEntry = { displayName, role, partyId: generatePartyId(displayName), registeredAt: new Date().toISOString() };
    this.parties.push(entry);
    persistToFile("ledger-parties", this.parties);
    return entry;
  }

  getParty(displayName: string): PartyEntry | undefined {
    return this.parties.find((p) => p.displayName === displayName);
  }

  getAllParties(): PartyEntry[] {
    return [...this.parties];
  }

  // Track debtor history for risk scoring
  private getDebtorHistory(debtor: string): { totalInvoices: number; settledOnTime: number; disputes: number } {
    const allInvs = Array.from(this.invoices.values()).filter((i) => i.debtor === debtor);
    const settled = Array.from(this.settlements.values()).filter((s) => {
      const inv = this.invoices.get(s.invoiceId);
      return inv && inv.debtor === debtor;
    });
    const disputed = allInvs.filter((i) => i.status === "disputed" || i.disputeReason);
    return {
      totalInvoices: allInvs.length,
      settledOnTime: settled.length,
      disputes: disputed.length,
    };
  }

  createInvoice(data: InvoiceData): InvoiceData {
    const documentHash = hashInvoiceDocument(data);
    const debtorHistory = this.getDebtorHistory(data.debtor);
    const riskScore = computeRiskScore(data, debtorHistory);
    const invoice = { ...data, status: "pending" as const, documentHash, riskScore };
    this.invoices.set(data.invoiceId, invoice);

    this.auditChain.append("CREATE_INVOICE", data.seller, {
      invoiceId: data.invoiceId,
      documentHash,
      amount: data.amount,
      riskGrade: riskScore.grade,
      riskScore: riskScore.overall,
    });

    this.persist();
    return invoice;
  }

  getInvoice(invoiceId: string): InvoiceData | undefined {
    return this.invoices.get(invoiceId);
  }

  getAllInvoices(): InvoiceData[] {
    return Array.from(this.invoices.values());
  }

  approveInvoice(invoiceId: string): InvoiceData | null {
    const inv = this.invoices.get(invoiceId);
    if (!inv || inv.status !== "pending") return null;
    inv.status = "verified";

    this.auditChain.append("APPROVE_INVOICE", "Operator", {
      invoiceId,
      documentHash: inv.documentHash,
    });

    this.persist();
    return inv;
  }

  confirmInvoice(invoiceId: string, debtorParty?: string): InvoiceData | null {
    const inv = this.invoices.get(invoiceId);
    if (!inv || inv.status !== "verified") return null;
    // Validate that the caller is the debtor on this invoice
    if (debtorParty && inv.debtor !== debtorParty) return null;
    inv.status = "confirmed";

    this.auditChain.append("CONFIRM_INVOICE", inv.debtor, {
      invoiceId,
      documentHash: inv.documentHash,
    });

    this.persist();
    return inv;
  }

  createAuction(invoiceId: string): AuctionState | null {
    const inv = this.invoices.get(invoiceId);
    if (!inv) return null;
    if (inv.status !== "confirmed") return null;

    const auction: AuctionState = {
      invoiceId,
      metadata: toMetadata(inv),
      status: "open",
      bids: [],
    };
    this.auctions.set(invoiceId, auction);

    this.auditChain.append("CREATE_AUCTION", inv.seller, {
      invoiceId,
      documentHash: inv.documentHash,
    });

    this.persist();
    return auction;
  }

  getAuction(invoiceId: string): AuctionState | undefined {
    return this.auctions.get(invoiceId);
  }

  getAllAuctions(): AuctionState[] {
    return Array.from(this.auctions.values());
  }

  submitBid(bid: { lender: string; invoiceId: string; commitHash: string }): SealedBid | null {
    const auction = this.auctions.get(bid.invoiceId);
    if (!auction || auction.status !== "open") return null;
    // Prevent duplicate bids from same lender
    if (auction.bids.some((b) => b.lender === bid.lender)) return null;
    if (!bid.commitHash || bid.commitHash.length !== 64) return null;

    const sealedBid: SealedBid = {
      lender: bid.lender,
      invoiceId: bid.invoiceId,
      discountRate: 0,  // hidden until reveal
      commitHash: bid.commitHash,
      verified: false,
      revealed: false,
    };
    auction.bids.push(sealedBid);

    this.auditChain.append("SUBMIT_BID", bid.lender, {
      invoiceId: bid.invoiceId,
      commitHash: bid.commitHash,
    });

    this.persist();
    return sealedBid;
  }

  revealBid(invoiceId: string, lender: string, discountRate: number, nonce: string): SealedBid | null {
    const auction = this.auctions.get(invoiceId);
    if (!auction) return null;
    // Can only reveal after auction is closed
    if (auction.status !== "closed") return null;

    const bid = auction.bids.find((b) => b.lender === lender);
    if (!bid || !bid.commitHash) return null;
    if (bid.revealed) return null; // already revealed

    // Verify commitment: SHA-256(rate + nonce) must match commitHash
    if (!verifyBidCommitment(discountRate, nonce, bid.commitHash)) {
      return null; // commitment mismatch — reject
    }

    // Rate bounds check
    if (discountRate <= 0 || discountRate >= 1) return null;

    bid.discountRate = discountRate;
    bid.nonce = nonce;
    bid.verified = true;
    bid.revealed = true;

    this.auditChain.append("REVEAL_BID", lender, {
      invoiceId,
      commitHash: bid.commitHash,
      verified: true,
    });

    this.persist();
    return bid;
  }

  // Get bids visible to a specific party (privacy enforcement)
  getBidsForParty(invoiceId: string, party: string): SealedBid[] {
    const auction = this.auctions.get(invoiceId);
    if (!auction) return [];
    // Each lender only sees their own bid. Operator/seller sees all after close.
    return auction.bids.filter((b) => b.lender === party);
  }

  closeAuction(invoiceId: string, seller: string): AuctionState | null {
    const auction = this.auctions.get(invoiceId);
    if (!auction || auction.status !== "open") return null;
    if (auction.bids.length < 2) return null; // Min 2 bids required

    // Close the auction — lenders now have a window to reveal bids
    auction.status = "closed";

    this.auditChain.append("CLOSE_AUCTION", seller, {
      invoiceId,
      bidCount: auction.bids.length,
    });

    this.persist();
    return auction;
  }

  /** After all bids are revealed, finalize the auction and select the winner. */
  finalizeAuction(invoiceId: string): AuctionState | null {
    const auction = this.auctions.get(invoiceId);
    if (!auction || auction.status !== "closed") return null;

    // All bids must be revealed before finalizing
    const unrevealed = auction.bids.filter((b) => !b.revealed);
    if (unrevealed.length > 0) return null;

    // Select winner: lowest discount rate = best for seller
    const sorted = [...auction.bids].sort((a, b) => a.discountRate - b.discountRate);
    const winner = sorted[0];
    auction.winningLender = winner.lender;
    auction.winningRate = winner.discountRate;

    this.auditChain.append("FINALIZE_AUCTION", "Operator", {
      invoiceId,
      bidCount: auction.bids.length,
      winningLender: auction.winningLender,
      allCommitmentsVerified: auction.bids.every((b) => b.verified),
    });

    this.persist();
    return auction;
  }

  settle(invoiceId: string, lender: string): Settlement | null {
    const auction = this.auctions.get(invoiceId);
    const invoice = this.invoices.get(invoiceId);
    if (!auction || !invoice) return null;
    if (auction.status !== "closed") return null;
    if (auction.winningLender !== lender) return null;

    const settlement: Settlement = {
      invoiceId,
      seller: invoice.seller,
      lender,
      originalAmount: invoice.amount,
      financedAmount: invoice.amount * (1 - auction.winningRate!),
      discountRate: auction.winningRate!,
      status: "settled",
      debtor: invoice.debtor,
    };

    this.settlements.set(invoiceId, settlement);
    auction.status = "settled";

    // Auto-create payment notification for the debtor
    const notification: PaymentNotification = {
      invoiceId,
      debtor: invoice.debtor,
      seller: invoice.seller,
      winningLender: lender,
      amount: invoice.amount,
      dueDate: invoice.dueDate,
      createdAt: new Date().toISOString(),
    };
    this.paymentNotifications.set(invoiceId, notification);

    this.auditChain.append("SETTLE", lender, {
      invoiceId,
      financedAmount: settlement.financedAmount,
      discountRate: settlement.discountRate,
    });

    this.auditChain.append("PAYMENT_REDIRECT", "Operator", {
      invoiceId,
      debtor: notification.debtor,
      winningLender: notification.winningLender,
    });

    this.persist();
    return settlement;
  }

  getSettlement(invoiceId: string): Settlement | undefined {
    return this.settlements.get(invoiceId);
  }

  getAllSettlements(): Settlement[] {
    return Array.from(this.settlements.values());
  }

  getPaymentNotifications(debtor?: string): PaymentNotification[] {
    const all = Array.from(this.paymentNotifications.values());
    if (debtor) return all.filter((n) => n.debtor === debtor);
    return all;
  }

  getRiskScore(invoiceId: string): RiskScore | null {
    const inv = this.invoices.get(invoiceId);
    if (!inv) return null;
    // Return cached score if computed within the last 60 seconds
    if (inv.riskScore && inv.riskScore.computedAt) {
      const age = Date.now() - new Date(inv.riskScore.computedAt).getTime();
      if (age < 60_000) return inv.riskScore;
    }
    // Recompute with latest debtor history
    const history = this.getDebtorHistory(inv.debtor);
    const score = computeRiskScore(inv, history);
    inv.riskScore = score;
    return score;
  }

  disputeInvoice(invoiceId: string, debtor: string, reason: string): InvoiceData | null {
    const inv = this.invoices.get(invoiceId);
    if (!inv) return null;
    if (inv.debtor !== debtor) return null;
    // Can dispute if verified or confirmed (before auction)
    if (inv.status !== "verified" && inv.status !== "confirmed") return null;
    // Cannot dispute if already in auction
    if (this.auctions.has(invoiceId)) return null;

    inv.status = "disputed";
    inv.disputeReason = reason;
    inv.disputedAt = new Date().toISOString();

    this.auditChain.append("DISPUTE_INVOICE", debtor, {
      invoiceId,
      reason,
    });

    this.persist();
    return inv;
  }

  resolveDispute(invoiceId: string, resolution: "upheld" | "rejected"): InvoiceData | null {
    const inv = this.invoices.get(invoiceId);
    if (!inv || inv.status !== "disputed") return null;

    if (resolution === "rejected") {
      // Dispute rejected — invoice goes back to confirmed
      inv.status = "confirmed";
    } else {
      // Dispute upheld — invoice goes back to pending (needs re-verification)
      inv.status = "pending";
    }
    inv.disputeResolution = resolution;
    inv.resolvedAt = new Date().toISOString();

    this.auditChain.append("RESOLVE_DISPUTE", "Operator", {
      invoiceId,
      resolution,
      newStatus: inv.status,
    });

    this.persist();
    return inv;
  }

  createPortfolioAuction(invoiceIds: string[], seller: string): PortfolioAuction | null {
    // Validate all invoices exist, are confirmed, and belong to the seller
    const invoices: InvoiceData[] = [];
    for (const id of invoiceIds) {
      const inv = this.invoices.get(id);
      if (!inv || inv.status !== "confirmed" || inv.seller !== seller) return null;
      if (this.auctions.has(id)) return null; // Already in individual auction
      invoices.push(inv);
    }
    if (invoices.length < 2 || invoices.length > 50) return null; // Need 2-50 invoices

    const totalAmount = invoices.reduce((sum, inv) => sum + inv.amount, 0);
    const weightedRisk = invoices.reduce((sum, inv) => {
      const score = inv.riskScore?.overall ?? 50;
      return sum + score * (inv.amount / totalAmount);
    }, 0);

    const sectors = [...new Set(invoices.map((i) => i.sector))];
    const currencies = [...new Set(invoices.map((i) => i.currency || "USD"))];
    const avgTerms = Math.round(invoices.reduce((s, i) => s + i.paymentTermDays, 0) / invoices.length);
    const avgGrade = GRADE_THRESHOLDS.find(([t]) => Math.round(weightedRisk) >= t)?.[1] || "CCC";

    // Compute cross-currency netting
    const netting = computeNetting(invoices);

    const portfolioId = `PF-${Date.now().toString(36).toUpperCase()}`;
    const portfolio: PortfolioAuction = {
      portfolioId,
      invoiceIds,
      seller,
      totalAmount,
      weightedRiskScore: Math.round(weightedRisk),
      status: "open",
      bids: [],
      metadata: {
        invoiceCount: invoices.length,
        totalAmountBucket: toAmountBucket(totalAmount),
        sectors,
        currencies,
        avgPaymentTermDays: avgTerms,
        avgRiskGrade: avgGrade,
        netting: currencies.length > 1 ? netting : undefined,
      },
    };

    this.portfolioAuctions.set(portfolioId, portfolio);

    this.auditChain.append("CREATE_PORTFOLIO_AUCTION", seller, {
      portfolioId,
      invoiceCount: invoices.length,
      totalAmountBucket: portfolio.metadata.totalAmountBucket,
      weightedRiskScore: portfolio.weightedRiskScore,
    });

    this.persist();
    return portfolio;
  }

  submitPortfolioBid(bid: { lender: string; portfolioId: string; discountRate: number }): SealedBid | null {
    const portfolio = this.portfolioAuctions.get(bid.portfolioId);
    if (!portfolio || portfolio.status !== "open") return null;
    if (portfolio.bids.some((b) => b.lender === bid.lender)) return null;

    const nonce = generateNonce();
    const commitHash = computeBidCommitment(bid.discountRate, nonce);
    const sealedBid: SealedBid = {
      lender: bid.lender,
      invoiceId: bid.portfolioId, // Use portfolioId as invoiceId field
      discountRate: bid.discountRate,
      commitHash,
      nonce,
      verified: false,
    };
    portfolio.bids.push(sealedBid);

    this.auditChain.append("SUBMIT_PORTFOLIO_BID", bid.lender, {
      portfolioId: bid.portfolioId,
      commitHash,
    });

    this.persist();
    return sealedBid;
  }

  closePortfolioAuction(portfolioId: string, seller: string): PortfolioAuction | null {
    const portfolio = this.portfolioAuctions.get(portfolioId);
    if (!portfolio || portfolio.status !== "open") return null;
    if (portfolio.seller !== seller) return null;
    if (portfolio.bids.length < 2) return null;

    for (const bid of portfolio.bids) {
      if (bid.commitHash && bid.nonce) {
        bid.verified = verifyBidCommitment(bid.discountRate, bid.nonce, bid.commitHash);
      }
    }

    portfolio.status = "closed";
    const sorted = [...portfolio.bids].sort((a, b) => a.discountRate - b.discountRate);
    const winner = sorted[0];
    portfolio.winningLender = winner.lender;
    portfolio.winningRate = winner.discountRate;

    this.auditChain.append("CLOSE_PORTFOLIO_AUCTION", seller, {
      portfolioId,
      bidCount: portfolio.bids.length,
      winningLender: portfolio.winningLender,
    });

    this.persist();
    return portfolio;
  }

  settlePortfolio(portfolioId: string, lender: string): { portfolio: PortfolioAuction; settlements: Settlement[] } | null {
    const portfolio = this.portfolioAuctions.get(portfolioId);
    if (!portfolio || portfolio.status !== "closed") return null;
    if (portfolio.winningLender !== lender) return null;

    const settledList: Settlement[] = [];
    for (const invoiceId of portfolio.invoiceIds) {
      const inv = this.invoices.get(invoiceId);
      if (!inv) continue;

      const settlement: Settlement = {
        invoiceId,
        seller: inv.seller,
        lender,
        originalAmount: inv.amount,
        financedAmount: inv.amount * (1 - portfolio.winningRate!),
        discountRate: portfolio.winningRate!,
        status: "settled",
        debtor: inv.debtor,
      };
      this.settlements.set(invoiceId, settlement);
      settledList.push(settlement);

      // Payment notification for each invoice's debtor
      const notification: PaymentNotification = {
        invoiceId,
        debtor: inv.debtor,
        seller: inv.seller,
        winningLender: lender,
        amount: inv.amount,
        dueDate: inv.dueDate,
        createdAt: new Date().toISOString(),
      };
      this.paymentNotifications.set(invoiceId, notification);
    }

    portfolio.status = "settled";

    this.auditChain.append("SETTLE_PORTFOLIO", lender, {
      portfolioId,
      invoiceCount: portfolio.invoiceIds.length,
      totalFinanced: settledList.reduce((s, t) => s + t.financedAmount, 0),
    });

    this.persist();
    return { portfolio, settlements: settledList };
  }

  getPortfolioAuction(portfolioId: string): PortfolioAuction | undefined {
    return this.portfolioAuctions.get(portfolioId);
  }

  getAllPortfolioAuctions(): PortfolioAuction[] {
    return Array.from(this.portfolioAuctions.values());
  }

  reset(): void {
    this.invoices.clear();
    this.auctions.clear();
    this.settlements.clear();
    this.paymentNotifications.clear();
    this.portfolioAuctions.clear();
    this.parties = [{ displayName: "Operator", role: "operator", partyId: generatePartyId("Operator"), registeredAt: new Date().toISOString() }];
    this.auditChain.reset();
    this.persist();
  }
}

let useCantonLedger = false;
const ledger = new StandaloneLedger();

export async function checkLedgerConnection(): Promise<boolean> {
  try {
    // Probe the Canton ledger readiness endpoint (no auth required)
    const resp = await fetch(`${LEDGER_API_URL}/readyz`, { method: "GET" });
    if (resp.ok) {
      useCantonLedger = true;
      return true;
    }
  } catch {
    // Canton ledger not available — using standalone ledger
  }
  useCantonLedger = false;
  return false;
}

export function isCantonMode(): boolean {
  return useCantonLedger;
}

export function isStandaloneMode(): boolean {
  return !useCantonLedger;
}

// Exported for use in Canton mode (risk scoring from cached data)
function computeRiskScoreFromData(data: any): any {
  const invoice: InvoiceData = {
    invoiceId: data.invoiceId || "",
    seller: data.seller || "",
    debtor: data.debtor || "",
    amount: typeof data.amount === "number" ? data.amount : (parseFloat(data.amount) || 0),
    currency: data.currency || "USD",
    sector: data.sector || "Other",
    paymentTermDays: typeof data.paymentTermDays === "number" ? data.paymentTermDays : (parseInt(data.paymentTermDays, 10) || 30),
    issueDate: data.issueDate || new Date().toISOString(),
    dueDate: data.dueDate || new Date().toISOString(),
    reliabilityScore: data.reliabilityScore || "B",
  };
  return computeRiskScore(invoice, { totalInvoices: 0, settledOnTime: 0, disputes: 0 });
}

export { ledger, toMetadata, toAmountBucket, computeRiskScoreFromData };
