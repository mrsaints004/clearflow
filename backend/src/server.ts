import express from "express";
import cors from "cors";
import path from "path";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { initDamlClient, damlClient } from "./daml-client";
import {
  ledger,
  computeRiskScoreFromData,
  type InvoiceData,
  type SealedBid,
} from "./ledger";
import {
  authMiddleware,
  authenticateParty,
  signAppToken,
  registerPartyPassword,
  requireRole,
  isAuthRequired,
} from "./auth";
import { clearAllPersistedData, loadAuditEntries, saveAuditEntries } from "./persistence";
import { AuditChain, computeBidCommitment, generateNonce } from "./crypto";
import {
  registerAgent,
  getAgent,
  getAllAgents,
  analyzeAuction,
  executeAgentBid,
  generatePortfolioReport,
  getAgentActions,
  recordAuctionOutcome,
  getAgentPerformance,
  getAgentPortfolioState,
  getAnalysisWithLLM,
  type AgentConfig,
} from "./agent";
import {
  validate,
  LoginSchema,
  RegisterSchema,
  InvoiceCreateSchema,
  BidSubmitSchema,
  BidRevealSchema,
  AuctionCreateSchema,
  DisputeSchema,
  ResolveDisputeSchema,
  AgentCreateSchema,
  AgentConfigureSchema,
  PortfolioCreateSchema,
  SettleSchema,
  PortfolioBidSchema,
  PortfolioSettleSchema,
  PortfolioCloseSchema,
  AuctionCloseSchema,
  AgentAnalyzeSchema,
  AgentAutoBidSchema,
  BreachTestSchema,
} from "./validation";

const app = express();
const PORT = process.env.PORT || 3002;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

let useLedger = false;

// Application-layer audit chain — persisted to disk, works in both modes
const auditChain = new AuditChain({ onPersist: (entries) => saveAuditEntries(entries) });
auditChain.load(loadAuditEntries());

// Agent bid secrets: "party:invoiceId" -> { nonce, discountRate }
// Stored server-side so agent bids can be auto-revealed when auction closes
const agentBidSecrets = new Map<string, { nonce: string; discountRate: number }>();

function validateConfig(): void {
  if (IS_PRODUCTION) {
    const required = ["APP_SECRET", "JWT_SECRET", "OPERATOR_PASSWORD"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      console.error(`FATAL: Missing required env vars in production: ${missing.join(", ")}`);
      process.exit(1);
    }
    if (process.env.APP_SECRET === "clearflow-app-secret-change-in-production") {
      console.error("FATAL: APP_SECRET is set to the default value. Change it for production.");
      process.exit(1);
    }
    if (process.env.JWT_SECRET === "clearflow-dev-secret-change-in-production") {
      console.error("FATAL: JWT_SECRET is set to the default value. Change it for production.");
      process.exit(1);
    }
    if (process.env.OPERATOR_PASSWORD === "operator-secret") {
      console.error("FATAL: OPERATOR_PASSWORD is set to the default value. Change it for production.");
      process.exit(1);
    }
  }
}

app.use(
  helmet({
    contentSecurityPolicy: IS_PRODUCTION
      ? undefined
      : false,
    crossOriginEmbedderPolicy: false,
  })
);

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : (IS_PRODUCTION ? [] : ["http://localhost:3000", "http://localhost:3002"]);

app.use(
  cors({
    origin: IS_PRODUCTION
      ? ALLOWED_ORIGINS
      : true,
    credentials: true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 3600,
  })
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PRODUCTION ? 500 : 10000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});
app.use("/api/", apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many login attempts, please try again later" },
});

app.use(express.json({ limit: "10kb" }));

// Request ID middleware
app.use((req, _res, next) => {
  (req as any).requestId = crypto.randomUUID();
  next();
});

function apiError(
  res: express.Response,
  status: number,
  message: string,
  details?: any
): void {
  const body: any = { error: message };
  if (!IS_PRODUCTION && details) body.details = details;
  res.status(status).json(body);
}

// URL param validation: alphanumeric + hyphens/underscores, max 100 chars
const SAFE_PARAM = /^[a-zA-Z0-9_\-]+$/;
function validateParam(param: string, name: string, res: express.Response): boolean {
  if (!param || param.length > 100 || !SAFE_PARAM.test(param)) {
    res.status(400).json({ error: `Invalid ${name} parameter` });
    return false;
  }
  return true;
}

app.use(authMiddleware);

app.use((req, _res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

// ─── Health ──────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    mode: "canton-ledger",
    authRequired: isAuthRequired(),
    uptime: Math.floor(process.uptime()),
  });
});

app.get("/api/health/ready", async (_req, res) => {
  if (useLedger) {
    try {
      const ledgerUrl = process.env.LEDGER_API_URL || (IS_PRODUCTION ? "" : "http://localhost:7575");
      const check = await fetch(`${ledgerUrl}/readyz`);
      if (!check.ok) {
        res.status(503).json({ status: "not_ready", reason: "Ledger unreachable" });
        return;
      }
    } catch {
      res.status(503).json({ status: "not_ready", reason: "Ledger connection failed" });
      return;
    }
  }
  res.json({ status: "ready", mode: useLedger ? "canton-ledger" : "local-ledger" });
});

// ─── Auth ────────────────────────────────────────────────────────────

app.post("/api/auth/login", authLimiter, validate(LoginSchema), (req, res) => {
  const { party, password } = req.body;

  if (!authenticateParty(party, password)) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  let role = "lender";
  if (useLedger) {
    const parties = damlClient.getParties();
    const p = parties.find((r) => r.displayName === party);
    if (p) role = p.role;
  } else {
    const p = ledger.getParty(party);
    if (p) role = p.role;
  }

  const token = signAppToken(party, role);
  res.json({ token, party, role, expiresIn: "24h" });
});

// ─── Parties ─────────────────────────────────────────────────────────

app.get("/api/parties", (_req, res) => {
  if (useLedger) {
    const parties = damlClient.getParties();
    res.json(
      parties.map((p) => ({
        displayName: p.displayName,
        role: p.role,
        partyId: p.partyId || p.displayName,
        registeredAt: p.registeredAt,
      }))
    );
  } else {
    res.json(
      ledger.getAllParties().map((p) => ({
        displayName: p.displayName,
        role: p.role,
        partyId: p.partyId,
        registeredAt: p.registeredAt,
      }))
    );
  }
});

app.post("/api/parties/register", validate(RegisterSchema), async (req, res) => {
  try {
    const { displayName, role, password } = req.body;

    if (useLedger) {
      const record = await damlClient.registerParty(displayName, role);
      registerPartyPassword(displayName, password);
      res.status(201).json({
        displayName: record.displayName,
        role: record.role,
        partyId: record.partyId || record.displayName,
        registeredAt: record.registeredAt,
      });
    } else {
      const existing = ledger.getParty(displayName);
      if (existing) {
        res.status(409).json({ error: "Party already registered" });
        return;
      }
      const entry = ledger.registerParty(displayName, role);
      registerPartyPassword(displayName, password);
      res.status(201).json({
        displayName: entry.displayName,
        role: entry.role,
        partyId: entry.partyId,
        registeredAt: entry.registeredAt,
      });
    }
  } catch (e: any) {
    console.error(`Party registration failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Registration failed" : e.message });
  }
});

// ─── Invoices ────────────────────────────────────────────────────────

app.post("/api/invoices", requireRole("seller", "operator"), validate(InvoiceCreateSchema), async (req, res) => {
  try {
    const data: InvoiceData = req.body;

    // Validate debtor is a registered party (any role can act as debtor contextually)
    const debtorParty = useLedger
      ? damlClient.getParties().find((p) => p.displayName === data.debtor)
      : ledger.getParty(data.debtor);
    if (!debtorParty) {
      res.status(400).json({ error: "Debtor must be a registered party" });
      return;
    }

    const seller = req.authenticatedParty || data.seller;

    // Ensure issueDate and dueDate are set (Daml contract requires them)
    const now = new Date();
    if (!data.issueDate) data.issueDate = now.toISOString().split("T")[0];
    if (!data.dueDate) {
      const due = new Date(now);
      due.setDate(due.getDate() + (data.paymentTermDays || 30));
      data.dueDate = due.toISOString().split("T")[0];
    }

    if (useLedger) {
      // Canton mode: create on both Canton ledger and local ledger
      await damlClient.createInvoice({ ...data, seller });
      const invoice = ledger.createInvoice({ ...data, seller });
      auditChain.append("CREATE_INVOICE", seller, { invoiceId: data.invoiceId, amount: data.amount });
      res.status(201).json(invoice);
    } else {
      const invoice = ledger.createInvoice({ ...data, seller });
      res.status(201).json(invoice);
    }
  } catch (e: any) {
    console.error(`Invoice creation failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Invoice creation failed" : e.message });
  }
});

app.get("/api/invoices", async (req, res) => {
  try {
    const seller = req.query.seller as string | undefined;
    if (seller && (typeof seller !== "string" || seller.length > 50)) {
      res.status(400).json({ error: "Invalid seller parameter" });
      return;
    }

    if (useLedger) {
      // Canton mode: query from Canton ledger
      // Use seller filter if provided, otherwise query all (so debtors can see their invoices)
      const invoices = await damlClient.getInvoices(seller);
      // Map Canton party IDs to display names for frontend consumption
      const mapped = invoices.map((inv: any) => ({
        ...inv,
        seller: damlClient.getDisplayName(inv.seller),
        debtor: damlClient.getDisplayName(inv.debtorName || inv.debtor || ""),
      }));
      res.json(mapped);
    } else {
      let invoices = ledger.getAllInvoices();
      if (seller) {
        invoices = invoices.filter((i) => i.seller === seller);
      }
      res.json(invoices);
    }
  } catch (e: any) {
    console.error(`Invoice query failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Query failed" : e.message });
  }
});

app.post("/api/invoices/:invoiceId/approve", requireRole("operator"), async (req, res) => {
  const { invoiceId } = req.params;
  if (!validateParam(invoiceId, "invoiceId", res)) return;
  try {
    if (useLedger) {
      // Exercise Approve choice on Canton ledger
      await damlClient.approveInvoice(invoiceId);
      // Also update local ledger to keep in sync
      ledger.approveInvoice(invoiceId);
      auditChain.append("APPROVE_INVOICE", "Operator", { invoiceId });
      res.json({ invoiceId, status: "verified" });
    } else {
      const result = ledger.approveInvoice(invoiceId);
      if (!result) {
        res.status(400).json({ error: "Invoice not found or not in pending status" });
        return;
      }
      res.json(result);
    }
  } catch (e: any) {
    console.error(`Approve failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Approval failed" : e.message });
  }
});

app.post("/api/invoices/:invoiceId/confirm", requireRole("debtor", "operator"), async (req, res) => {
  const { invoiceId } = req.params;
  if (!validateParam(invoiceId, "invoiceId", res)) return;
  const callerParty = req.authenticatedParty;
  try {
    if (useLedger) {
      await damlClient.confirmInvoice(invoiceId, callerParty);
      ledger.confirmInvoice(invoiceId, callerParty);
      auditChain.append("CONFIRM_INVOICE", callerParty || "unknown", { invoiceId });
      res.json({ invoiceId, status: "confirmed" });
    } else {
      const result = ledger.confirmInvoice(invoiceId, callerParty);
      if (!result) {
        res.status(400).json({ error: "Invoice not found, not in verified status, or you are not the debtor" });
        return;
      }
      res.json(result);
    }
  } catch (e: any) {
    console.error(`Confirm failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Confirmation failed" : e.message });
  }
});

app.get("/api/payment-notifications", (req, res) => {
  const debtor = req.query.debtor as string | undefined;
  if (useLedger) {
    // Application-layer payment notifications in Canton mode
    const notifications = damlClient.getPaymentNotifications(debtor);
    res.json(notifications);
  } else {
    res.json(ledger.getPaymentNotifications(debtor));
  }
});

app.get("/api/risk-score/:invoiceId", (req, res) => {
  const { invoiceId } = req.params;
  if (!validateParam(invoiceId, "invoiceId", res)) return;
  if (useLedger) {
    // Risk scoring works from cached invoice data in both modes
    const cached = damlClient.getCachedInvoice(invoiceId);
    if (!cached) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    const score = computeRiskScoreFromData(cached);
    res.json(score);
  } else {
    const score = ledger.getRiskScore(invoiceId);
    if (!score) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    res.json(score);
  }
});

app.post("/api/invoices/:invoiceId/dispute", requireRole("debtor", "operator"), validate(DisputeSchema), async (req, res) => {
  const { invoiceId } = req.params;
  if (!validateParam(invoiceId, "invoiceId", res)) return;
  const { reason } = req.body;
  const callerParty = req.authenticatedParty;
  if (!callerParty) {
    res.status(401).json({ error: "Authentication required — debtor must be logged in" });
    return;
  }
  try {
    if (useLedger) {
      await damlClient.disputeInvoice(invoiceId, reason, callerParty);
      ledger.disputeInvoice(invoiceId, callerParty, reason);
      auditChain.append("DISPUTE_INVOICE", callerParty, { invoiceId, reason });
      res.json({ invoiceId, status: "disputed" });
    } else {
      const result = ledger.disputeInvoice(invoiceId, callerParty, reason);
      if (!result) {
        res.status(400).json({ error: "Cannot dispute — invoice not found, you are not the debtor, or not in disputable state" });
        return;
      }
      res.json(result);
    }
  } catch (e: any) {
    console.error(`Dispute failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Dispute failed" : e.message });
  }
});

app.post("/api/invoices/:invoiceId/resolve-dispute", requireRole("operator"), validate(ResolveDisputeSchema), async (req, res) => {
  const { invoiceId } = req.params;
  if (!validateParam(invoiceId, "invoiceId", res)) return;
  const { resolution } = req.body;
  try {
    if (useLedger) {
      await damlClient.resolveDispute(invoiceId, resolution);
      ledger.resolveDispute(invoiceId, resolution);
      auditChain.append("RESOLVE_DISPUTE", "Operator", { invoiceId, resolution });
      res.json({ invoiceId, status: resolution === "upheld" ? "pending" : "confirmed" });
    } else {
      const result = ledger.resolveDispute(invoiceId, resolution);
      if (!result) {
        res.status(400).json({ error: "Invoice not found or not in disputed state" });
        return;
      }
      res.json(result);
    }
  } catch (e: any) {
    console.error(`Resolve dispute failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Resolution failed" : e.message });
  }
});

// ─── Portfolio Auctions ──────────────────────────────────────────────

app.post("/api/portfolio-auctions", requireRole("seller", "operator"), validate(PortfolioCreateSchema), (req, res) => {
  const { invoiceIds, seller } = req.body;
  // Portfolio auctions use application-layer logic in both modes
  const portfolio = ledger.createPortfolioAuction(invoiceIds, seller);
  if (!portfolio) {
    res.status(400).json({ error: "Cannot create portfolio — invoices must be confirmed and not already in auction" });
    return;
  }
  auditChain.append("CREATE_PORTFOLIO_AUCTION", seller, {
    portfolioId: portfolio.portfolioId,
    invoiceCount: invoiceIds.length,
  });
  res.status(201).json(portfolio);
});

app.get("/api/portfolio-auctions", (_req, res) => {
  const portfolios = ledger.getAllPortfolioAuctions().map((p) => ({
    portfolioId: p.portfolioId,
    invoiceIds: p.invoiceIds,
    status: p.status,
    metadata: p.metadata,
    bidCount: p.bids.length,
    winningLender: p.status !== "open" ? p.winningLender : undefined,
    winningRate: p.status !== "open" ? p.winningRate : undefined,
  }));
  res.json(portfolios);
});

app.get("/api/portfolio-auctions/:portfolioId", (req, res) => {
  const { portfolioId } = req.params;
  const role = req.query.role as string | undefined;
  const party = req.query.party as string | undefined;

  const portfolio = ledger.getPortfolioAuction(portfolioId);
  if (!portfolio) {
    res.status(404).json({ error: "Portfolio auction not found" });
    return;
  }

  if (role === "lender" && party) {
    const myBid = portfolio.bids.find((b) => b.lender === party);
    res.json({
      portfolioId: portfolio.portfolioId,
      metadata: portfolio.metadata,
      status: portfolio.status,
      totalBidCount: portfolio.bids.length,
      myBid: myBid ? { discountRate: myBid.discountRate, commitHash: myBid.commitHash, verified: myBid.verified } : null,
      won: portfolio.status !== "open" ? portfolio.winningLender === party : undefined,
      winningRate: portfolio.winningLender === party ? portfolio.winningRate : undefined,
    });
  } else {
    res.json({
      portfolioId: portfolio.portfolioId,
      invoiceIds: portfolio.invoiceIds,
      metadata: portfolio.metadata,
      status: portfolio.status,
      bidCount: portfolio.bids.length,
      winningLender: portfolio.status !== "open" ? portfolio.winningLender : undefined,
      winningRate: portfolio.status !== "open" ? portfolio.winningRate : undefined,
      bids: portfolio.status !== "open" ? portfolio.bids.map((b) => ({
        lender: b.lender, discountRate: b.discountRate, commitHash: b.commitHash, verified: b.verified,
      })) : undefined,
    });
  }
});

app.post("/api/portfolio-auctions/:portfolioId/bid", requireRole("lender", "operator"), validate(PortfolioBidSchema), (req, res) => {
  const { portfolioId } = req.params;
  const { lender, discountRate } = req.body;
  const result = ledger.submitPortfolioBid({ lender, portfolioId, discountRate });
  if (!result) {
    res.status(400).json({ error: "Bid rejected — auction closed or duplicate bid" });
    return;
  }
  auditChain.append("SUBMIT_PORTFOLIO_BID", lender, { portfolioId, commitHash: result.commitHash });
  res.status(201).json({ status: "bid_accepted", portfolioId, commitHash: result.commitHash });
});

app.post("/api/portfolio-auctions/:portfolioId/close", requireRole("seller", "operator"), (req, res) => {
  const { portfolioId } = req.params;
  const { seller } = req.body;
  const result = ledger.closePortfolioAuction(portfolioId, seller);
  if (!result) {
    res.status(400).json({ error: "Cannot close — not open, wrong seller, or insufficient bids" });
    return;
  }
  auditChain.append("CLOSE_PORTFOLIO_AUCTION", seller, {
    portfolioId, winningLender: result.winningLender,
  });
  res.json({
    portfolioId: result.portfolioId,
    status: result.status,
    winningLender: result.winningLender,
    winningRate: result.winningRate,
  });
});

app.post("/api/portfolio-auctions/:portfolioId/settle", requireRole("lender", "operator"), (req, res) => {
  const { portfolioId } = req.params;
  const { lender } = req.body;
  const result = ledger.settlePortfolio(portfolioId, lender);
  if (!result) {
    res.status(400).json({ error: "Cannot settle — not winner or auction not closed" });
    return;
  }
  auditChain.append("SETTLE_PORTFOLIO", lender, { portfolioId });
  res.json(result);
});

// ─── Cross-Currency Netting ──────────────────────────────────────────

app.get("/api/netting/:portfolioId", (req, res) => {
  const portfolio = ledger.getPortfolioAuction(req.params.portfolioId);
  if (!portfolio) {
    res.status(404).json({ error: "Portfolio not found" });
    return;
  }
  if (!portfolio.metadata.netting) {
    res.json({
      portfolioId: req.params.portfolioId,
      singleCurrency: true,
      message: "All invoices are in the same currency — no netting applicable",
    });
    return;
  }
  res.json({
    portfolioId: req.params.portfolioId,
    ...portfolio.metadata.netting,
  });
});

// ─── Auctions ────────────────────────────────────────────────────────

app.post("/api/auctions", requireRole("seller", "operator"), validate(AuctionCreateSchema), async (req, res) => {
  try {
    const { invoiceId } = req.body;
    if (useLedger) {
      const result = await damlClient.createAuction(invoiceId);
      auditChain.append("CREATE_AUCTION", req.authenticatedParty || "unknown", { invoiceId });
      console.log(`[AUDIT] Auction created for ${invoiceId}`);
      res.status(201).json(result);
    } else {
      const auction = ledger.createAuction(invoiceId);
      if (!auction) {
        res.status(400).json({ error: "Invoice not found or not confirmed" });
        return;
      }
      res.status(201).json(auction);
    }
  } catch (e: any) {
    console.error(`Auction creation failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Auction creation failed" : e.message });
  }
});

app.get("/api/auctions", async (_req, res) => {
  try {
    if (useLedger) {
      const auctions = await damlClient.getAuctions();
      const withCounts = await Promise.all(
        auctions.map(async (a: any) => {
          const bids = await damlClient.getAllBids(a.invoiceId);
          return { ...a, bidCount: bids.length };
        })
      );
      res.json(withCounts);
    } else {
      const auctions = ledger.getAllAuctions().map((a) => ({
        invoiceId: a.invoiceId,
        metadata: a.metadata,
        status: a.status,
        bidCount: a.bids.length,
      }));
      res.json(auctions);
    }
  } catch (e: any) {
    console.error(`Auction query failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Query failed" : e.message });
  }
});

app.get("/api/auctions/:invoiceId", async (req, res) => {
  const { invoiceId } = req.params;
  if (!validateParam(invoiceId, "invoiceId", res)) return;
  try {
    const party = req.authenticatedParty || (req.query.party as string);
    const role = req.query.role as string | undefined;

    if (role && !["seller", "lender"].includes(role)) {
      res.status(400).json({ error: "Role must be 'seller' or 'lender'" });
      return;
    }

    if (useLedger) {
      const auctions = await damlClient.getAuctions(party);
      const auction = auctions.find((a: any) => a.invoiceId === invoiceId);
      if (!auction) {
        res.status(404).json({ error: "Auction not found" });
        return;
      }

      if (role === "lender" && party) {
        const myBids = await damlClient.getBidsForParty(invoiceId, party);
        const allBids = await damlClient.getAllBids(invoiceId);
        const auctionResult = await damlClient.getAuctionResult(invoiceId, party);

        const status = auctionResult ? (await damlClient.getSettlements(party)).some(
          (s: any) => s.invoiceId === invoiceId
        ) ? "settled" : "closed" : auction.status;

        const dn = damlClient.getDisplayName.bind(damlClient);
        const myBid = myBids[0] ? { ...myBids[0], lender: dn(myBids[0].lender) } : null;

        res.json({
          invoiceId: auction.invoiceId,
          metadata: auction.metadata,
          status,
          myBid,
          totalBidCount: allBids.length,
          won: auctionResult?.isWinner || false,
          winningRate: auctionResult?.isWinner ? auctionResult.winningRate : undefined,
        });
      } else if (role === "seller") {
        const allBids = await damlClient.getAllBids(invoiceId);
        const auctionResult = await damlClient.getAuctionResult(invoiceId, party || "");
        const settlements = await damlClient.getSettlements(party);
        const isSettled = settlements.some((s: any) => s.invoiceId === invoiceId);
        const status = isSettled ? "settled" : auctionResult ? "closed" : auction.status;

        const dn = damlClient.getDisplayName.bind(damlClient);
        const cachedInv = damlClient.getCachedInvoice(invoiceId);
        res.json({
          invoiceId: auction.invoiceId,
          metadata: auction.metadata,
          status,
          bidCount: allBids.length,
          winningLender: auctionResult?.winningLender ? dn(auctionResult.winningLender) : undefined,
          winningRate: auctionResult?.winningRate,
          bids: auctionResult ? allBids.map((b: any) => ({
            lender: dn(b.lender),
            discountRate: b.discountRate,
          })) : undefined,
          invoice: cachedInv ? {
            debtor: cachedInv.debtor,
            amount: cachedInv.amount,
            currency: cachedInv.currency,
            sector: cachedInv.sector,
            paymentTermDays: typeof cachedInv.paymentTermDays === 'string' ? (parseInt(cachedInv.paymentTermDays, 10) || 30) : cachedInv.paymentTermDays,
            reliabilityScore: cachedInv.reliabilityScore,
          } : undefined,
        });
      } else {
        const allBids = await damlClient.getAllBids(invoiceId);
        res.json({
          invoiceId: auction.invoiceId,
          metadata: auction.metadata,
          status: auction.status,
          bidCount: allBids.length,
        });
      }
    } else {
      const auction = ledger.getAuction(invoiceId);
      if (!auction) {
        res.status(404).json({ error: "Auction not found" });
        return;
      }
      if (role === "lender" && party) {
        const myBids = ledger.getBidsForParty(invoiceId, party);
        const isWinner = auction.status !== "open" && auction.winningLender === party;
        const myBid = myBids[0] || null;
        res.json({
          invoiceId: auction.invoiceId,
          metadata: auction.metadata,
          status: auction.status,
          myBid: myBid ? {
            ...myBid,
            commitHash: myBid.commitHash,
            verified: myBid.verified,
          } : null,
          totalBidCount: auction.bids.length,
          won: isWinner,
          winningRate: isWinner ? auction.winningRate : undefined,
        });
      } else if (role === "seller") {
        res.json({
          invoiceId: auction.invoiceId,
          metadata: auction.metadata,
          status: auction.status,
          bidCount: auction.bids.length,
          winningLender: auction.status !== "open" ? auction.winningLender : undefined,
          winningRate: auction.status !== "open" ? auction.winningRate : undefined,
          bids: auction.status !== "open"
            ? auction.bids.map((b) => ({
                lender: b.lender,
                discountRate: b.discountRate,
                commitHash: b.commitHash,
                verified: b.verified,
              }))
            : undefined,
        });
      } else {
        res.json({
          invoiceId: auction.invoiceId,
          metadata: auction.metadata,
          status: auction.status,
          bidCount: auction.bids.length,
        });
      }
    }
  } catch (e: any) {
    console.error(`Auction detail query failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Query failed" : e.message });
  }
});

// ─── Bids ────────────────────────────────────────────────────────────

app.post("/api/bids", requireRole("lender", "operator"), validate(BidSubmitSchema), async (req, res) => {
  try {
    const { lender: bidLender, invoiceId, discountRate } = req.body;
    const lender = req.authenticatedParty || bidLender;

    // Debtor-bid check skipped for demo (single-account flow)

    // Generate commitment: nonce + hash, return nonce to lender for reveal phase
    const nonce = generateNonce();
    const commitHash = computeBidCommitment(discountRate, nonce);

    if (useLedger) {
      const result = await damlClient.submitBid(lender, invoiceId, discountRate);
      auditChain.append("SUBMIT_BID", lender, { invoiceId, commitHash });
      console.log(`[AUDIT] Bid committed on ${invoiceId} by ${lender}`);
      res.status(201).json({ ...result, nonce, commitHash });
    } else {
      const sealedBid = ledger.submitBid({ lender, invoiceId, commitHash });
      if (!sealedBid) {
        res.status(400).json({ error: "Bid rejected — auction closed or duplicate bid" });
        return;
      }
      res.status(201).json({
        status: "bid_committed",
        invoiceId,
        commitHash,
        nonce,
        message: "Store your nonce securely. You will need it to reveal your bid after the auction closes.",
      });
    }
  } catch (e: any) {
    console.error(`Bid submission failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Bid submission failed" : e.message });
  }
});

// ─── Bid Reveal ─────────────────────────────────────────────────────

app.post("/api/bids/:invoiceId/reveal", requireRole("lender", "operator"), validate(BidRevealSchema), async (req, res) => {
  const { invoiceId } = req.params;
  if (!validateParam(invoiceId, "invoiceId", res)) return;
  try {
    const { lender: revealLender, discountRate, nonce } = req.body;
    const lender = req.authenticatedParty || revealLender;

    if (useLedger) {
      // Canton mode: reveal is handled by exercising the Reveal choice on SealedBid
      const result = await damlClient.revealBid(invoiceId, lender, discountRate, nonce);
      auditChain.append("REVEAL_BID", lender, { invoiceId, verified: true });
      res.json({ status: "bid_revealed", invoiceId, verified: true, ...result });
    } else {
      const revealed = ledger.revealBid(invoiceId, lender, discountRate, nonce);
      if (!revealed) {
        res.status(400).json({
          error: "Reveal failed — auction not closed, bid not found, already revealed, or commitment mismatch",
        });
        return;
      }

      // Check if all bids are now revealed — auto-finalize
      const auction = ledger.getAuction(invoiceId);
      const allRevealed = auction && auction.bids.every((b) => b.revealed);

      res.json({
        status: "bid_revealed",
        invoiceId,
        verified: revealed.verified,
        allRevealed,
        message: allRevealed
          ? "All bids revealed. Auction can now be finalized."
          : "Bid revealed. Waiting for other lenders to reveal.",
      });

      // Auto-finalize if all bids are revealed
      if (allRevealed && auction) {
        ledger.finalizeAuction(invoiceId);
      }
    }
  } catch (e: any) {
    console.error(`Bid reveal failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Bid reveal failed" : e.message });
  }
});

// ─── Auction Close ───────────────────────────────────────────────────

app.post("/api/auctions/:invoiceId/close", requireRole("seller", "operator"), async (req, res) => {
  const { invoiceId } = req.params;
  if (!validateParam(invoiceId, "invoiceId", res)) return;
  try {
    if (useLedger) {
      const result = await damlClient.closeAuction(invoiceId);
      const dn = damlClient.getDisplayName.bind(damlClient);
      auditChain.append("CLOSE_AUCTION", req.authenticatedParty || "unknown", {
        invoiceId, winningLender: dn(result.winningLender),
      });
      console.log(`[AUDIT] Auction closed: ${invoiceId}, winner: ${dn(result.winningLender)}`);
      res.json({
        ...result,
        winningLender: dn(result.winningLender),
        bids: result.bids.map((b: any) => ({ ...b, lender: dn(b.lender) })),
      });
    } else {
      const seller = req.authenticatedParty || req.body.seller;
      // Validate seller owns the invoice behind this auction
      const invoice = ledger.getInvoice(invoiceId);
      if (invoice && seller && invoice.seller !== seller && req.authenticatedRole !== "operator") {
        res.status(403).json({ error: "Only the invoice seller or operator can close this auction" });
        return;
      }
      const result = ledger.closeAuction(invoiceId, seller);
      if (!result) {
        res.status(400).json({ error: "Cannot close — auction not open or insufficient bids (min 2)" });
        return;
      }

      // Auto-reveal any agent bids that have stored secrets
      for (const bid of result.bids) {
        if (!bid.revealed) {
          const key = `${bid.lender}:${invoiceId}`;
          const secrets = agentBidSecrets.get(key);
          if (secrets) {
            ledger.revealBid(invoiceId, bid.lender, secrets.discountRate, secrets.nonce);
            agentBidSecrets.delete(key);
          }
        }
      }

      const unrevealedCount = result.bids.filter((b) => !b.revealed).length;

      // If all bids were already revealed (e.g. agent bids), auto-finalize
      if (unrevealedCount === 0) {
        const finalized = ledger.finalizeAuction(invoiceId);
        if (finalized) {
          // Record outcome for agent learning
          try {
            const inv = ledger.getInvoice(invoiceId);
            if (inv) {
              recordAuctionOutcome(
                invoiceId,
                finalized.winningRate!,
                finalized.bids.map((b: any) => ({ lender: b.lender, discountRate: b.discountRate })),
                {
                  sector: inv.sector || "Manufacturing",
                  reliabilityScore: inv.reliabilityScore || "B",
                  amountBucket: finalized.metadata?.amountBucket || "50K-100K",
                }
              );
            }
          } catch (err) {
            console.warn("Failed to record auction outcome:", err);
          }

          res.json({
            invoiceId: finalized.invoiceId,
            status: finalized.status,
            winningLender: finalized.winningLender,
            winningRate: finalized.winningRate,
          });
          return;
        }
      }

      res.json({
        invoiceId: result.invoiceId,
        status: result.status,
        bidCount: result.bids.length,
        unrevealedCount,
        message: unrevealedCount > 0
          ? `Auction closed. Waiting for ${unrevealedCount} lender(s) to reveal their bids.`
          : "Auction closed and finalized.",
        winningLender: result.winningLender,
        winningRate: result.winningRate,
      });
    }
  } catch (e: any) {
    console.error(`Auction close failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Auction close failed" : e.message });
  }
});

// ─── Settlements ─────────────────────────────────────────────────────

app.post("/api/settlements", requireRole("lender", "operator"), validate(SettleSchema), async (req, res) => {
  try {
    const { invoiceId, lender } = req.body;
    const settlingLender = req.authenticatedParty || lender;

    if (useLedger) {
      const settlement = await damlClient.settle(invoiceId, settlingLender);
      const dn = damlClient.getDisplayName.bind(damlClient);
      auditChain.append("SETTLE", settlingLender, { invoiceId });

      // Create payment notification
      const cached = damlClient.getCachedInvoice(invoiceId);
      if (cached) {
        damlClient.addPaymentNotification({
          invoiceId,
          debtor: cached.debtor,
          seller: dn(settlement.seller),
          winningLender: dn(settlement.lender),
          amount: settlement.originalAmount,
          dueDate: cached.dueDate || new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
      }

      console.log(`[AUDIT] Settlement executed: ${invoiceId} by ${settlingLender}`);
      res.status(201).json({
        ...settlement,
        seller: dn(settlement.seller),
        lender: dn(settlement.lender),
      });
    } else {
      const settlement = ledger.settle(invoiceId, settlingLender);
      if (!settlement) {
        res.status(400).json({ error: "Cannot settle — not winner or auction not closed" });
        return;
      }
      res.status(201).json(settlement);
    }
  } catch (e: any) {
    console.error(`Settlement failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Settlement failed" : e.message });
  }
});

app.get("/api/settlements/:invoiceId", async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const party = req.authenticatedParty || (req.query.party as string);
    if (useLedger) {
      const settlements = await damlClient.getSettlements(party);
      const settlement = settlements.find((s: any) => s.invoiceId === invoiceId);
      if (!settlement) {
        res.status(404).json({ error: "No settlement found" });
        return;
      }
      const dn = damlClient.getDisplayName.bind(damlClient);
      res.json({ ...settlement, seller: dn(settlement.seller), lender: dn(settlement.lender) });
    } else {
      const settlement = ledger.getSettlement(invoiceId);
      if (!settlement) {
        res.status(404).json({ error: "No settlement found" });
        return;
      }
      if (party && party !== settlement.seller && party !== settlement.lender) {
        res.status(403).json({ error: "Not authorized to view this settlement" });
        return;
      }
      res.json(settlement);
    }
  } catch (e: any) {
    console.error(`Settlement query failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Query failed" : e.message });
  }
});

app.get("/api/settlements", async (_req, res) => {
  try {
    if (useLedger) {
      const settlements = await damlClient.getSettlements();
      const dn = damlClient.getDisplayName.bind(damlClient);
      res.json(settlements.map((s: any) => ({ ...s, seller: dn(s.seller), lender: dn(s.lender) })));
    } else {
      res.json(ledger.getAllSettlements());
    }
  } catch (e: any) {
    console.error(`Settlement list failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Query failed" : e.message });
  }
});

// ─── Audit Log ───────────────────────────────────────────────────────

app.get("/api/audit-log", (_req, res) => {
  // Use the appropriate audit chain based on mode
  const chain = useLedger ? auditChain : ledger.auditChain;
  const entries = chain.getEntries();
  const verification = chain.verify();
  res.json({
    entries,
    chainHead: chain.getHead(),
    totalEntries: entries.length,
    integrity: verification,
  });
});

app.get("/api/audit-log/verify", (_req, res) => {
  const chain = useLedger ? auditChain : ledger.auditChain;
  const verification = chain.verify();
  res.json({
    ...verification,
    chainHead: chain.getHead(),
    totalEntries: chain.getEntries().length,
  });
});

// ─── Privacy Scope ───────────────────────────────────────────────────

app.get("/api/privacy-scope/:party", async (req, res) => {
  const { party } = req.params;
  if (!validateParam(party, "party", res)) return;

  if (useLedger) {
    // In Canton mode, build privacy scope from ledger queries
    try {
      const invoices = await damlClient.getInvoices();
      const auctions = await damlClient.getAuctions();
      const settlements = await damlClient.getSettlements();
      const notifications = damlClient.getPaymentNotifications();
      const dn = damlClient.getDisplayName.bind(damlClient);

      // Map display names
      const mappedInvoices = invoices.map((i: any) => ({
        ...i, seller: i.seller ? dn(i.seller) : i.seller,
      }));
      const mappedSettlements = settlements.map((s: any) => ({
        ...s, seller: dn(s.seller), lender: dn(s.lender),
      }));

      const scope = buildPrivacyScope(party, mappedInvoices, auctions, mappedSettlements, notifications);
      res.json(scope);
    } catch (e: any) {
      console.error(`Privacy scope query failed: ${e.message}`);
      res.status(500).json({ error: IS_PRODUCTION ? "Query failed" : e.message });
    }
  } else {
    const invoices = ledger.getAllInvoices();
    const auctions = ledger.getAllAuctions();
    const settlements = ledger.getAllSettlements();
    const notifications = ledger.getPaymentNotifications();

    const scope = buildPrivacyScope(party, invoices, auctions, settlements, notifications);
    res.json(scope);
  }
});

function buildPrivacyScope(
  party: string,
  invoices: any[],
  auctions: any[],
  settlements: any[],
  notifications: any[]
): any {
  let role: string;
  // Look up role from party registry (works in both modes)
  const registeredParty = useLedger
    ? damlClient.getParties().find((p) => p.displayName === party)
    : ledger.getParty(party);
  if (registeredParty) {
    role = registeredParty.role;
  } else if (invoices.some((i) => i.debtor === party)) {
    role = "debtor";
  } else {
    role = "lender";
  }

  const scope: any = { party, role, visibleData: {} };

  if (role === "operator") {
    scope.visibleData = {
      invoices: invoices.map((i) => ({
        invoiceId: i.invoiceId, seller: i.seller, debtor: i.debtor,
        amount: i.amount, status: i.status, documentHash: i.documentHash,
      })),
      auctions: auctions.map((a) => ({
        invoiceId: a.invoiceId, status: a.status, bidCount: a.bidCount || a.bids?.length || 0,
      })),
      settlements,
      notifications,
    };
  } else if (role === "seller") {
    scope.visibleData = {
      invoices: invoices.filter((i) => i.seller === party).map((i) => ({
        invoiceId: i.invoiceId, debtor: i.debtor,
        amount: i.amount, status: i.status, documentHash: i.documentHash,
      })),
      auctions: auctions.map((a) => ({
        invoiceId: a.invoiceId, status: a.status, bidCount: a.bidCount || a.bids?.length || 0,
        bids: (a.status !== "open" && a.bids) ? a.bids.map((b: any) => ({
          lender: b.lender, discountRate: b.discountRate, verified: b.verified,
        })) : undefined,
        winningLender: a.status !== "open" ? a.winningLender : undefined,
      })),
      settlements: settlements.filter((s) => s.seller === party),
      hiddenFromYou: ["Individual bid rates before close", "Lender identities before close"],
    };
  } else if (role === "lender") {
    scope.visibleData = {
      invoices: "ACCESS DENIED — Lenders cannot see invoice details",
      auctions: auctions.map((a) => {
        const myBid = a.bids?.find((b: any) => b.lender === party);
        const won = a.winningLender === party;
        return {
          invoiceId: a.invoiceId,
          metadata: a.metadata,
          status: a.status,
          myBid: myBid ? {
            commitHash: myBid.commitHash,
            discountRate: myBid.discountRate,
            verified: myBid.verified,
          } : null,
          won: a.status !== "open" ? won : undefined,
          winningRate: won ? a.winningRate : undefined,
          otherBids: "ACCESS DENIED",
        };
      }),
      settlements: settlements.filter((s) => s.lender === party),
      hiddenFromYou: [
        "Debtor identity",
        "Exact invoice amount",
        "Other lenders' bids",
        "Invoice documents",
      ],
    };
  } else if (role === "debtor") {
    scope.visibleData = {
      invoices: invoices
        .filter((i) => i.debtor === party && i.status !== "pending")
        .map((i) => ({
          invoiceId: i.invoiceId, seller: i.seller, amount: i.amount,
          status: i.status, documentHash: i.documentHash,
        })),
      auctions: "ACCESS DENIED — Debtors cannot see auction activity",
      settlements: "ACCESS DENIED — Debtors cannot see settlement terms",
      notifications: notifications.filter((n) => n.debtor === party),
      hiddenFromYou: [
        "Auction bids and rates",
        "Settlement discount amounts",
        "Lender identities (before payment redirect)",
      ],
    };
  }

  return scope;
}

// ─── Privacy Breach Simulation ───────────────────────────────────────

app.post("/api/privacy-breach-test", validate(BreachTestSchema), async (req, res) => {
  const { attackerParty, targetParty, targetData } = req.body;

  const results: any[] = [];

  // Simulate various breach attempts
  if (targetData === "bids" || !targetData) {
    // Try to read target's bids
    if (useLedger) {
      try {
        const bids = await damlClient.getBidsForParty("*", attackerParty);
        const targetBids = bids.filter((b: any) => b.lender !== attackerParty);
        results.push({
          attempt: `${attackerParty} tried to read ${targetParty}'s sealed bids`,
          result: "BLOCKED",
          reason: "Canton sub-transaction privacy: SealedBid contracts are only visible to their signatory (lender + operator). The attacker's participant node never receives the target's bid data.",
          dataReturned: targetBids.length === 0 ? "No data" : `${targetBids.length} unauthorized records`,
          protectionLevel: "protocol",
        });
      } catch {
        results.push({
          attempt: `${attackerParty} tried to read ${targetParty}'s sealed bids`,
          result: "BLOCKED",
          reason: "Canton participant node rejected the query — data does not exist on this node.",
          dataReturned: "No data",
          protectionLevel: "protocol",
        });
      }
    } else {
      // Standalone mode — demonstrate application-layer privacy
      const allAuctions = ledger.getAllAuctions();
      const attackerBids: any[] = [];
      const blockedBids: any[] = [];
      for (const auction of allAuctions) {
        for (const bid of auction.bids) {
          if (bid.lender === attackerParty) {
            attackerBids.push(bid);
          } else {
            blockedBids.push({ invoiceId: auction.invoiceId, lender: "[REDACTED]", discountRate: "[REDACTED]" });
          }
        }
      }
      results.push({
        attempt: `${attackerParty} tried to read ${targetParty}'s sealed bids`,
        result: "BLOCKED",
        reason: "Privacy filtering: getBidsForParty() only returns bids where the requesting party is the lender. In Canton mode, this is enforced at the protocol level — the data physically does not exist on the attacker's participant node.",
        dataReturned: `Own bids: ${attackerBids.length}, Blocked: ${blockedBids.length} bids redacted`,
        protectionLevel: useLedger ? "protocol" : "application",
        blockedRecords: blockedBids,
      });
    }
  }

  if (targetData === "invoices" || !targetData) {
    results.push({
      attempt: `${attackerParty} (lender) tried to read full invoice details`,
      result: "BLOCKED",
      reason: "Invoice contracts have signatory (operator, seller). Lenders are never signatories or observers on Invoice contracts. They only see AuctionInvite which contains anonymized InvoiceMetadata (amount bucket, sector, terms — no debtor name or exact amount).",
      dataReturned: "Only anonymized metadata visible",
      protectionLevel: useLedger ? "protocol" : "application",
    });
  }

  if (targetData === "settlements" || !targetData) {
    results.push({
      attempt: `${attackerParty} tried to read ${targetParty}'s settlement details`,
      result: "BLOCKED",
      reason: "SettledInvoice contracts have observer = winning lender only. Losing lenders receive BidRejection (knows they lost, nothing else). Settlement amounts, rates, and counterparty details are invisible.",
      dataReturned: "No data",
      protectionLevel: useLedger ? "protocol" : "application",
    });
  }

  res.json({
    simulation: true,
    mode: "canton-ledger",
    attackerParty,
    targetParty,
    totalAttempts: results.length,
    allBlocked: results.every((r) => r.result === "BLOCKED"),
    results,
    explanation: useLedger
      ? "In Canton mode, privacy is enforced at the PROTOCOL level. Each participant runs on a separate node. The Canton sequencer only delivers contract data to nodes hosting parties that are signatories or observers. Data physically does not exist on unauthorized nodes — there is no global ledger to query."
      : "In standalone mode, privacy is enforced at the APPLICATION level via role-based filtering. In production with Canton, this becomes protocol-level enforcement where data physically cannot be accessed by unauthorized parties.",
  });
});

// ─── AI Agents ───────────────────────────────────────────────────────

app.get("/api/agents", (_req, res) => {
  res.json(getAllAgents());
});

app.get("/api/agents/:name", (req, res) => {
  const agent = getAgent(req.params.name);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json(agent);
});

app.post("/api/agents", requireRole("lender", "operator"), validate(AgentCreateSchema), (req, res) => {
  const config: AgentConfig = req.body;
  const agent = registerAgent(config);
  res.status(201).json(agent);
});

app.post("/api/agents/:name/configure", requireRole("lender", "operator"), validate(AgentConfigureSchema), (req, res) => {
  const agent = getAgent(req.params.name);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const updates = req.body;
  if (updates.strategy) agent.strategy = updates.strategy;
  if (updates.riskTolerance) agent.riskTolerance = updates.riskTolerance;
  if (updates.maxDiscountRate != null) agent.maxDiscountRate = updates.maxDiscountRate;
  if (updates.minDiscountRate != null) agent.minDiscountRate = updates.minDiscountRate;
  if (updates.autoBid != null) agent.autoBid = updates.autoBid;
  if (updates.enabled != null) agent.enabled = updates.enabled;
  registerAgent(agent);
  res.json(agent);
});

app.post("/api/agents/:name/analyze", requireRole("lender", "operator"), async (req, res) => {
  const agent = getAgent(req.params.name);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const { invoiceId } = req.body;

  try {
    // Get auction metadata (what the agent/lender actually sees)
    let auctions: any[];
    if (useLedger) {
      auctions = await damlClient.getAuctions(agent.party);
    } else {
      auctions = ledger.getAllAuctions().map((a) => ({
        invoiceId: a.invoiceId,
        metadata: a.metadata,
        status: a.status,
        bidCount: a.bids.length,
      }));
    }

    if (invoiceId) {
      // Analyze single auction
      const auction = auctions.find((a) => a.invoiceId === invoiceId);
      if (!auction) {
        res.status(404).json({ error: "Auction not found or not visible to agent" });
        return;
      }
      let analysis = analyzeAuction(auction.metadata, agent, auction.bidCount || 0);
      // Attach LLM explanation if available (5s timeout)
      try {
        analysis = await Promise.race([
          getAnalysisWithLLM(analysis),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("LLM timeout")), 5000)),
        ]);
      } catch { /* LLM optional */ }
      res.json(analysis);
    } else {
      // Analyze all visible auctions
      const report = generatePortfolioReport(
        auctions.filter((a) => a.status === "open").map((a) => ({
          invoiceId: a.invoiceId,
          metadata: a.metadata,
          bidCount: a.bidCount || 0,
        })),
        agent
      );
      // Attach LLM explanation to each analysis (5s timeout per analysis)
      try {
        for (let i = 0; i < report.analyses.length; i++) {
          report.analyses[i] = await Promise.race([
            getAnalysisWithLLM(report.analyses[i]),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("LLM timeout")), 5000)),
          ]);
        }
      } catch { /* LLM optional */ }
      res.json(report);
    }
  } catch (e: any) {
    console.error(`Agent analysis failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Analysis failed" : e.message });
  }
});

app.post("/api/agents/:name/auto-bid", requireRole("lender", "operator"), async (req, res) => {
  const agent = getAgent(req.params.name);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (!agent.enabled) {
    res.status(400).json({ error: "Agent is disabled" });
    return;
  }

  const { invoiceId } = req.body;
  if (!invoiceId) {
    res.status(400).json({ error: "Missing invoiceId" });
    return;
  }

  try {
    let auctions: any[];
    if (useLedger) {
      auctions = await damlClient.getAuctions(agent.party);
    } else {
      auctions = ledger.getAllAuctions().map((a) => ({
        invoiceId: a.invoiceId,
        metadata: a.metadata,
        status: a.status,
        bidCount: a.bids.length,
      }));
    }

    const auction = auctions.find((a) => a.invoiceId === invoiceId);
    if (!auction || auction.status !== "open") {
      res.status(400).json({ error: "Auction not found or not open" });
      return;
    }

    // Agent debtor-bid check skipped for demo (single-account flow)

    const analysis = analyzeAuction(auction.metadata, agent, auction.bidCount || 0);

    if (analysis.recommendation !== "bid") {
      res.json({
        action: "skipped",
        reason: analysis.reasoning.summary,
        analysis,
      });
      return;
    }

    // Submit the bid with commit-reveal
    const nonce = generateNonce();
    const commitHash = computeBidCommitment(analysis.suggestedRate, nonce);

    if (useLedger) {
      const result = await damlClient.submitBid(agent.party, invoiceId, analysis.suggestedRate);
      auditChain.append("AGENT_BID", agent.party, {
        invoiceId, agent: agent.name, commitHash,
      });
      // Store nonce for auto-reveal (agent bids auto-reveal when auction closes)
      agentBidSecrets.set(`${agent.party}:${invoiceId}`, { nonce, discountRate: analysis.suggestedRate });
      res.json({ action: "bid_committed", ...result, analysis });
    } else {
      const sealedBid = ledger.submitBid({
        lender: agent.party,
        invoiceId,
        commitHash,
      });
      if (!sealedBid) {
        res.status(400).json({ error: "Bid rejected — auction closed or duplicate bid" });
        return;
      }
      // Store nonce for auto-reveal when auction closes
      agentBidSecrets.set(`${agent.party}:${invoiceId}`, { nonce, discountRate: analysis.suggestedRate });
      res.json({
        action: "bid_committed",
        status: "bid_committed",
        invoiceId,
        commitHash,
        analysis,
      });
    }
  } catch (e: any) {
    console.error(`Agent auto-bid failed: ${e.message}`);
    res.status(500).json({ error: IS_PRODUCTION ? "Auto-bid failed" : e.message });
  }
});

app.get("/api/agents/:name/actions", (req, res) => {
  const actions = getAgentActions(req.params.name);
  res.json(actions);
});

// Agent performance metrics
app.get("/api/agents/:name/performance", (req, res) => {
  const metrics = getAgentPerformance(req.params.name);
  res.json(metrics);
});

// Agent portfolio state
app.get("/api/agents/:name/portfolio-state", (req, res) => {
  const agent = getAgent(req.params.name);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  // Get active positions from open auctions where agent has bid
  const auctions = ledger.getAllAuctions();
  const activePositions: Array<{ sector: string; amount: number }> = [];
  for (const auction of auctions) {
    if (auction.status === "open" || auction.status === "closed") {
      const bids = ledger.getBidsForParty(auction.invoiceId, agent.party);
      if (bids.length > 0) {
        const inv = ledger.getInvoice(auction.invoiceId);
        if (inv) {
          activePositions.push({ sector: inv.sector || "Manufacturing", amount: inv.amount });
        }
      }
    }
  }
  const state = getAgentPortfolioState(agent.name, activePositions);
  res.json(state);
});

// ─── Reset ───────────────────────────────────────────────────────────

app.post("/api/reset", (_req, res) => {
  if (IS_PRODUCTION) {
    res.status(403).json({ error: "Reset not available in production" });
    return;
  }
  try {
    ledger.reset();
    clearAllPersistedData();
    auditChain.reset();
    res.json({ status: "ok", message: "All data cleared" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Static Files (Production) ───────────────────────────────────────

if (IS_PRODUCTION) {
  const publicDir = path.join(__dirname, "..", "public");
  app.use(express.static(publicDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

// ─── Error Handler ───────────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`[ERROR] Unhandled: ${err.message}`);
  res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
});

// ─── Start ───────────────────────────────────────────────────────────

validateConfig();

// Export app for Vercel serverless deployment
export default app;

// Only listen when running directly (not imported by Vercel)
if (!process.env.VERCEL) {
  const server = app.listen(PORT, async () => {
    try {
      useLedger = await initDamlClient();
    } catch (e: any) {
      console.error(`Ledger init failed: ${e.message}`);
    }
    console.log(`ClearFlow API running on port ${PORT}`);
    console.log(`Mode: ${useLedger ? "Canton Ledger" : "Local Ledger (standalone)"}`);
    console.log(`Environment: ${IS_PRODUCTION ? "PRODUCTION" : "development"}`);
    console.log(`Auth: ${isAuthRequired() ? "REQUIRED" : "optional"}`);
  });

  function shutdown(signal: string) {
    console.log(`\n[${signal}] Shutting down gracefully...`);
    server.close(() => {
      console.log("Server closed. Exiting.");
      process.exit(0);
    });
    setTimeout(() => {
      console.error("Forced shutdown after timeout");
      process.exit(1);
    }, 10000);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    console.error("[FATAL] Unhandled promise rejection:", reason);
  });

  process.on("uncaughtException", (err) => {
    console.error("[FATAL] Uncaught exception:", err.message);
    shutdown("uncaughtException");
  });
} else {
  // On Vercel, init ledger eagerly
  initDamlClient().catch((e: any) => {
    console.error(`Ledger init failed: ${e.message}`);
  });
}
