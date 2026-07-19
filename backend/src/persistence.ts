import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const DATA_DIR = path.join(__dirname, "..", "data");

const writeLocks = new Map<string, Promise<void>>();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function filePath(name: string): string {
  return path.join(DATA_DIR, `${name}.json`);
}

function readJson<T>(name: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath(name), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed === null || parsed === undefined) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(name: string, data: any): Promise<void> {
  const pending = writeLocks.get(name);
  if (pending) await pending;

  const writeOp = (async () => {
    ensureDir();
    const target = filePath(name);
    const tmpFile = path.join(
      DATA_DIR,
      `.clearflow-${name}-${crypto.randomBytes(4).toString("hex")}.tmp`
    );

    let content: string;
    try {
      content = JSON.stringify(data, null, 2);
    } catch (e) {
      console.error(`[Persistence] Failed to serialize "${name}":`, e);
      return; // Don't overwrite valid data with corrupt serialization
    }

    fs.writeFileSync(tmpFile, content, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmpFile, target);
  })();

  writeLocks.set(name, writeOp);

  try {
    await writeOp;
  } finally {
    writeLocks.delete(name);
  }
}

function writeJsonSync(name: string, data: any): void {
  ensureDir();
  const target = filePath(name);
  const tmpFile = path.join(
    DATA_DIR,
    `.clearflow-${name}-${crypto.randomBytes(4).toString("hex")}.tmp`
  );

  let content: string;
  try {
    content = JSON.stringify(data, null, 2);
  } catch (e) {
    console.error(`[Persistence] Failed to serialize "${name}":`, e);
    return;
  }

  fs.writeFileSync(tmpFile, content, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmpFile, target);
}

export function loadInvoiceCache(): Map<string, any> {
  const obj = readJson<Record<string, any>>("invoices", {});
  return new Map(Object.entries(obj));
}

export function saveInvoiceCache(cache: Map<string, any>): void {
  const obj = Object.fromEntries(cache);
  writeJsonAtomic("invoices", obj);
}

export function persistInvoice(cache: Map<string, any>, invoiceId: string, data: any): void {
  cache.set(invoiceId, data);
  saveInvoiceCache(cache);
}

/**
 * PartyRecord stores a party's registration data.
 * `role` is the party's **primary role** (the role they registered with),
 * but it is NOT exclusive — any party can act in any role contextually.
 * For example, a party with primary role "seller" can be named as a debtor
 * on an invoice created by another seller.
 */
export interface PartyRecord {
  displayName: string;
  partyId: string;
  role: "seller" | "lender" | "operator" | "debtor";
  registeredAt: string;
}

export function loadPartyRegistry(): PartyRecord[] {
  return readJson<PartyRecord[]>("parties", []);
}

export function savePartyRegistry(parties: PartyRecord[]): void {
  writeJsonAtomic("parties", parties);
}

export interface AuctionState {
  invoiceId: string;
  status: "open" | "closing" | "closed" | "settled";
  closedAt?: string;
  settledAt?: string;
}

export function loadAuctionStates(): Map<string, AuctionState> {
  const obj = readJson<Record<string, AuctionState>>("auctions", {});
  return new Map(Object.entries(obj));
}

export function saveAuctionStates(states: Map<string, AuctionState>): void {
  const obj = Object.fromEntries(states);
  writeJsonAtomic("auctions", obj);
}

export function loadPasswordHashes(): Record<string, string> {
  return readJson<Record<string, string>>("password-hashes", {});
}

export function savePasswordHashes(hashes: Record<string, string>): void {
  writeJsonAtomic("password-hashes", hashes);
}

// ─── Agent Outcomes ─────────────────────────────────────────────────

export function loadAgentOutcomes(): any[] {
  return readJson<any[]>("agent-outcomes", []);
}

export function saveAgentOutcomes(outcomes: any[]): void {
  writeJsonAtomic("agent-outcomes", outcomes);
}

// ─── Agent Actions ──────────────────────────────────────────────────

export function loadAgentActions(): any[] {
  return readJson<any[]>("agent-actions", []);
}

export function saveAgentActions(actions: any[]): void {
  writeJsonAtomic("agent-actions", actions);
}

// ─── Audit Chain ────────────────────────────────────────────────────

export interface PersistedAuditEntry {
  sequenceNumber: number;
  timestamp: string;
  action: string;
  party: string;
  data: Record<string, any>;
  prevHash: string;
  hash: string;
}

export function loadAuditEntries(): PersistedAuditEntry[] {
  return readJson<PersistedAuditEntry[]>("audit-chain", []);
}

export function saveAuditEntries(entries: PersistedAuditEntry[]): void {
  writeJsonAtomic("audit-chain", entries);
}

// ─── Clear All ──────────────────────────────────────────────────────

export function clearAllPersistedData(): void {
  writeJsonSync("invoices", {});
  writeJsonSync("auctions", {});
  writeJsonSync("agent-outcomes", []);
  writeJsonSync("agent-actions", []);
  writeJsonSync("audit-chain", []);
}
