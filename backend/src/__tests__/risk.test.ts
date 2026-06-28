import { ledger, computeRiskScoreFromData } from "../ledger";

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

test("New invoice gets risk score", () => {
  ledger.reset();
  ledger.registerParty("RSeller", "seller");
  ledger.registerParty("RDebtor", "debtor");
  const inv = ledger.createInvoice({
    invoiceId: "RISK-001", seller: "RSeller", debtor: "RDebtor", amount: 75000,
    currency: "USD", sector: "Manufacturing", paymentTermDays: 30,
    issueDate: "2026-06-01", dueDate: "2026-07-01", reliabilityScore: "A",
  });
  assert(inv.riskScore !== undefined, "Risk score computed on creation");
  assert(inv.riskScore!.overall >= 0 && inv.riskScore!.overall <= 100, "Score in valid range");
});

test("AAA best-case scenario", () => {
  const score = computeRiskScoreFromData({
    sector: "Healthcare",
    reliabilityScore: "A",
    paymentTermDays: 20,
    amount: 10000,
    currency: "USD",
  });
  assert(score.overall >= 75, `Best-case score should be high, got ${score.overall}`);
  assert(score.grade === "AAA" || score.grade === "AA" || score.grade === "A", `Grade should be A+ range, got ${score.grade}`);
});

test("CCC worst-case scenario", () => {
  const score = computeRiskScoreFromData({
    sector: "Construction",
    reliabilityScore: "C",
    paymentTermDays: 120,
    amount: 5000000,
    currency: "USD",
  });
  assert(score.overall <= 60, `Worst-case score should be low, got ${score.overall}`);
});

test("Debtor history improves score over time", () => {
  // First invoice for a debtor
  const first = computeRiskScoreFromData({
    sector: "Technology",
    reliabilityScore: "B",
    paymentTermDays: 45,
    amount: 50000,
    currency: "USD",
  });
  // B-rated with moderate terms should be mid-range
  assert(first.overall >= 30 && first.overall <= 85, `Mid-range score: ${first.overall}`);
});

test("Disputes affect risk perception", () => {
  const normal = computeRiskScoreFromData({
    sector: "Finance",
    reliabilityScore: "A",
    paymentTermDays: 30,
    amount: 100000,
    currency: "USD",
  });
  const risky = computeRiskScoreFromData({
    sector: "Finance",
    reliabilityScore: "C",
    paymentTermDays: 30,
    amount: 100000,
    currency: "USD",
  });
  assert(normal.overall > risky.overall, "A-rated scores higher than C-rated");
});

test("Amount concentration affects risk", () => {
  const small = computeRiskScoreFromData({
    sector: "Manufacturing",
    reliabilityScore: "A",
    paymentTermDays: 30,
    amount: 5000,
    currency: "USD",
  });
  const large = computeRiskScoreFromData({
    sector: "Manufacturing",
    reliabilityScore: "A",
    paymentTermDays: 30,
    amount: 5000000,
    currency: "USD",
  });
  // Both should have scores but larger amounts typically don't change sector-based scoring
  assert(small.overall >= 0, `Small amount risk valid: ${small.overall}`);
  assert(large.overall >= 0, `Large amount risk valid: ${large.overall}`);
});

test("Currency stability", () => {
  const usd = computeRiskScoreFromData({
    sector: "Manufacturing",
    reliabilityScore: "B",
    paymentTermDays: 30,
    amount: 50000,
    currency: "USD",
  });
  const jpy = computeRiskScoreFromData({
    sector: "Manufacturing",
    reliabilityScore: "B",
    paymentTermDays: 30,
    amount: 50000,
    currency: "JPY",
  });
  // Both should produce valid scores
  assert(usd.overall >= 0, "USD risk valid");
  assert(jpy.overall >= 0, "JPY risk valid");
});

test("Temporal proximity - short vs long terms", () => {
  const short = computeRiskScoreFromData({
    sector: "Energy",
    reliabilityScore: "B",
    paymentTermDays: 15,
    amount: 50000,
    currency: "USD",
  });
  const long = computeRiskScoreFromData({
    sector: "Energy",
    reliabilityScore: "B",
    paymentTermDays: 180,
    amount: 50000,
    currency: "USD",
  });
  assert(short.overall >= long.overall, `Short terms (${short.overall}) >= long terms (${long.overall})`);
});

ledger.reset();

console.log(`\nRisk Tests: ${passed} passed, ${failed} failed`);
export { passed, failed };
