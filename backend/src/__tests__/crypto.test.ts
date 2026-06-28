import {
  hashInvoiceDocument,
  generateNonce,
  computeBidCommitment,
  verifyBidCommitment,
  AuditChain,
} from "../crypto";

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

const sampleInvoice = {
  invoiceId: "CRY-001",
  seller: "Seller1",
  debtor: "Debtor1",
  amount: 50000,
  currency: "USD",
  dueDate: "2026-07-01",
};

// ── Tests ──

test("Hash is deterministic", () => {
  const h1 = hashInvoiceDocument(sampleInvoice);
  const h2 = hashInvoiceDocument(sampleInvoice);
  assert(h1 === h2, "Same input produces same hash");
  assert(h1.length === 64, "SHA256 hex is 64 chars");
});

test("Hash uniqueness — different inputs", () => {
  const h1 = hashInvoiceDocument(sampleInvoice);
  const h2 = hashInvoiceDocument({ ...sampleInvoice, amount: 50001 });
  assert(h1 !== h2, "Different amounts produce different hashes");
});

test("Nonce uniqueness", () => {
  const n1 = generateNonce();
  const n2 = generateNonce();
  assert(n1 !== n2, "Two nonces are different");
  assert(n1.length === 32, "Nonce is 32 hex chars (16 bytes)");
});

test("Bid commitment determinism", () => {
  const nonce = "abc123";
  const c1 = computeBidCommitment(0.03, nonce);
  const c2 = computeBidCommitment(0.03, nonce);
  assert(c1 === c2, "Same rate+nonce = same commitment");
});

test("Verify valid commitment", () => {
  const nonce = generateNonce();
  const rate = 0.025;
  const commitment = computeBidCommitment(rate, nonce);
  assert(verifyBidCommitment(rate, nonce, commitment), "Valid commitment verifies");
});

test("Verify tampered commitment fails", () => {
  const nonce = generateNonce();
  const commitment = computeBidCommitment(0.03, nonce);
  assert(!verifyBidCommitment(0.031, nonce, commitment), "Tampered rate fails verification");
  assert(!verifyBidCommitment(0.03, "wrong-nonce", commitment), "Wrong nonce fails verification");
});

test("Audit chain append", () => {
  const chain = new AuditChain();
  const entry = chain.append("CREATE_INVOICE", "Seller", { invoiceId: "A-001" });
  assert(entry.sequenceNumber === 0, "First entry is sequence 0");
  assert(entry.prevHash === "0".repeat(64), "First entry has genesis prevHash");
  assert(entry.hash.length === 64, "Hash is 64 hex chars");
});

test("Audit chain verify valid", () => {
  const chain = new AuditChain();
  chain.append("CREATE", "S", { id: "1" });
  chain.append("APPROVE", "O", { id: "1" });
  chain.append("CLOSE", "S", { id: "1" });
  const result = chain.verify();
  assert(result.valid === true, "Valid chain verifies");
});

test("Audit chain detect tampering", () => {
  const chain = new AuditChain();
  chain.append("CREATE", "S", { id: "1" });
  chain.append("APPROVE", "O", { id: "1" });
  // Tamper with entry — getEntries returns shallow copy so objects are shared references
  const entries = chain.getEntries();
  entries[0].data = { id: "TAMPERED" };
  // verify() recomputes hashes from entry data, so it detects the tampered data
  const result = chain.verify();
  assert(result.valid === false, "Tampered chain detected");
  assert(result.brokenAt === 0, "Tampering detected at entry 0");
});

test("Audit chain reset", () => {
  const chain = new AuditChain();
  chain.append("TEST", "P", { data: "test" });
  chain.reset();
  assert(chain.getEntries().length === 0, "Entries cleared after reset");
  assert(chain.getHead() === "0".repeat(64), "Head reset to genesis");
});

console.log(`\nCrypto Tests: ${passed} passed, ${failed} failed`);
export { passed, failed };
