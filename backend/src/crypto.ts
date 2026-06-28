import crypto from "crypto";

export function hashInvoiceDocument(invoice: {
  invoiceId: string;
  seller: string;
  debtor: string;
  amount: number;
  currency: string;
  dueDate: string;
}): string {
  const canonical = JSON.stringify({
    invoiceId: invoice.invoiceId,
    seller: invoice.seller,
    debtor: invoice.debtor,
    amount: invoice.amount,
    currency: invoice.currency,
    dueDate: invoice.dueDate,
  });
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
  }
}
