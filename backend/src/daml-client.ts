import crypto from "crypto";
import {
  loadInvoiceCache,
  persistInvoice,
  loadPartyRegistry,
  savePartyRegistry,
  loadAuctionStates,
  saveAuctionStates,
  type PartyRecord,
  type AuctionState,
} from "./persistence";

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const LEDGER_URL = process.env.LEDGER_API_URL || (IS_PRODUCTION ? "" : "http://localhost:7575");
const JWT_SECRET = process.env.JWT_SECRET || (IS_PRODUCTION ? "" : "clearflow-dev-secret-change-in-production");
const SEAPORT_DEVNET = process.env.SEAPORT_DEVNET === "true";
const SEAPORT_OIDC_ISSUER = process.env.SEAPORT_OIDC_ISSUER || "";
const SEAPORT_OIDC_CLIENT_ID = process.env.SEAPORT_OIDC_CLIENT_ID || "";
const SEAPORT_OIDC_CLIENT_SECRET = process.env.SEAPORT_OIDC_CLIENT_SECRET || "";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

// Ledger API version — v1 for local Canton JSON API, v2 for Seaport devnet
let API_VERSION: "v1" | "v2" = SEAPORT_DEVNET ? "v2" : "v1";

// OIDC token management for Seaport devnet (tokens expire every 8 hours)
let seaportToken = process.env.SEAPORT_AUTH_TOKEN || "";
let seaportTokenExpiry = 0;

async function refreshSeaportToken(): Promise<string> {
  if (seaportToken && Date.now() < seaportTokenExpiry - 60000) {
    return seaportToken; // Still valid (with 1-minute buffer)
  }
  if (!SEAPORT_OIDC_ISSUER || !SEAPORT_OIDC_CLIENT_ID || !SEAPORT_OIDC_CLIENT_SECRET) {
    if (seaportToken) return seaportToken; // Use static token if no OIDC config
    throw new Error("No Seaport auth token or OIDC credentials configured");
  }
  console.log("Refreshing Seaport OIDC token...");
  const res = await fetch(SEAPORT_OIDC_ISSUER, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SEAPORT_OIDC_CLIENT_ID,
      client_secret: SEAPORT_OIDC_CLIENT_SECRET,
      audience: SEAPORT_OIDC_CLIENT_ID,
      scope: "daml_ledger_api",
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`OIDC token refresh failed: ${res.status} ${res.statusText}`);
  }
  const data: any = await res.json();
  seaportToken = data.access_token;
  seaportTokenExpiry = Date.now() + (data.expires_in || 28800) * 1000;
  console.log(`Seaport token refreshed (expires in ${data.expires_in || 28800}s)`);
  return seaportToken;
}

// Per-participant JSON API URLs for true Canton privacy routing.
// Format: "operator=http://...:7571,p1=http://...:7572,p2=http://...:7573,p3=http://...:7574"
// When set, queries are routed through the participant hosting the requesting party,
// ensuring data never touches unauthorized nodes.
const PARTICIPANT_URLS: Map<string, string> = new Map();
if (process.env.CANTON_PARTICIPANT_URLS) {
  for (const entry of process.env.CANTON_PARTICIPANT_URLS.split(",")) {
    const [name, url] = entry.split("=");
    if (name && url) PARTICIPANT_URLS.set(name.trim(), url.trim());
  }
}

// Maps party display names to their participant slot
const partyToParticipant: Map<string, string> = new Map();

// These get set during init after party allocation
let NAMESPACE = "";
let PACKAGE_ID = "";

let invoiceCache = new Map<string, any>();
let partyRegistry: PartyRecord[] = [];
let auctionStates = new Map<string, AuctionState>();
let paymentNotifications: any[] = [];

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJwt(payload: object): string {
  const header = base64url('{"alg":"HS256","typ":"JWT"}');
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(
    crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${signature}`;
}

function makeLedgerToken(actAs: string[], readAs: string[], admin = false): string {
  return signJwt({
    "https://daml.com/ledger-api": {
      ledgerId: process.env.CANTON_LEDGER_ID || "sandbox",
      applicationId: "clearflow",
      actAs,
      readAs,
      admin,
    },
  });
}

function adminToken(): string {
  const allParties = partyRegistry.map((p) => p.partyId);
  return makeLedgerToken(allParties, allParties, true);
}

function operatorToken(): string {
  const op = getOperatorPartyId();
  return makeLedgerToken([op], [op], true);
}

function partyToken(partyId: string): string {
  const op = getOperatorPartyId();
  return makeLedgerToken([op, partyId], [op, partyId]);
}

function getOperatorPartyId(): string {
  const op = partyRegistry.find((p) => p.role === "operator");
  return op?.partyId || "";
}

function getSellerPartyId(displayName?: string): string {
  if (displayName) {
    const p = partyRegistry.find((p) => p.displayName === displayName);
    if (p) return p.partyId;
  }
  const seller = partyRegistry.find((p) => p.role === "seller");
  return seller?.partyId || "";
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolve the JSON API URL for a given party (uses per-participant routing if configured)
function participantUrlFor(partyDisplayName?: string): string {
  if (partyDisplayName && PARTICIPANT_URLS.size > 0) {
    const slot = partyToParticipant.get(partyDisplayName);
    if (slot && PARTICIPANT_URLS.has(slot)) {
      return PARTICIPANT_URLS.get(slot)!;
    }
  }
  return LEDGER_URL;
}

async function ledgerPost(path: string, body: any, token: string, retries = MAX_RETRIES, ledgerUrl?: string): Promise<any> {
  const url = ledgerUrl || LEDGER_URL;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${url}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data: any = await res.json();
      if (data.status !== 200) {
        const errMsg = data.errors?.[0] || `Ledger error: ${JSON.stringify(data)}`;
        // Don't retry on client errors (bad requests, not found, etc.)
        if (res.status >= 400 && res.status < 500) {
          throw new Error(errMsg);
        }
        lastError = new Error(errMsg);
        if (attempt < retries) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        throw lastError;
      }
      return data.result;
    } catch (e: any) {
      lastError = e;
      if (e.message?.includes("fetch failed") && attempt < retries) {
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastError || new Error("Ledger request failed after retries");
}

function templateId(module: string, entity: string): string {
  return `${PACKAGE_ID}:${module}:${entity}`;
}

// ─── v2 API helpers (Seaport devnet) ────────────────────────────────────────

async function getAuthToken(): Promise<string> {
  if (SEAPORT_DEVNET) return refreshSeaportToken();
  return adminToken();
}

// Unified create: works with both v1 and v2 API
async function ledgerCreate(tmplId: string, payload: any, actAsParties: string[]): Promise<any> {
  const token = await getAuthToken();
  if (API_VERSION === "v2") {
    const res = await fetch(`${LEDGER_URL}/v2/commands/submit-and-wait-for-transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        actAs: actAsParties,
        userId: "clearflow",
        commandId: `cf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        commands: [{ CreateCommand: { templateId: tmplId, createArguments: payload } }],
      }),
    });
    const data: any = await res.json();
    if (!res.ok) throw new Error(data.cause || data.message || JSON.stringify(data));
    // Extract contractId from transaction events
    const events = data.transaction?.events || [];
    const created = events.find((e: any) => e.CreatedEvent);
    return { contractId: created?.CreatedEvent?.contractId || "", ...data };
  }
  // v1 fallback
  return ledgerPost("/v1/create", { templateId: tmplId, payload }, actAsParties.length > 0 ? partyToken(actAsParties[0]) : adminToken());
}

// Unified exercise: works with both v1 and v2 API
async function ledgerExercise(tmplId: string, contractId: string, choice: string, argument: any, actAsParties: string[]): Promise<any> {
  const token = await getAuthToken();
  if (API_VERSION === "v2") {
    const res = await fetch(`${LEDGER_URL}/v2/commands/submit-and-wait-for-transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        actAs: actAsParties,
        userId: "clearflow",
        commandId: `cf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        commands: [{ ExerciseCommand: { templateId: tmplId, contractId, choice, choiceArgument: argument } }],
      }),
    });
    const data: any = await res.json();
    if (!res.ok) throw new Error(data.cause || data.message || JSON.stringify(data));
    return data;
  }
  // v1 fallback
  return ledgerPost("/v1/exercise", { templateId: tmplId, contractId, choice, argument }, actAsParties.length > 0 ? partyToken(actAsParties[0]) : adminToken());
}

// Unified query: works with both v1 and v2 API
async function ledgerQuery(tmplIds: string[], actAsParties: string[]): Promise<any[]> {
  const token = await getAuthToken();
  if (API_VERSION === "v2") {
    const res = await fetch(`${LEDGER_URL}/v2/state/active-contracts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filter: {
          cumulative: tmplIds.map((t) => ({
            template_filters: { include: [t] },
          })),
        },
        verbose: true,
      }),
    });
    const data: any = await res.json();
    if (!res.ok) throw new Error(data.cause || data.message || JSON.stringify(data));
    // v2 returns { contractEntries: [...] } or { activeContracts: [...] }
    const entries = data.contractEntries || data.activeContracts || data.result || [];
    return entries
      .filter((e: any) => e.ActiveContract || e.contractId)
      .map((e: any) => {
        const ac = e.ActiveContract || e;
        return {
          contractId: ac.contractId,
          payload: ac.createArguments || ac.payload,
          templateId: ac.templateId,
        };
      });
  }
  // v1 fallback
  const tkn = actAsParties.length > 0 ? partyToken(actAsParties[0]) : adminToken();
  return ledgerPost("/v1/query", { templateIds: tmplIds }, tkn);
}

export async function initDamlClient(): Promise<boolean> {
  try {
    invoiceCache = loadInvoiceCache();
    partyRegistry = loadPartyRegistry();
    auctionStates = loadAuctionStates();
    console.log(`Loaded ${invoiceCache.size} cached invoices, ${partyRegistry.length} parties, ${auctionStates.size} auction states`);

    // Seaport devnet: use OIDC token, detect API version
    if (SEAPORT_DEVNET) {
      console.log("Seaport devnet mode enabled");
      // Try v2 first (Seaport standard), fall back to v1
      try {
        const initToken = await refreshSeaportToken();
        const v2Check = await fetch(`${LEDGER_URL}/v2/state/ledger-end`, {
          headers: { Authorization: `Bearer ${initToken}` },
        });
        if (v2Check.ok) {
          API_VERSION = "v2";
          console.log("Seaport Ledger API v2 detected");
        }
      } catch {
        // v2 not available, try v1
        try {
          const v1Check = await fetch(`${LEDGER_URL}/readyz`);
          if (v1Check.ok) {
            API_VERSION = "v1";
            console.log("Falling back to Ledger API v1");
          }
        } catch {
          console.error("Cannot reach Seaport devnet at " + LEDGER_URL);
          return false;
        }
      }
    } else {
      const res = await fetch(`${LEDGER_URL}/readyz`);
      if (!res.ok) return false;
    }

    // For Seaport devnet, use the OIDC token; for local Canton, generate JWT
    const bootstrapToken = SEAPORT_DEVNET
      ? await refreshSeaportToken()
      : signJwt({
          "https://daml.com/ledger-api": {
            ledgerId: process.env.CANTON_LEDGER_ID || "sandbox",
            applicationId: "clearflow",
            actAs: [],
            readAs: [],
            admin: true,
          },
        });

    // Fetch parties — different endpoint for v1 vs v2
    const partiesEndpoint = API_VERSION === "v2" ? "/v2/parties" : "/v1/parties";
    const partiesRes = await fetch(`${LEDGER_URL}${partiesEndpoint}`, {
      headers: { Authorization: `Bearer ${bootstrapToken}`, "Content-Type": "application/json" },
    });
    const partiesData: any = await partiesRes.json();
    if (API_VERSION === "v1" && partiesData.status !== 200) return false;

    // Parse parties response — v1 wraps in { result: [...] }, v2 returns array or { parties: [...] }
    const existingOnLedger: Array<{ identifier: string; displayName?: string }> =
      API_VERSION === "v2"
        ? (partiesData.parties || partiesData.result || partiesData || []).map((p: any) => ({
            identifier: p.party || p.identifier,
            displayName: p.display_name || p.displayName,
          }))
        : (partiesData.result as Array<{ identifier: string; displayName?: string }>);

    const findOrCreate = async (hint: string): Promise<string> => {
      const found = existingOnLedger.find((p) => p.displayName === hint);
      if (found) return found.identifier;
      if (API_VERSION === "v2") {
        // v2: POST /v2/parties
        const res = await fetch(`${LEDGER_URL}/v2/parties`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bootstrapToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ identifier_hint: hint, display_name: hint }),
        });
        const data: any = await res.json();
        return data.party || data.identifier || hint;
      }
      const result = await ledgerPost("/v1/parties/allocate", { identifierHint: hint, displayName: hint }, bootstrapToken, 1);
      return result.identifier;
    };

    // Ensure default parties exist
    if (SEAPORT_DEVNET) {
      // On Seaport devnet, all parties map to the same participant party ID
      const seaportPartyId = process.env.SEAPORT_PARTY_ID || existingOnLedger[0]?.identifier || "";
      if (!partyRegistry.find((p) => p.displayName === "Operator")) {
        partyRegistry.push({
          displayName: "Operator",
          partyId: seaportPartyId,
          role: "operator",
          registeredAt: new Date().toISOString(),
        });
      } else {
        const op = partyRegistry.find((p) => p.displayName === "Operator");
        if (op) op.partyId = seaportPartyId;
      }
    } else {
      const defaults: Array<{ name: string; role: PartyRecord["role"] }> = [
        { name: "Operator", role: "operator" },
      ];

      for (const d of defaults) {
        const partyId = await findOrCreate(d.name);
        if (!partyRegistry.find((p) => p.partyId === partyId)) {
          partyRegistry.push({
            displayName: d.name,
            partyId,
            role: d.role,
            registeredAt: new Date().toISOString(),
          });
        } else {
          const existing = partyRegistry.find((p) => p.displayName === d.name);
          if (existing) existing.partyId = partyId;
        }
      }
    }
    savePartyRegistry(partyRegistry);

    const operatorId = getOperatorPartyId();
    const nsParts = operatorId.split("::");
    NAMESPACE = nsParts.length > 1 ? nsParts[1] : "";

    const pkgsEndpoint = API_VERSION === "v2" ? "/v2/packages" : "/v1/packages";
    const pkgToken = SEAPORT_DEVNET ? await refreshSeaportToken() : adminToken();
    const pkgsRes = await fetch(`${LEDGER_URL}${pkgsEndpoint}`, {
      headers: { Authorization: `Bearer ${pkgToken}`, "Content-Type": "application/json" },
    });
    const pkgsData: any = await pkgsRes.json();
    const packageIds: string[] = API_VERSION === "v2"
      ? (pkgsData.package_ids || pkgsData.result || [])
      : (pkgsData.result || []);

    for (const pkgId of packageIds) {
      try {
        if (API_VERSION === "v2") {
          // v2: try to query using the package ID in a template qualified name
          const testRes = await fetch(`${LEDGER_URL}/v2/state/active-contracts`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${pkgToken}`,
            },
            body: JSON.stringify({
              filter: { cumulative: [{ template_filters: { include: [`${pkgId}:Invoice:Invoice`] } }] },
            }),
          });
          if (testRes.ok) {
            PACKAGE_ID = pkgId;
            break;
          }
        } else {
          const testRes = await fetch(`${LEDGER_URL}/v1/query`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken()}`,
            },
            body: JSON.stringify({ templateIds: [`${pkgId}:Invoice:Invoice`] }),
          });
          const testData: any = await testRes.json();
          if (testData.status === 200) {
            PACKAGE_ID = pkgId;
            break;
          }
        }
      } catch {
        continue;
      }
    }

    if (!PACKAGE_ID) {
      console.warn("Could not find clearflow package on ledger — running in standalone mode");
      console.warn("Upload the DAR to the ledger and restart to enable on-chain operations");
      console.log(`Parties: ${partyRegistry.map((p) => `${p.displayName}(${p.role})`).join(", ")}`);
      return true; // Still start — the app works with local persistence even without the DAR
    }

    console.log(`Connected to Daml ledger (API ${API_VERSION}${SEAPORT_DEVNET ? " / Seaport devnet" : ""})`);
    console.log(`Package ID: ${PACKAGE_ID}`);
    console.log(`Parties: ${partyRegistry.map((p) => `${p.displayName}(${p.role})`).join(", ")}`);
    return true;
  } catch (e) {
    console.error("Failed to connect to Daml ledger:", e);
    return false;
  }
}

export const damlClient = {
  // Find the active contract ID for an invoice by querying the ledger
  async findInvoiceContractId(invoiceId: string): Promise<string> {
    const allParties = partyRegistry.map((p) => p.partyId);
    const result = await ledgerQuery([templateId("Invoice", "Invoice")], allParties);
    const match = result.find((r: any) => r.payload.invoice?.invoiceId === invoiceId || r.payload.invoice?.invoiceId === invoiceId);
    if (!match) throw new Error(`Invoice ${invoiceId} not found on ledger`);
    return match.contractId;
  },

  getParties(): PartyRecord[] {
    return partyRegistry;
  },

  getPartyId(displayName: string): string {
    const p = partyRegistry.find((r) => r.displayName === displayName);
    return p?.partyId || displayName;
  },

  getCachedInvoice(invoiceId: string): any | null {
    return invoiceCache.get(invoiceId) || null;
  },

  getDisplayName(partyId: string): string {
    const p = partyRegistry.find((r) => r.partyId === partyId);
    return p?.displayName || partyId.split("::")[0] || partyId;
  },

  async registerParty(displayName: string, role: PartyRecord["role"]): Promise<PartyRecord> {
    const existing = partyRegistry.find((p) => p.displayName === displayName);
    if (existing) return existing;

    let partyId: string;
    if (SEAPORT_DEVNET) {
      // On Seaport devnet, we use the shared party ID — all parties map to the same participant
      partyId = process.env.SEAPORT_PARTY_ID || displayName;
    } else {
      const bootstrapToken = signJwt({
        "https://daml.com/ledger-api": {
          ledgerId: process.env.CANTON_LEDGER_ID || "sandbox",
          applicationId: "clearflow",
          actAs: [],
          readAs: [],
          admin: true,
        },
      });

      const result = await ledgerPost(
        "/v1/parties/allocate",
        { identifierHint: displayName, displayName },
        bootstrapToken,
        1
      );
      partyId = result.identifier;
    }

    const record: PartyRecord = {
      displayName,
      partyId,
      role,
      registeredAt: new Date().toISOString(),
    };

    partyRegistry.push(record);
    savePartyRegistry(partyRegistry);

    // Assign party to a participant slot for per-participant routing
    if (PARTICIPANT_URLS.size > 0) {
      // Operator is always on the operator participant
      if (role === "operator") {
        partyToParticipant.set(displayName, "operator");
      } else {
        // Round-robin assign to available participant slots (p1, p2, p3)
        const slots = ["p1", "p2", "p3"];
        const usedSlots = new Map<string, number>();
        for (const [, slot] of partyToParticipant) {
          usedSlots.set(slot, (usedSlots.get(slot) || 0) + 1);
        }
        const leastUsed = slots.reduce((a, b) =>
          (usedSlots.get(a) || 0) <= (usedSlots.get(b) || 0) ? a : b
        );
        partyToParticipant.set(displayName, leastUsed);
      }
    }

    return record;
  },

  async createInvoice(invoiceData: any): Promise<any> {
    const sellerParty = this.getPartyId(invoiceData.seller);
    const debtorParty = this.getPartyId(invoiceData.debtor);
    const payload = {
      operator: getOperatorPartyId(),
      seller: sellerParty,
      invoice: {
        invoiceId: invoiceData.invoiceId,
        seller: sellerParty,
        debtorName: debtorParty,
        amount: String(invoiceData.amount),
        currency: invoiceData.currency,
        sector: invoiceData.sector,
        paymentTermDays: invoiceData.paymentTermDays,
        issueDate: invoiceData.issueDate,
        dueDate: invoiceData.dueDate,
        reliabilityScore: invoiceData.reliabilityScore,
      },
      status: "pending",
    };
    const result = await ledgerCreate(templateId("Invoice", "Invoice"), payload, [getOperatorPartyId(), sellerParty]);

    persistInvoice(invoiceCache, invoiceData.invoiceId, invoiceData);
    return { ...invoiceData, contractId: result.contractId };
  },

  async getInvoices(partyName?: string): Promise<any[]> {
    const party = partyName ? this.getPartyId(partyName) : null;
    const actAs = party ? [party] : partyRegistry.map((p) => p.partyId);
    const result = await ledgerQuery([templateId("Invoice", "Invoice")], actAs);
    return result.map((r: any) => {
      const amount = parseFloat(r.payload.invoice.amount);
      // Map debtorName (Daml field) back to debtor (app field)
      const debtor = r.payload.invoice.debtorName || r.payload.invoice.debtor;
      const inv = {
        ...r.payload.invoice,
        debtor,
        contractId: r.contractId,
        status: r.payload.status,
        paymentTermDays: parseInt(r.payload.invoice.paymentTermDays, 10) || 30,
        amount,
      };
      persistInvoice(invoiceCache, inv.invoiceId, inv);
      return inv;
    });
  },

  async createAuction(invoiceId: string): Promise<any> {
    const cid = await this.findInvoiceContractId(invoiceId);
    const sellerParty = getSellerPartyId();
    const result = await ledgerExercise(templateId("Invoice", "Invoice"), cid, "CreateAuction", { minBidCount: 2 }, [sellerParty, getOperatorPartyId()]);

    auctionStates.set(invoiceId, { invoiceId, status: "open" });
    saveAuctionStates(auctionStates);

    return result;
  },

  async getAuctions(partyName?: string): Promise<any[]> {
    const party = partyName ? this.getPartyId(partyName) : null;
    const actAs = party ? [party] : partyRegistry.map((p) => p.partyId);
    const result = await ledgerQuery([templateId("Invoice", "AuctionInvite")], actAs);
    return result.map((r: any) => ({
      invoiceId: r.payload.invoiceId,
      metadata: {
        ...r.payload.metadata,
        paymentTermDays: parseInt(r.payload.metadata.paymentTermDays, 10) || 30,
      },
      status: r.payload.status,
      contractId: r.contractId,
    }));
  },

  async submitBid(lenderName: string, invoiceId: string, discountRate: number): Promise<any> {
    const lenderParty = this.getPartyId(lenderName);
    const nonce = crypto.randomBytes(16).toString("hex");
    const commitHash = crypto.createHash("sha256")
      .update(`${discountRate.toFixed(10)}:${nonce}`)
      .digest("hex");

    // COMMIT phase — create sealed bid with rate hidden (discountRate = 0)
    const payload = {
      operator: getOperatorPartyId(),
      lender: lenderParty,
      invoiceId,
      discountRate: "0",
      commitHash,
      revealed: false,
    };
    const result = await ledgerCreate(templateId("Auction", "SealedBid"), payload, [getOperatorPartyId(), lenderParty]);

    return { status: "bid_committed", invoiceId, contractId: result.contractId, commitHash, nonce };
  },

  async revealBid(invoiceId: string, lenderName: string, discountRate: number, nonce: string): Promise<any> {
    const lenderParty = this.getPartyId(lenderName);

    // Find the sealed bid contract for this lender + invoice
    const bids = await ledgerQuery([templateId("Auction", "SealedBid")], [lenderParty]);
    const bidContract = bids.find(
      (r: any) => r.payload.invoiceId === invoiceId && r.payload.lender === lenderParty && !r.payload.revealed
    );
    if (!bidContract) {
      throw new Error("Sealed bid not found or already revealed");
    }

    // REVEAL phase — exercise the Reveal choice with actual rate + nonce
    await ledgerExercise(
      templateId("Auction", "SealedBid"),
      bidContract.contractId,
      "Reveal",
      { actualRate: String(discountRate), nonce },
      [lenderParty]
    );

    return { status: "bid_revealed", invoiceId, verified: true };
  },

  // Privacy-filtered: only returns bids where the lender matches the requesting party
  async getBidsForParty(invoiceId: string, partyName: string): Promise<any[]> {
    const party = this.getPartyId(partyName);
    const result = await ledgerQuery([templateId("Auction", "SealedBid")], [party]);
    return result
      .filter((r: any) => r.payload.invoiceId === invoiceId && r.payload.lender === party)
      .map((r: any) => ({
        lender: r.payload.lender,
        invoiceId: r.payload.invoiceId,
        discountRate: parseFloat(r.payload.discountRate),
        contractId: r.contractId,
      }));
  },

  async getAllBids(invoiceId: string): Promise<any[]> {
    const allParties = partyRegistry.map((p) => p.partyId);
    const result = await ledgerQuery([templateId("Auction", "SealedBid")], allParties);
    return result
      .filter((r: any) => r.payload.invoiceId === invoiceId)
      .map((r: any) => ({
        lender: r.payload.lender,
        invoiceId: r.payload.invoiceId,
        discountRate: parseFloat(r.payload.discountRate),
        contractId: r.contractId,
      }));
  },

  async closeAuction(invoiceId: string): Promise<any> {
    // Idempotency check: if already closed, return cached result
    const existingState = auctionStates.get(invoiceId);
    if (existingState?.status === "closed" || existingState?.status === "settled") {
      // Already closed — re-fetch bids and return result
      const bids = await this.getAllBids(invoiceId);
      const winner = bids.reduce((best: any, bid: any) =>
        bid.discountRate < best.discountRate ? bid : best
      );
      return {
        invoiceId,
        status: "closed",
        winningLender: winner.lender,
        winningRate: winner.discountRate,
        bids,
      };
    }

    // Mark as closing (in-progress)
    auctionStates.set(invoiceId, { invoiceId, status: "closing" });
    saveAuctionStates(auctionStates);

    try {
      const bids = await this.getAllBids(invoiceId);
      if (bids.length < 2) {
        auctionStates.set(invoiceId, { invoiceId, status: "open" });
        saveAuctionStates(auctionStates);
        throw new Error("Need at least 2 bids");
      }

      const winner = bids.reduce((best: any, bid: any) =>
        bid.discountRate < best.discountRate ? bid : best
      );

      const sellerParty = getSellerPartyId();
      const opParty = getOperatorPartyId();
      const auctions = await ledgerQuery([templateId("Invoice", "AuctionInvite")], [sellerParty, opParty]);
      const auction = auctions.find((a: any) => a.payload.invoiceId === invoiceId);

      if (auction && auction.payload.status === "open") {
        await ledgerExercise(templateId("Invoice", "AuctionInvite"), auction.contractId, "CloseAuction", { dummy: {} }, [sellerParty, opParty]);
      }
      // If auction is already closed (status !== "open"), skip — idempotent

      const cached = invoiceCache.get(invoiceId);
      const amount = cached ? cached.amount : 0;

      const allParties = partyRegistry.map((p) => p.partyId);
      const existingResults = await ledgerQuery([templateId("Auction", "AuctionResult")], allParties);
      const hasResult = existingResults.some((r: any) => r.payload.invoiceId === invoiceId);

      if (!hasResult) {
        await ledgerCreate(templateId("Auction", "AuctionResult"), {
          operator: opParty,
          seller: sellerParty,
          winningLender: winner.lender,
          invoiceId,
          winningRate: String(winner.discountRate),
          invoiceAmount: String(amount),
        }, [opParty, sellerParty]);
      }

      const existingRejections = await ledgerQuery([templateId("Auction", "BidRejection")], allParties);
      const rejectedInvoiceIds = new Set(
        existingRejections
          .filter((r: any) => r.payload.invoiceId === invoiceId)
          .map((r: any) => r.payload.lender)
      );

      for (const bid of bids) {
        if (bid.lender !== winner.lender && !rejectedInvoiceIds.has(bid.lender)) {
          try {
            await ledgerCreate(templateId("Auction", "BidRejection"), {
              operator: opParty,
              lender: bid.lender,
              invoiceId,
            }, [opParty]);
          } catch (e: any) {
            // Non-critical — log and continue
            console.warn(`Failed to create rejection for ${bid.lender}: ${e.message}`);
          }
        }
      }

      auctionStates.set(invoiceId, {
        invoiceId,
        status: "closed",
        closedAt: new Date().toISOString(),
      });
      saveAuctionStates(auctionStates);

      return {
        invoiceId,
        status: "closed",
        winningLender: winner.lender,
        winningRate: winner.discountRate,
        bids,
      };
    } catch (e) {
      // On failure, reset state to allow retry
      if (!existingState || existingState.status === "open" || existingState.status === "closing") {
        auctionStates.set(invoiceId, { invoiceId, status: "open" });
        saveAuctionStates(auctionStates);
      }
      throw e;
    }
  },

  async settle(invoiceId: string, lenderName: string): Promise<any> {
    const lenderParty = this.getPartyId(lenderName);

    const existingState = auctionStates.get(invoiceId);
    if (existingState?.status === "settled") {
      // Retry up to 3 times in case settlement hasn't propagated to cache yet
      for (let attempt = 0; attempt < 3; attempt++) {
        const settlements = await this.getSettlements(lenderName);
        const s = settlements.find((s: any) => s.invoiceId === invoiceId);
        if (s) return s;
        if (attempt < 2) await sleep(500);
      }
    }

    const results = await ledgerQuery([templateId("Auction", "AuctionResult")], [lenderParty]);
    const result = results.find((r: any) => r.payload.invoiceId === invoiceId);
    if (!result) throw new Error("AuctionResult not found — you may not be the winner");

    const settled = await ledgerExercise(templateId("Auction", "AuctionResult"), result.contractId, "Settle", { dummy: {} }, [lenderParty, getOperatorPartyId(), getSellerPartyId()]);

    auctionStates.set(invoiceId, {
      invoiceId,
      status: "settled",
      closedAt: existingState?.closedAt,
      settledAt: new Date().toISOString(),
    });
    saveAuctionStates(auctionStates);

    const amount = parseFloat(result.payload.invoiceAmount);
    const rate = parseFloat(result.payload.winningRate);

    return {
      invoiceId,
      seller: result.payload.seller,
      lender: lenderParty,
      originalAmount: amount,
      financedAmount: amount * (1 - rate),
      discountRate: rate,
      status: "settled",
    };
  },

  async getSettlements(partyName?: string): Promise<any[]> {
    const party = partyName ? this.getPartyId(partyName) : null;
    const actAs = party ? [party] : partyRegistry.map((p) => p.partyId);
    const result = await ledgerQuery([templateId("Auction", "SettledInvoice")], actAs);
    return result
      .filter((r: any) => !party || r.payload.seller === party || r.payload.lender === party)
      .map((r: any) => ({
        invoiceId: r.payload.invoiceId,
        seller: r.payload.seller,
        lender: r.payload.lender,
        originalAmount: parseFloat(r.payload.originalAmount),
        financedAmount: parseFloat(r.payload.financedAmount),
        discountRate: parseFloat(r.payload.discountRate),
        status: r.payload.status,
        contractId: r.contractId,
      }));
  },

  async getAuctionResult(invoiceId: string, partyName: string): Promise<any | null> {
    const party = this.getPartyId(partyName);
    try {
      const results = await ledgerQuery([templateId("Auction", "AuctionResult")], [party]);
      const result = results.find((r: any) => r.payload.invoiceId === invoiceId);
      if (!result) return null;
      const isWinner = result.payload.winningLender === party;
      const isSeller = result.payload.seller === party;
      if (!isWinner && !isSeller) return null;
      return {
        invoiceId,
        winningLender: result.payload.winningLender,
        winningRate: parseFloat(result.payload.winningRate),
        invoiceAmount: parseFloat(result.payload.invoiceAmount),
        isWinner,
      };
    } catch {
      return null;
    }
  },

  async getBidRejection(invoiceId: string, partyName: string): Promise<boolean> {
    const party = this.getPartyId(partyName);
    try {
      const rejections = await ledgerQuery([templateId("Auction", "BidRejection")], [party]);
      return rejections.some((r: any) => r.payload.invoiceId === invoiceId && r.payload.lender === party);
    } catch {
      return false;
    }
  },

  async approveInvoice(invoiceId: string): Promise<any> {
    const cid = await this.findInvoiceContractId(invoiceId);
    const opParty = getOperatorPartyId();
    const result = await ledgerExercise(templateId("Invoice", "Invoice"), cid, "Approve", {}, [opParty]);
    // Update cache
    const cached = invoiceCache.get(invoiceId);
    if (cached) {
      cached.status = "verified";
      persistInvoice(invoiceCache, invoiceId, cached);
    }
    return { invoiceId, status: "verified", contractId: result };
  },

  async confirmInvoice(invoiceId: string, debtorName?: string): Promise<any> {
    // Debtor is the controller of the Confirm choice
    const debtorPartyId = debtorName ? this.getPartyId(debtorName) : "";
    const cid = await this.findInvoiceContractId(invoiceId);
    const actAs = debtorPartyId ? [debtorPartyId, getOperatorPartyId()] : [getOperatorPartyId()];
    const result = await ledgerExercise(templateId("Invoice", "Invoice"), cid, "Confirm", {}, actAs);
    const cached = invoiceCache.get(invoiceId);
    if (cached) {
      cached.status = "confirmed";
      persistInvoice(invoiceCache, invoiceId, cached);
    }
    return { invoiceId, status: "confirmed", contractId: result };
  },

  async disputeInvoice(invoiceId: string, reason: string, debtorName?: string): Promise<any> {
    // Debtor is the controller of the Dispute choice
    const debtorPartyId = debtorName ? this.getPartyId(debtorName) : "";
    const cid = await this.findInvoiceContractId(invoiceId);
    const actAs = debtorPartyId ? [debtorPartyId, getOperatorPartyId()] : [getOperatorPartyId()];
    const result = await ledgerExercise(templateId("Invoice", "Invoice"), cid, "Dispute", { reason }, actAs);
    const cached = invoiceCache.get(invoiceId);
    if (cached) {
      cached.status = "disputed";
      cached.disputeReason = reason;
      persistInvoice(invoiceCache, invoiceId, cached);
    }
    return { invoiceId, status: "disputed", reason, contractId: result };
  },

  async resolveDispute(invoiceId: string, resolution: string): Promise<any> {
    const cid = await this.findInvoiceContractId(invoiceId);
    const result = await ledgerExercise(templateId("Invoice", "Invoice"), cid, "ResolveDispute", { resolution }, [getOperatorPartyId()]);
    const newStatus = resolution === "upheld" ? "pending" : "confirmed";
    const cached = invoiceCache.get(invoiceId);
    if (cached) {
      cached.status = newStatus;
      cached.disputeResolution = resolution;
      persistInvoice(invoiceCache, invoiceId, cached);
    }
    return { invoiceId, status: newStatus, resolution, contractId: result };
  },

  getPaymentNotifications(debtor?: string): any[] {
    if (debtor) return paymentNotifications.filter((n) => n.debtor === debtor);
    return paymentNotifications;
  },

  addPaymentNotification(notification: any): void {
    paymentNotifications.push(notification);
  },
};
