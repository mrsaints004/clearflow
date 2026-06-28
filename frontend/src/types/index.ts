export interface RiskFactor {
  name: string;
  weight: number;
  rawScore: number;
  weightedScore: number;
  explanation: string;
}

export interface RiskScore {
  overall: number;
  grade: string;
  factors: RiskFactor[];
  computedAt: string;
}

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

export interface InvoiceMetadata {
  invoiceId: string;
  amountBucket: string;
  currency: string;
  sector: string;
  paymentTermDays: number;
  reliabilityScore: string;
}

export interface AuctionView {
  invoiceId: string;
  metadata: InvoiceMetadata;
  status: "open" | "closed" | "settled";
  bidCount: number;
}

export interface SellerAuctionView extends AuctionView {
  winningLender?: string;
  winningRate?: number;
  bids?: Array<{ lender: string; discountRate: number }>;
}

export interface LenderAuctionView {
  invoiceId: string;
  metadata: InvoiceMetadata;
  status: "open" | "closed" | "settled";
  myBid: { lender: string; invoiceId: string; discountRate: number } | null;
  totalBidCount: number;
  won: boolean;
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

export interface TransactionEntry {
  id: string;
  timestamp: string;
  action: string;
  template: string;
  actingParty: string;
  details?: string;
}

export interface AuditEntry {
  sequenceNumber: number;
  timestamp: string;
  action: string;
  party: string;
  data: Record<string, any>;
  prevHash: string;
  hash: string;
}

export interface AuditLog {
  entries: AuditEntry[];
  chainHead: string;
  totalEntries: number;
  integrity: { valid: boolean; brokenAt?: number };
}

export interface PortfolioAuctionView {
  portfolioId: string;
  invoiceIds: string[];
  status: "open" | "closed" | "settled";
  metadata: {
    invoiceCount: number;
    totalAmountBucket: string;
    sectors: string[];
    avgPaymentTermDays: number;
    avgRiskGrade: string;
  };
  bidCount: number;
  winningLender?: string;
  winningRate?: number;
  bids?: Array<{ lender: string; discountRate: number; commitHash?: string; verified?: boolean }>;
}

export interface RegisteredParty {
  displayName: string;
  role: string;
  partyId: string;
  registeredAt?: string;
}

export interface AuthSession {
  token: string;
  party: string;
  role: string;
  displayName: string;
}
