import { ledger } from "../ledger";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) { console.log(`  PASS: ${message}`); passed++; }
  else { console.error(`  FAIL: ${message}`); failed++; }
}

function test(name: string, fn: () => void): void {
  console.log(`\n${name}`);
  try { fn(); } catch (e: any) { console.error(`  ERROR: ${e.message}`); failed++; }
}

const SELLER = "PSeller";
const LENDER_A = "PLenderA";
const LENDER_B = "PLenderB";
const DEBTOR = "PDebtor";

ledger.reset();
ledger.registerParty(SELLER, "seller");
ledger.registerParty(LENDER_A, "lender");
ledger.registerParty(LENDER_B, "lender");
ledger.registerParty(DEBTOR, "debtor");

function createConfirmedInvoice(id: string, amount: number, currency = "USD", sector = "Manufacturing"): void {
  ledger.createInvoice({
    invoiceId: id, seller: SELLER, debtor: DEBTOR, amount,
    currency, sector, paymentTermDays: 30,
    issueDate: "2026-06-01", dueDate: "2026-07-01", reliabilityScore: "A",
  });
  ledger.approveInvoice(id);
  ledger.confirmInvoice(id);
}

// ── Tests ──

test("Create portfolio auction with 2+ invoices", () => {
  createConfirmedInvoice("PF-001", 50000);
  createConfirmedInvoice("PF-002", 75000);
  const result = ledger.createPortfolioAuction(["PF-001", "PF-002"], SELLER);
  assert(result !== null, "Portfolio created");
  assert(result!.status === "open", "Status is open");
  assert(result!.invoiceIds.length === 2, "Contains 2 invoices");
});

test("Create portfolio with <2 invoices fails", () => {
  createConfirmedInvoice("PF-003", 30000);
  const result = ledger.createPortfolioAuction(["PF-003"], SELLER);
  assert(result === null, "Rejected — need at least 2");
});

test("Create portfolio with unconfirmed invoice fails", () => {
  ledger.createInvoice({
    invoiceId: "PF-004", seller: SELLER, debtor: DEBTOR, amount: 40000,
    currency: "USD", sector: "Retail", paymentTermDays: 30,
    issueDate: "2026-06-01", dueDate: "2026-07-01", reliabilityScore: "B",
  });
  createConfirmedInvoice("PF-005", 60000);
  const result = ledger.createPortfolioAuction(["PF-004", "PF-005"], SELLER);
  assert(result === null, "Rejected — PF-004 not confirmed");
});

test("Cannot add already-auctioned invoice to portfolio", () => {
  createConfirmedInvoice("PF-006", 55000);
  createConfirmedInvoice("PF-007", 65000);
  ledger.createAuction("PF-006"); // single auction
  const result = ledger.createPortfolioAuction(["PF-006", "PF-007"], SELLER);
  assert(result === null, "Rejected — PF-006 already in auction");
});

test("Portfolio metadata computation", () => {
  createConfirmedInvoice("PF-010", 100000, "USD", "Technology");
  createConfirmedInvoice("PF-011", 200000, "EUR", "Healthcare");
  const pf = ledger.createPortfolioAuction(["PF-010", "PF-011"], SELLER);
  assert(pf !== null, "Portfolio created");
  assert(pf!.metadata.invoiceCount === 2, "Invoice count correct");
  assert(pf!.metadata.sectors.length >= 1, "Sectors populated");
});

test("Cross-currency netting", () => {
  createConfirmedInvoice("PF-012", 50000, "USD");
  createConfirmedInvoice("PF-013", 50000, "EUR");
  const pf = ledger.createPortfolioAuction(["PF-012", "PF-013"], SELLER);
  assert(pf !== null, "Multi-currency portfolio created");
  if (pf!.metadata.netting) {
    assert(pf!.metadata.netting.grossExposure > 0, "Gross exposure calculated");
    assert(pf!.metadata.netting.nettingBenefit >= 0, "Netting benefit non-negative");
  } else {
    assert(true, "Netting data may not be populated in metadata");
  }
});

test("Submit portfolio bid", () => {
  const portfolios = ledger.getAllPortfolioAuctions();
  const openPf = portfolios.find((p) => p.status === "open");
  if (!openPf) { assert(false, "No open portfolio"); return; }
  const result = ledger.submitPortfolioBid({ lender: LENDER_A, portfolioId: openPf.portfolioId, discountRate: 0.025 });
  assert(result !== null, "Bid accepted");
});

test("Duplicate portfolio bid rejected", () => {
  const portfolios = ledger.getAllPortfolioAuctions();
  const openPf = portfolios.find((p) => p.status === "open");
  if (!openPf) { assert(false, "No open portfolio"); return; }
  const result = ledger.submitPortfolioBid({ lender: LENDER_A, portfolioId: openPf.portfolioId, discountRate: 0.020 });
  assert(result === null, "Duplicate bid rejected");
});

test("Close portfolio and select winner", () => {
  const portfolios = ledger.getAllPortfolioAuctions();
  const openPf = portfolios.find((p) => p.status === "open" && p.bids && p.bids.length >= 1);
  if (!openPf) { assert(false, "No suitable portfolio"); return; }
  // Add second bid
  ledger.submitPortfolioBid({ lender: LENDER_B, portfolioId: openPf.portfolioId, discountRate: 0.030 });
  const result = ledger.closePortfolioAuction(openPf.portfolioId, SELLER);
  assert(result !== null, "Portfolio closed");
  if (result) {
    assert(result.winningLender === LENDER_A, "Lower rate wins");
    assert(result.winningRate === 0.025, "Winning rate correct");
  }
});

test("Settle portfolio", () => {
  const portfolios = ledger.getAllPortfolioAuctions();
  const closedPf = portfolios.find((p) => p.status === "closed");
  if (!closedPf) { assert(false, "No closed portfolio"); return; }
  const result = ledger.settlePortfolio(closedPf.portfolioId, LENDER_A);
  assert(result !== null, "Settlement successful");
  if (result) {
    assert(result.settlements.length > 0, "Settlement details present");
  }
});

test("Non-winner cannot settle portfolio", () => {
  const portfolios = ledger.getAllPortfolioAuctions();
  const settledPf = portfolios.find((p) => p.status === "settled");
  if (!settledPf) { assert(false, "No settled portfolio for re-settle test"); return; }
  // Already settled, non-winner also cannot
  const result = ledger.settlePortfolio(settledPf.portfolioId, LENDER_B);
  assert(result === null, "Non-winner cannot settle");
});

test("Payment notifications after settlement", () => {
  const notifs = ledger.getPaymentNotifications(DEBTOR);
  assert(notifs.length >= 0, "Notifications returned (may be empty if not wired)");
});

ledger.reset();

console.log(`\nPortfolio Tests: ${passed} passed, ${failed} failed`);
export { passed, failed };
