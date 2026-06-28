import {
  InvoiceCreateSchema,
  BidSubmitSchema,
  RegisterSchema,
  AgentCreateSchema,
  DisputeSchema,
} from "../validation";

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

// ── Tests ──

test("Valid invoice passes", () => {
  const result = InvoiceCreateSchema.safeParse({
    invoiceId: "INV-2026-001",
    seller: "MySeller",
    debtor: "MyDebtor",
    amount: 75000,
    currency: "USD",
    sector: "Manufacturing",
    paymentTermDays: 30,
    reliabilityScore: "A",
  });
  assert(result.success === true, "Valid invoice accepted");
});

test("Missing invoiceId fails", () => {
  const result = InvoiceCreateSchema.safeParse({
    seller: "MySeller",
    debtor: "MyDebtor",
    amount: 75000,
  });
  assert(result.success === false, "Missing invoiceId rejected");
});

test("Negative amount fails", () => {
  const result = InvoiceCreateSchema.safeParse({
    invoiceId: "INV-001",
    seller: "S",
    debtor: "D",
    amount: -100,
    currency: "USD",
  });
  assert(result.success === false, "Negative amount rejected");
  if (!result.success) {
    const issues = result.error.issues;
    const amountError = issues.find((e: any) => e.path && e.path.includes("amount"));
    assert(amountError !== undefined, "Error on amount field");
  }
});

test("Amount over 100M fails", () => {
  const result = InvoiceCreateSchema.safeParse({
    invoiceId: "INV-002",
    seller: "S",
    debtor: "D",
    amount: 200000000,
    currency: "USD",
  });
  assert(result.success === false, "Amount > 100M rejected");
});

test("Defaults applied correctly", () => {
  const result = InvoiceCreateSchema.safeParse({
    invoiceId: "INV-003",
    seller: "S",
    debtor: "D",
    amount: 1000,
  });
  assert(result.success === true, "Minimal valid invoice accepted");
  if (result.success) {
    assert(result.data.currency === "USD", "Default currency is USD");
    assert(result.data.paymentTermDays === 30, "Default payment terms is 30");
    assert(result.data.reliabilityScore === "B", "Default reliability is B");
  }
});

test("Bid rate must be > 0", () => {
  const result = BidSubmitSchema.safeParse({
    lender: "L",
    invoiceId: "INV-001",
    discountRate: 0,
  });
  assert(result.success === false, "Zero rate rejected");
});

test("Bid rate must be < 1", () => {
  const result = BidSubmitSchema.safeParse({
    lender: "L",
    invoiceId: "INV-001",
    discountRate: 1.5,
  });
  assert(result.success === false, "Rate >= 1 rejected");
});

test("Password must be >= 8 chars", () => {
  const result = RegisterSchema.safeParse({
    displayName: "Test",
    role: "seller",
    password: "short",
  });
  assert(result.success === false, "Short password rejected");
});

test("Invalid role rejected", () => {
  const result = RegisterSchema.safeParse({
    displayName: "Test",
    role: "admin",
    password: "password123",
  });
  assert(result.success === false, "Invalid role rejected");
});

test("Valid strategy enum", () => {
  const result = AgentCreateSchema.safeParse({
    name: "agent1",
    party: "lender1",
    strategy: "adaptive",
  });
  assert(result.success === true, "Valid strategy accepted");
});

test("Invalid strategy rejected", () => {
  const result = AgentCreateSchema.safeParse({
    name: "agent1",
    party: "lender1",
    strategy: "random",
  });
  assert(result.success === false, "Invalid strategy rejected");
});

test("Empty dispute reason rejected", () => {
  const result = DisputeSchema.safeParse({ reason: "" });
  assert(result.success === false, "Empty reason rejected");
});

console.log(`\nValidation Tests: ${passed} passed, ${failed} failed`);
export { passed, failed };
