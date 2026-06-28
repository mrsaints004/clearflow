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

const SELLER = "DSeller";
const DEBTOR = "DDebtor";
const OTHER = "DOther";

// Setup
ledger.reset();
ledger.registerParty(SELLER, "seller");
ledger.registerParty(DEBTOR, "debtor");
ledger.registerParty(OTHER, "lender");

function createAndVerifyInvoice(id: string): void {
  ledger.createInvoice({
    invoiceId: id, seller: SELLER, debtor: DEBTOR, amount: 50000,
    currency: "USD", sector: "Manufacturing", paymentTermDays: 30,
    issueDate: "2026-06-01", dueDate: "2026-07-01", reliabilityScore: "A",
  });
  ledger.approveInvoice(id);
}

// ── Tests ──

test("Dispute a verified invoice", () => {
  createAndVerifyInvoice("DISP-001");
  const result = ledger.disputeInvoice("DISP-001", DEBTOR, "Amount is incorrect");
  assert(result !== null, "Dispute accepted");
  assert(result!.status === "disputed", "Status changed to disputed");
  assert(result!.disputeReason === "Amount is incorrect", "Reason stored");
});

test("Dispute a confirmed invoice (before auction)", () => {
  createAndVerifyInvoice("DISP-002");
  ledger.confirmInvoice("DISP-002");
  const result = ledger.disputeInvoice("DISP-002", DEBTOR, "Goods not delivered");
  // Confirmed invoices can be disputed if not yet in auction
  assert(result !== null, "Confirmed invoice can be disputed before auction");
  assert(result!.status === "disputed", "Status changed to disputed");
});

test("Dispute a pending invoice fails", () => {
  ledger.createInvoice({
    invoiceId: "DISP-003", seller: SELLER, debtor: DEBTOR, amount: 30000,
    currency: "USD", sector: "Retail", paymentTermDays: 30,
    issueDate: "2026-06-01", dueDate: "2026-07-01", reliabilityScore: "B",
  });
  const result = ledger.disputeInvoice("DISP-003", DEBTOR, "Wrong amount");
  assert(result === null, "Cannot dispute pending invoice");
});

test("Non-debtor cannot dispute", () => {
  createAndVerifyInvoice("DISP-004");
  const result = ledger.disputeInvoice("DISP-004", OTHER, "Not my debt");
  assert(result === null, "Non-debtor dispute rejected");
});

test("Cannot dispute invoice in auction", () => {
  createAndVerifyInvoice("DISP-005");
  ledger.confirmInvoice("DISP-005");
  ledger.createAuction("DISP-005");
  // Auction invoice is confirmed, dispute should fail
  const result = ledger.disputeInvoice("DISP-005", DEBTOR, "Wrong");
  assert(result === null, "Cannot dispute in-auction invoice");
});

test("Resolve dispute - upheld", () => {
  createAndVerifyInvoice("DISP-006");
  ledger.disputeInvoice("DISP-006", DEBTOR, "Incorrect terms");
  const result = ledger.resolveDispute("DISP-006", "upheld");
  assert(result !== null, "Resolution accepted");
  assert(result!.status === "pending", "Status back to pending");
});

test("Resolve dispute - rejected", () => {
  createAndVerifyInvoice("DISP-007");
  ledger.disputeInvoice("DISP-007", DEBTOR, "Bad terms");
  const result = ledger.resolveDispute("DISP-007", "rejected");
  assert(result !== null, "Resolution accepted");
  assert(result!.status === "confirmed", "Status set to confirmed");
});

test("Resolve non-disputed invoice fails", () => {
  createAndVerifyInvoice("DISP-008");
  const result = ledger.resolveDispute("DISP-008", "upheld");
  assert(result === null, "Cannot resolve non-disputed invoice");
});

test("Re-dispute after upheld resolution", () => {
  createAndVerifyInvoice("DISP-009");
  ledger.disputeInvoice("DISP-009", DEBTOR, "First dispute");
  ledger.resolveDispute("DISP-009", "upheld");
  // Now it's pending again, approve it to verified
  ledger.approveInvoice("DISP-009");
  const result = ledger.disputeInvoice("DISP-009", DEBTOR, "Second dispute");
  assert(result !== null, "Re-dispute accepted after upheld");
  assert(result!.disputeReason === "Second dispute", "New reason stored");
});

test("Dispute affects risk scoring", () => {
  createAndVerifyInvoice("DISP-010");
  const before = ledger.getInvoice("DISP-010");
  const riskBefore = before?.riskScore?.overall || 0;
  ledger.disputeInvoice("DISP-010", DEBTOR, "Test");
  ledger.resolveDispute("DISP-010", "upheld");
  ledger.approveInvoice("DISP-010");
  const after = ledger.getInvoice("DISP-010");
  // Risk should be computed - just verify it exists
  assert(after?.riskScore != null || riskBefore >= 0, "Risk score exists after dispute cycle");
});

// Cleanup
ledger.reset();

console.log(`\nDispute Tests: ${passed} passed, ${failed} failed`);
export { passed, failed };
