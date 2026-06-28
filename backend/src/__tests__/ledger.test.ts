import { ledger } from "../ledger";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

function test(name: string, fn: () => void): void {
  console.log(`\n${name}`);
  try {
    fn();
  } catch (e: any) {
    console.error(`  ERROR: ${e.message}`);
    failed++;
  }
}

// Test-local party names — no hardcoded business names
const TEST_SELLER = "TestSeller";
const TEST_LENDER_A = "TestLenderA";
const TEST_LENDER_B = "TestLenderB";
const TEST_LENDER_C = "TestLenderC";
const TEST_DEBTOR = "TestDebtor";
const TEST_DEBTOR_2 = "TestDebtor2";

// Reset before each suite
ledger.reset();

// ── Invoice Tests ──

test("Invoice creation", () => {
  const inv = ledger.createInvoice({
    invoiceId: "TEST-001",
    seller: TEST_SELLER,
    debtor: TEST_DEBTOR,
    amount: 75000,
    currency: "USD",
    sector: "Manufacturing",
    paymentTermDays: 30,
    issueDate: "2026-06-01",
    dueDate: "2026-07-01",
    reliabilityScore: "A",
  });
  assert(inv.invoiceId === "TEST-001", "Invoice ID matches");
  assert(inv.amount === 75000, "Amount matches");
});

test("Get all invoices", () => {
  const invoices = ledger.getAllInvoices();
  assert(invoices.length === 1, "One invoice exists");
  assert(invoices[0].debtor === TEST_DEBTOR, "Debtor name matches");
});

test("Duplicate invoice creation overwrites", () => {
  ledger.createInvoice({
    invoiceId: "TEST-001",
    seller: TEST_SELLER,
    debtor: TEST_DEBTOR,
    amount: 80000,
    currency: "USD",
    sector: "Manufacturing",
    paymentTermDays: 30,
    issueDate: "2026-06-01",
    dueDate: "2026-07-01",
    reliabilityScore: "A",
  });
  const inv = ledger.getInvoice("TEST-001");
  assert(inv?.amount === 80000, "Amount updated");
});

// ── Approval Flow Tests ──

test("Approve invoice (pending → verified)", () => {
  const result = ledger.approveInvoice("TEST-001");
  assert(result !== null, "Invoice approved");
  assert(result!.status === "verified", "Status is verified");
});

test("Confirm invoice (verified → confirmed)", () => {
  const result = ledger.confirmInvoice("TEST-001");
  assert(result !== null, "Invoice confirmed");
  assert(result!.status === "confirmed", "Status is confirmed");
});

// ── Auction Tests ──

test("Auction creation", () => {
  const auction = ledger.createAuction("TEST-001");
  assert(auction !== null, "Auction created successfully");
  assert(auction!.status === "open", "Status is open");
  assert(auction!.metadata.amountBucket === "50K-100K", "Amount bucket is 50K-100K for $80,000");
});

test("Auction creation for non-existent invoice returns null", () => {
  const auction = ledger.createAuction("DOES-NOT-EXIST");
  assert(auction === null, "Returns null for missing invoice");
});

// ── Bid Tests ──

test("Submit bid to open auction", () => {
  const result = ledger.submitBid({
    lender: TEST_LENDER_A,
    invoiceId: "TEST-001",
    discountRate: 0.03,
  });
  assert(result !== null, "Bid accepted");
});

test("Reject duplicate bid from same lender", () => {
  const result = ledger.submitBid({
    lender: TEST_LENDER_A,
    invoiceId: "TEST-001",
    discountRate: 0.02,
  });
  assert(result === null, "Duplicate bid rejected");
});

test("Submit second bid from different lender", () => {
  const result = ledger.submitBid({
    lender: TEST_LENDER_B,
    invoiceId: "TEST-001",
    discountRate: 0.025,
  });
  assert(result !== null, "Second bid accepted");
});

// ── Privacy Tests ──

test("Privacy: lender only sees own bids", () => {
  const alphaBids = ledger.getBidsForParty("TEST-001", TEST_LENDER_A);
  const betaBids = ledger.getBidsForParty("TEST-001", TEST_LENDER_B);
  assert(alphaBids.length === 1, `${TEST_LENDER_A} sees 1 bid`);
  assert(alphaBids[0].lender === TEST_LENDER_A, `${TEST_LENDER_A} sees own bid`);
  assert(betaBids.length === 1, `${TEST_LENDER_B} sees 1 bid`);
  assert(betaBids[0].lender === TEST_LENDER_B, `${TEST_LENDER_B} sees own bid`);
});

test("Privacy: lender cannot see other's discount rate", () => {
  const alphaBids = ledger.getBidsForParty("TEST-001", TEST_LENDER_A);
  const betaBids = ledger.getBidsForParty("TEST-001", TEST_LENDER_B);
  assert(alphaBids[0].discountRate === 0.03, `${TEST_LENDER_A} sees own rate`);
  assert(betaBids[0].discountRate === 0.025, `${TEST_LENDER_B} sees own rate`);
  // Neither can see the other's rate — getBidsForParty enforces this
});

// ── Close Auction Tests ──

test("Cannot close auction with fewer than 2 bids", () => {
  // Create a fresh auction
  ledger.createInvoice({
    invoiceId: "TEST-002",
    seller: TEST_SELLER,
    debtor: TEST_DEBTOR_2,
    amount: 25000,
    currency: "USD",
    sector: "Retail",
    paymentTermDays: 30,
    issueDate: "2026-06-01",
    dueDate: "2026-07-01",
    reliabilityScore: "B",
  });
  ledger.approveInvoice("TEST-002");
  ledger.confirmInvoice("TEST-002");
  ledger.createAuction("TEST-002");
  ledger.submitBid({ lender: TEST_LENDER_A, invoiceId: "TEST-002", discountRate: 0.04 });
  const result = ledger.closeAuction("TEST-002", TEST_SELLER);
  assert(result === null, "Cannot close with only 1 bid");
});

test("Close auction selects lowest rate as winner", () => {
  const result = ledger.closeAuction("TEST-001", TEST_SELLER);
  assert(result !== null, "Auction closed successfully");
  assert(result!.winningLender === TEST_LENDER_B, `${TEST_LENDER_B} wins (2.5% < 3%)`);
  assert(result!.winningRate === 0.025, "Winning rate is 2.5%");
  assert(result!.status === "closed", "Status is closed");
});

test("Cannot close already closed auction", () => {
  const result = ledger.closeAuction("TEST-001", TEST_SELLER);
  assert(result === null, "Cannot close already closed auction");
});

test("Cannot submit bid to closed auction", () => {
  const result = ledger.submitBid({
    lender: TEST_LENDER_C,
    invoiceId: "TEST-001",
    discountRate: 0.015,
  });
  assert(result === null, "Bid rejected on closed auction");
});

// ── Settlement Tests ──

test("Winner can settle", () => {
  const settlement = ledger.settle("TEST-001", TEST_LENDER_B);
  assert(settlement !== null, "Settlement successful");
  assert(settlement!.originalAmount === 80000, "Original amount correct");
  assert(settlement!.financedAmount === 80000 * (1 - 0.025), "Financed amount: 80000 * 0.975 = 78000");
  assert(settlement!.discountRate === 0.025, "Discount rate correct");
  assert(settlement!.status === "settled", "Status is settled");
});

test("Non-winner cannot settle", () => {
  // Reset and redo to test non-winner
  const settlement = ledger.settle("TEST-001", TEST_LENDER_A);
  assert(settlement === null, `${TEST_LENDER_A} cannot settle (not winner)`);
});

test("Get settlement by invoiceId", () => {
  const settlement = ledger.getSettlement("TEST-001");
  assert(settlement !== undefined, "Settlement found");
  assert(settlement!.lender === TEST_LENDER_B, `Winner is ${TEST_LENDER_B}`);
});

// ── Reset Test ──

test("Reset clears all data", () => {
  ledger.reset();
  assert(ledger.getAllInvoices().length === 0, "No invoices after reset");
  assert(ledger.getAllAuctions().length === 0, "No auctions after reset");
  assert(ledger.getAllSettlements().length === 0, "No settlements after reset");
});

// ── Summary ──

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${"=".repeat(50)}`);

export { passed, failed };
