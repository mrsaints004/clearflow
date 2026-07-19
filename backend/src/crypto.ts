import crypto from "crypto";

export function hashInvoiceDocument(invoice: {
  invoiceId: string;
  seller: string;
  debtor: string;
  amount: number;
  currency: string;
  sector?: string;
  paymentTermDays?: number;
  issueDate?: string;
  dueDate: string;
  reliabilityScore?: string;
}): string {
  // Deterministic serialization: sorted keys ensure consistent hashes
  // regardless of object property insertion order
  const fields: Record<string, string | number> = {
    amount: invoice.amount,
    currency: invoice.currency,
    debtor: invoice.debtor,
    dueDate: invoice.dueDate,
    invoiceId: invoice.invoiceId,
    issueDate: invoice.issueDate || "",
    paymentTermDays: invoice.paymentTermDays || 0,
    reliabilityScore: invoice.reliabilityScore || "",
    sector: invoice.sector || "",
    seller: invoice.seller,
  };
  const canonical = JSON.stringify(fields, Object.keys(fields).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function generateNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function computeBidCommitment(discountRate: number, nonce: string): string {
  const preimage = `${discountRate.toFixed(10)}:${nonce}`;
  return crypto.createHash("sha256").update(preimage).digest("hex");
}

export function verifyBidCommitment(
  discountRate: number,
  nonce: string,
  commitment: string
): boolean {
  return computeBidCommitment(discountRate, nonce) === commitment;
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

export class AuditChain {
  private entries: AuditEntry[] = [];
  private headHash: string = "0".repeat(64); // Genesis hash
  private onPersist?: (entries: AuditEntry[]) => void;

  constructor(opts?: { onPersist?: (entries: AuditEntry[]) => void }) {
    if (opts?.onPersist) this.onPersist = opts.onPersist;
  }

  /** Load previously persisted entries. Validates chain integrity before accepting. */
  load(entries: AuditEntry[]): void {
    if (!entries || entries.length === 0) return;

    // Verify the loaded chain is valid before accepting it
    let expectedPrev = "0".repeat(64);
    for (const entry of entries) {
      if (entry.prevHash !== expectedPrev) {
        console.warn(`[AuditChain] Corrupted persisted chain at entry ${entry.sequenceNumber} — starting fresh`);
        return;
      }
      const payload = JSON.stringify({
        sequenceNumber: entry.sequenceNumber,
        timestamp: entry.timestamp,
        action: entry.action,
        party: entry.party,
        data: entry.data,
        prevHash: entry.prevHash,
      });
      const computed = crypto.createHash("sha256").update(payload).digest("hex");
      if (computed !== entry.hash) {
        console.warn(`[AuditChain] Hash mismatch at entry ${entry.sequenceNumber} — starting fresh`);
        return;
      }
      expectedPrev = entry.hash;
    }

    this.entries = entries;
    this.headHash = entries[entries.length - 1].hash;
    console.log(`[AuditChain] Restored ${entries.length} audit entries from disk`);
  }

  append(action: string, party: string, data: Record<string, any>): AuditEntry {
    const sequenceNumber = this.entries.length;
    const timestamp = new Date().toISOString();
    const prevHash = this.headHash;

    const payload = JSON.stringify({
      sequenceNumber,
      timestamp,
      action,
      party,
      data,
      prevHash,
    });
    const hash = crypto.createHash("sha256").update(payload).digest("hex");

    const entry: AuditEntry = {
      sequenceNumber,
      timestamp,
      action,
      party,
      data,
      prevHash,
      hash,
    };

    this.entries.push(entry);
    this.headHash = hash;

    // Persist to disk
    if (this.onPersist) {
      try {
        this.onPersist(this.entries);
      } catch (e) {
        console.error("[AuditChain] Persistence failed:", e);
      }
    }

    return entry;
  }

  getEntries(): AuditEntry[] {
    return [...this.entries];
  }

  getHead(): string {
    return this.headHash;
  }

  verify(): { valid: boolean; brokenAt?: number } {
    let expectedPrev = "0".repeat(64);
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.prevHash !== expectedPrev) {
        return { valid: false, brokenAt: i };
      }
      // Recompute hash
      const payload = JSON.stringify({
        sequenceNumber: entry.sequenceNumber,
        timestamp: entry.timestamp,
        action: entry.action,
        party: entry.party,
        data: entry.data,
        prevHash: entry.prevHash,
      });
      const computed = crypto.createHash("sha256").update(payload).digest("hex");
      if (computed !== entry.hash) {
        return { valid: false, brokenAt: i };
      }
      expectedPrev = entry.hash;
    }
    return { valid: true };
  }

  reset(): void {
    this.entries = [];
    this.headHash = "0".repeat(64);
    if (this.onPersist) {
      try {
        this.onPersist([]);
      } catch (e) {
        console.error("[AuditChain] Persistence reset failed:", e);
      }
    }
  }
}
